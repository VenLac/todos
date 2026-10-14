// Node 版 HTTP 处理：静态页面 + 把 /api/ 请求转成 Web 标准的 Request 交给 api.js
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { SECURITY_HEADERS, handleApi, json, needsLogin, loginRedirect } from './api.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};
const TEXT = /^(text\/|application\/(json|manifest)|image\/svg)/;

const clientIp = (req, trustProxy) =>
  (trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '';

function toRequest(req, withBody) {
  const url = `http://${req.headers.host || 'localhost'}${req.url || '/'}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  const init = { method: req.method, headers };
  if (withBody && req.method !== 'GET' && req.method !== 'HEAD') Object.assign(init, { body: Readable.toWeb(req), duplex: 'half' });
  return new Request(url, init);
}

async function sendResponse(res, response) {
  const headers = {};
  response.headers.forEach((v, k) => { headers[k] = v; });
  const body = response.body ? Buffer.from(await response.arrayBuffer()) : null;
  if (body) headers['content-length'] = body.length;
  res.writeHead(response.status, headers);
  res.end(body);
}

export function createApp({ db, auth, publicDir, trustProxy = false, log = console }) {
  const root = normalize(publicDir + sep);
  const gzCache = new Map(); // path -> { mtime, buf }

  async function staticFile(req, res, path) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendResponse(res, json(405, { error: '不支持的方法' }, { Allow: 'GET, HEAD' }));
    let rel;
    try {
      rel = decodeURIComponent(path);
    } catch {
      return sendResponse(res, json(400, { error: '路径不合法' }));
    }
    if (rel.endsWith('/')) rel += 'index.html';
    if (rel === '/favicon.ico') rel = '/icons/icon-180.png';
    const file = normalize(join(root, rel));
    if (!file.startsWith(root) || rel.includes('\0')) return sendResponse(res, json(403, { error: '禁止访问' }));

    // 设了密码时，未登录访问页面先去登录页
    if (needsLogin(rel) && !(await auth.check(toRequest(req, false)))) {
      return sendResponse(res, loginRedirect(new URL(req.url || '/', 'http://x')));
    }

    let st;
    try {
      st = await stat(file);
      if (!st.isFile()) throw new Error('not a file');
    } catch {
      return sendResponse(res, json(404, { error: '找不到页面' }));
    }
    const type = TYPES[extname(file).toLowerCase()];
    if (!type) return sendResponse(res, json(403, { error: '禁止访问' }));

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
      if (path.startsWith('/api/')) {
        await sendResponse(res, await handleApi(toRequest(req, true), { db, auth, ip: clientIp(req, trustProxy), log }));
      } else {
        await staticFile(req, res, path);
      }
    } catch (e) {
      log.error(e);
      if (!res.headersSent) sendResponse(res, json(500, { error: '服务器出错了' }));
      else res.destroy();
    }
  };
}
