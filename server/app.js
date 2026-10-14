// HTTP 处理：静态页面 + JSON 接口
//   GET  /api/health            健康检查
//   GET  /api/session           { auth: 是否需要登录, ok: 当前是否已登录 }
//   POST /api/login {password}  登录，写入会话 Cookie
//   POST /api/logout
//   GET  /api/todos             { todos, rev, fresh }
//   POST /api/sync {upsert, remove}  批量写入（同一 id 以 updatedAt 新者为准）
//   GET  /api/export            下载全部数据（JSON）
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};
const TEXT = /^(text\/|application\/(json|manifest)|image\/svg)/;

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
};

const MAX_BODY = 1024 * 1024;
const MAX_BATCH = 2000;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ───── 数据校验：只保留认识的字段，防止脏数据进库 ─────
const isStr = (v, max) => typeof v === 'string' && v.length <= max;
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DUE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

function cleanPos(p) {
  if (!p || typeof p !== 'object') return undefined;
  const out = {};
  for (const k of ['d', 'm']) {
    const v = p[k];
    if (v && isNum(v.x) && isNum(v.y)) out[k] = { x: Math.round(v.x), y: Math.round(v.y) };
  }
  return Object.keys(out).length ? out : undefined;
}

export function cleanTodo(t) {
  if (!t || typeof t !== 'object') throw new HttpError(400, '条目格式不对');
  if (!ID.test(t.id ?? '')) throw new HttpError(400, 'id 不合法');
  if (!DATE.test(t.date ?? '')) throw new HttpError(400, 'date 不合法');
  if (!isStr(t.content, 2000) || !t.content.trim()) throw new HttpError(400, 'content 不合法');
  if (t.tag !== undefined && !isStr(t.tag, 40)) throw new HttpError(400, 'tag 不合法');
  if (t.due && !DUE.test(t.due)) throw new HttpError(400, 'due 不合法');
  if (!isNum(t.updatedAt)) throw new HttpError(400, 'updatedAt 不合法');
  const out = {
    id: t.id,
    date: t.date,
    content: t.content,
    tag: t.tag || '',
    due: t.due || '',
    done: Boolean(t.done),
    createdAt: isNum(t.createdAt) ? t.createdAt : t.updatedAt,
    updatedAt: t.updatedAt,
  };
  if (isNum(t.z)) out.z = Math.round(t.z);
  const pos = cleanPos(t.pos);
  if (pos) out.pos = pos;
  return out;
}

function cleanRemove(r) {
  if (!r || !ID.test(r.id ?? '') || !isNum(r.updatedAt)) throw new HttpError(400, '删除项不合法');
  return { id: r.id, updatedAt: r.updatedAt };
}

// ───── 小工具 ─────
function send(res, status, body, headers = {}) {
  const json = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Cache-Control': 'no-store',
    ...(json ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
    ...headers,
  });
  res.end(json);
}

async function readJson(req) {
  if (!/^application\/json\b/.test(req.headers['content-type'] || '')) throw new HttpError(415, '需要 application/json');
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new HttpError(413, '请求太大');
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'JSON 解析失败');
  }
}

const clientIp = (req, trustProxy) =>
  (trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '';

// ───── 应用 ─────
export function createApp({ db, auth, publicDir, trustProxy = false, log = console }) {
  const root = normalize(publicDir + sep);
  const gzCache = new Map(); // path -> { mtime, buf }

  async function api(req, res, path) {
    const m = req.method;
    if (path === '/api/health' && m === 'GET') return send(res, 200, { ok: true });
    if (path === '/api/session' && m === 'GET') return send(res, 200, { auth: auth.enabled, ok: auth.check(req) });
    if (path === '/api/login' && m === 'POST') {
      const { password } = await readJson(req);
      if (!auth.enabled) return send(res, 204);
      const r = auth.attempt(clientIp(req, trustProxy), String(password ?? ''));
      if (r === 'limited') throw new HttpError(429, '尝试太多次了，过一会儿再试');
      if (r !== 'ok') throw new HttpError(401, '密码不对');
      return send(res, 204, undefined, { 'Set-Cookie': auth.issue(req) });
    }
    if (path === '/api/logout' && m === 'POST') return send(res, 204, undefined, { 'Set-Cookie': auth.clear() });

    if (!auth.check(req)) throw new HttpError(401, '需要登录');

    if (path === '/api/todos' && m === 'GET') return send(res, 200, { todos: db.list(), ...db.state() });
    if (path === '/api/sync' && m === 'POST') {
      const body = await readJson(req);
      const upsert = Array.isArray(body.upsert) ? body.upsert : [];
      const remove = Array.isArray(body.remove) ? body.remove : [];
      if (upsert.length + remove.length > MAX_BATCH) throw new HttpError(413, '一次改动太多');
      const applied = db.apply({ upsert: upsert.map(cleanTodo), remove: remove.map(cleanRemove) });
      return send(res, 200, { applied, ...db.state() });
    }
    if (path === '/api/export' && m === 'GET') {
      const day = new Date().toISOString().slice(0, 10);
      return send(res, 200, { exportedAt: new Date().toISOString(), todos: db.list() }, {
        'Content-Disposition': `attachment; filename="todos-${day}.json"`,
      });
    }
    throw new HttpError(404, '没有这个接口');
  }

  async function staticFile(req, res, path) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: '不支持的方法' }, { Allow: 'GET, HEAD' });
    let rel;
    try {
      rel = decodeURIComponent(path);
    } catch {
      return send(res, 400, { error: '路径不合法' });
    }
    if (rel.endsWith('/')) rel += 'index.html';
    if (rel === '/favicon.ico') rel = '/icons/icon-180.png';
    const file = normalize(join(root, rel));
    if (!file.startsWith(root) || rel.includes('\0')) return send(res, 403, { error: '禁止访问' });

    const type = TYPES[extname(file).toLowerCase()];
    // 设了密码时，未登录访问页面先去登录页
    if (type?.startsWith('text/html') && !file.endsWith(`${sep}login.html`) && !auth.check(req)) {
      const next = encodeURIComponent((req.url || '').replace(/^\/+/, ''));
      res.writeHead(302, { Location: `login.html?next=${next}`, 'Cache-Control': 'no-store' });
      return res.end();
    }

    let st;
    try {
      st = await stat(file);
      if (!st.isFile()) throw new Error('not a file');
    } catch {
      return send(res, 404, { error: '找不到页面' });
    }
    if (!type) return send(res, 403, { error: '禁止访问' });

    // 每次都向服务器确认一下（no-cache + ETag），部署新版本后立刻生效，没变则返回 304
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const headers = { ...SECURITY_HEADERS, 'Content-Type': type, 'Cache-Control': 'no-cache', ETag: etag, Vary: 'Accept-Encoding' };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }

    let buf;
    const gzip = TEXT.test(type) && /\bgzip\b/.test(req.headers['accept-encoding'] || '') && st.size > 1024;
    if (gzip) {
      const hit = gzCache.get(file);
      if (hit && hit.mtime === st.mtimeMs) buf = hit.buf;
      else {
        buf = gzipSync(await readFile(file));
        gzCache.set(file, { mtime: st.mtimeMs, buf });
      }
      headers['Content-Encoding'] = 'gzip';
    } else {
      buf = await readFile(file);
    }
    headers['Content-Length'] = buf.length;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : buf);
  }

  return async function handle(req, res) {
    const path = (req.url || '/').split('?')[0];
    try {
      if (path.startsWith('/api/')) await api(req, res, path);
      else await staticFile(req, res, path);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      log.error(e);
      if (!res.headersSent) send(res, 500, { error: '服务器出错了' });
      else res.destroy();
    }
  };
}
