// JSON 接口（Node 和 Workers 共用，只用 Web 标准的 Request / Response）
//   GET  /api/health            健康检查
//   GET  /api/session           { auth: 是否需要登录, ok: 当前是否已登录, setup: 是否还没设置密码 }
//   POST /api/login {password}  登录，写入会话 Cookie
//   POST /api/logout
//   GET  /api/todos             { todos, rev, fresh }
//   POST /api/sync {upsert, remove}  批量写入（同一 id 以 updatedAt 新者为准）
//   GET  /api/export            下载全部数据（JSON）

export const SECURITY_HEADERS = {
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
const FAIL_WINDOW = 10 * 60 * 1000; // 登录限流：每个 IP 10 分钟内最多输错 10 次
const FAIL_LIMIT = 10;

export class HttpError extends Error {
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
const DUE = /^\d{4}-\d{2}-\d{2}(T([01]\d|2[0-3]):[0-5]\d)?$/; // 截止：可以只有日期
const HM = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/; // 当天的开始 / 结束时刻，结束可以是 24:00

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
  if (t.start && (!HM.test(t.start) || t.start === '24:00')) throw new HttpError(400, 'start 不合法');
  if (t.end && !HM.test(t.end)) throw new HttpError(400, 'end 不合法');
  if (!isNum(t.updatedAt)) throw new HttpError(400, 'updatedAt 不合法');
  const out = {
    id: t.id,
    date: t.date,
    content: t.content,
    tag: t.tag || '',
    due: t.due || '',
    start: t.start || '',
    end: t.start && t.end > t.start ? t.end : '', // 没有开始就没有结束；结束要晚于开始
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
export function json(status, body, headers = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: {
      ...SECURITY_HEADERS,
      'Cache-Control': 'no-store',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json; charset=utf-8' }),
      ...headers,
    },
  });
}

async function readJson(request) {
  if (!/^application\/json\b/.test(request.headers.get('content-type') || '')) throw new HttpError(415, '需要 application/json');
  if (Number(request.headers.get('content-length')) > MAX_BODY) throw new HttpError(413, '请求太大');
  const chunks = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) {
        reader.cancel().catch(() => {});
        throw new HttpError(413, '请求太大');
      }
      chunks.push(value);
    }
  }
  const buf = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    buf.set(c, at);
    at += c.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(buf) || '{}');
  } catch {
    throw new HttpError(400, 'JSON 解析失败');
  }
}

// ───── 路由 ─────
async function route(request, { db, auth, ip }) {
  const path = new URL(request.url).pathname;
  const m = request.method;

  if (path === '/api/health' && m === 'GET') return json(200, { ok: true });
  if (path === '/api/session' && m === 'GET') {
    return json(200, { auth: auth.enabled, ok: await auth.check(request), setup: auth.needsSetup || undefined });
  }
  if (path === '/api/login' && m === 'POST') {
    const { password } = await readJson(request);
    if (!auth.enabled) return json(204);
    if (auth.needsSetup) throw new HttpError(503, '还没有设置访问密码');
    const now = Date.now();
    const f = await db.fails(ip);
    const live = f && f.until > now ? f : null;
    if (live && live.n >= FAIL_LIMIT) throw new HttpError(429, '尝试太多次了，过一会儿再试');
    if (await auth.verify(String(password ?? ''))) {
      if (f) await db.clearFails(ip);
      return json(204, undefined, { 'Set-Cookie': await auth.issue(request) });
    }
    await db.setFails(ip, live ? live.n + 1 : 1, live ? live.until : now + FAIL_WINDOW);
    throw new HttpError(401, '密码不对');
  }
  if (path === '/api/logout' && m === 'POST') return json(204, undefined, { 'Set-Cookie': auth.clear() });

  if (!(await auth.check(request))) {
    if (auth.needsSetup) throw new HttpError(503, '还没有设置访问密码');
    throw new HttpError(401, '需要登录');
  }

  if (path === '/api/todos' && m === 'GET') return json(200, { todos: await db.list(), ...(await db.state()) });
  if (path === '/api/sync' && m === 'POST') {
    const body = await readJson(request);
    const upsert = Array.isArray(body.upsert) ? body.upsert : [];
    const remove = Array.isArray(body.remove) ? body.remove : [];
    if (upsert.length + remove.length > MAX_BATCH) throw new HttpError(413, '一次改动太多');
    const applied = await db.apply({ upsert: upsert.map(cleanTodo), remove: remove.map(cleanRemove) });
    return json(200, { applied, ...(await db.state()) });
  }
  if (path === '/api/export' && m === 'GET') {
    const day = new Date().toISOString().slice(0, 10);
    return json(200, { exportedAt: new Date().toISOString(), todos: await db.list() }, {
      'Content-Disposition': `attachment; filename="todos-${day}.json"`,
    });
  }
  throw new HttpError(404, '没有这个接口');
}

export async function handleApi(request, ctx) {
  try {
    return await route(request, ctx);
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.message });
    (ctx.log || console).error(e);
    return json(500, { error: '服务器出错了' });
  }
}

// 页面是否需要先登录（login.html 本身和静态资源不需要）
export const needsLogin = (pathname) => pathname.endsWith('.html') && !pathname.endsWith('/login.html');
export const loginRedirect = (url) => {
  const next = encodeURIComponent((url.pathname + url.search).replace(/^\/+/, ''));
  return new Response(null, { status: 302, headers: { Location: `login.html?next=${next}`, 'Cache-Control': 'no-store' } });
};
