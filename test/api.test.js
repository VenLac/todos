// 接口测试：node --test test/
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/db.js';
import { createAuth } from '../server/auth.js';
import { createApp } from '../server/app.js';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const quiet = { error() {} };

async function boot(password = '') {
  const dir = mkdtempSync(join(tmpdir(), 'todos-test-'));
  const db = openDb(join(dir, 'todos.db'));
  const auth = createAuth({ password, secret: 'test-secret' });
  const server = createServer(createApp({ db, auth, publicDir, log: quiet }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    req: (path, opts = {}) => fetch(base + path, { redirect: 'manual', ...opts }),
    json: (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }),
    async close() {
      await new Promise((r) => server.close(r));
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const todo = (id, extra = {}) => ({ id, date: '2026-10-14', content: `内容 ${id}`, tag: '工作', due: '', done: false, createdAt: 1, updatedAt: 100, ...extra });

// ───── 不设密码 ─────
let open;
before(async () => { open = await boot(); });
after(async () => { await open.close(); });

test('健康检查', async () => {
  const r = await open.req('/api/health');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
});

test('首次部署：库是空的', async () => {
  const r = await (await open.req('/api/todos')).json();
  assert.deepEqual(r.todos, []);
  assert.equal(r.fresh, true);
});

test('写入、读取，并去掉未知字段', async () => {
  const r = await open.json('/api/sync', { upsert: [todo('a1', { pos: { d: { x: 10.4, y: 20 } }, z: 3, hack: '<script>' })] });
  assert.equal(r.status, 200);
  const { todos, fresh } = await (await open.req('/api/todos')).json();
  assert.equal(fresh, false);
  assert.equal(todos.length, 1);
  assert.deepEqual(todos[0].pos, { d: { x: 10, y: 20 } });
  assert.equal(todos[0].z, 3);
  assert.equal('hack' in todos[0], false);
});

test('同一条以 updatedAt 新者为准', async () => {
  await open.json('/api/sync', { upsert: [todo('a1', { content: '新的', updatedAt: 200 })] });
  await open.json('/api/sync', { upsert: [todo('a1', { content: '旧的', updatedAt: 150 })] });
  const { todos } = await (await open.req('/api/todos')).json();
  assert.equal(todos.find((t) => t.id === 'a1').content, '新的');
});

test('删除是墓碑：旧版本不会被写回来，撤销（更新的版本）可以恢复', async () => {
  await open.json('/api/sync', { remove: [{ id: 'a1', updatedAt: 300 }] });
  await open.json('/api/sync', { upsert: [todo('a1', { updatedAt: 250 })] });
  let { todos } = await (await open.req('/api/todos')).json();
  assert.equal(todos.some((t) => t.id === 'a1'), false);
  await open.json('/api/sync', { upsert: [todo('a1', { content: '撤销回来', updatedAt: 400 })] });
  ({ todos } = await (await open.req('/api/todos')).json());
  assert.equal(todos.find((t) => t.id === 'a1').content, '撤销回来');
});

test('校验：坏数据整批拒收，不写入任何一条', async () => {
  const bad = [
    { upsert: [todo('ok1'), todo('bad id!')] },
    { upsert: [todo('x', { date: '2026/10/14' })] },
    { upsert: [todo('x', { content: '   ' })] },
    { upsert: [todo('x', { due: 'tomorrow' })] },
    { upsert: [todo('x', { updatedAt: 'now' })] },
    { remove: [{ id: 'x' }] },
  ];
  for (const body of bad) assert.equal((await open.json('/api/sync', body)).status, 400, JSON.stringify(body));
  const { todos } = await (await open.req('/api/todos')).json();
  assert.equal(todos.some((t) => t.id === 'ok1'), false);
});

test('写接口只收 JSON，且有大小限制', async () => {
  const r = await open.req('/api/sync', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(r.status, 415);
  const big = await open.json('/api/sync', { upsert: Array.from({ length: 3000 }, (_, i) => todo(`b${i}`)) });
  assert.equal(big.status, 413);
});

test('导出备份', async () => {
  const r = await open.req('/api/export');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="todos-\d{4}-\d{2}-\d{2}\.json"/);
  assert.ok(Array.isArray((await r.json()).todos));
});

test('静态页面：首页、gzip、ETag 304、安全头', async () => {
  const r = await open.req('/', { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.match(await r.text(), /<title>/);
  const css = await open.req('/css/style.css', { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(css.headers.get('content-encoding'), 'gzip');
  const etag = css.headers.get('etag');
  const again = await open.req('/css/style.css', { headers: { 'If-None-Match': etag } });
  assert.equal(again.status, 304);
});

test('静态页面：不能越出 public 目录，不认识的文件类型不给', async () => {
  for (const p of ['/../server/db.js', '/%2e%2e/server/db.js', '/..%2fpackage.json', '/js/../../package.json']) {
    const r = await open.req(p);
    assert.ok([403, 404].includes(r.status), `${p} -> ${r.status}`);
  }
  assert.equal((await open.req('/nope.html')).status, 404);
  assert.equal((await open.req('/api/nope')).status, 404);
});

// ───── 设了密码 ─────
test('密码保护：未登录拦截、登录、限流、退出', async () => {
  const s = await boot('秘密口令');
  try {
    assert.equal((await s.req('/api/todos')).status, 401);
    assert.equal((await s.req('/api/health')).status, 200);
    assert.deepEqual(await (await s.req('/api/session')).json(), { auth: true, ok: false });

    const page = await s.req('/board.html?d=2026-10-14');
    assert.equal(page.status, 302);
    assert.equal(page.headers.get('location'), 'login.html?next=board.html%3Fd%3D2026-10-14');
    assert.equal((await s.req('/login.html')).status, 200);
    assert.equal((await s.req('/css/style.css')).status, 200);

    assert.equal((await s.json('/api/login', { password: '不对' })).status, 401);
    const ok = await s.json('/api/login', { password: '秘密口令' });
    assert.equal(ok.status, 204);
    const cookie = ok.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    const sid = cookie.split(';')[0];

    assert.equal((await s.req('/api/todos', { headers: { Cookie: sid } })).status, 200);
    assert.equal((await s.req('/', { headers: { Cookie: sid } })).status, 200);
    assert.equal((await s.req('/api/todos', { headers: { Cookie: sid.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')) } })).status, 401);

    // 成功登录会清零；之后连续输错 10 次，第 11 次起（哪怕密码对）都被限流
    for (let i = 0; i < 10; i++) assert.equal((await s.json('/api/login', { password: `wrong${i}` })).status, 401);
    assert.equal((await s.json('/api/login', { password: '秘密口令' })).status, 429);

    const out = await s.json('/api/logout', {});
    assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  } finally {
    await s.close();
  }
});

test('换了密码，旧会话失效', async () => {
  const a = createAuth({ password: 'one', secret: 's' });
  const b = createAuth({ password: 'two', secret: 's' });
  const fakeReq = (cookie) => ({ headers: { cookie }, socket: {} });
  const sid = a.issue(fakeReq('')).split(';')[0];
  assert.equal(a.check(fakeReq(sid)), true);
  assert.equal(b.check(fakeReq(sid)), false);
});
