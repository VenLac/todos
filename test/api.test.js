// 接口测试：node --test test/
// 同一套接口用例分别跑在 Node 服务器和 Cloudflare Worker（D1 用 node:sqlite 模拟）上。
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSqlite } from '../server/sqlite.js';
import { createAuth } from '../server/auth.js';
import { createApp } from '../server/app.js';
import worker from '../server/worker.js';
import { fakeD1, fakeAssets } from './helpers.js';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const quiet = { error() {} };
const tmp = () => mkdtempSync(join(tmpdir(), 'todos-test-'));

// 两种后端，对外都是 req(path, init) => Response
const BACKENDS = {
  async node(password = '') {
    const dir = tmp();
    const db = openSqlite(join(dir, 'todos.db'));
    const auth = await createAuth({ password, secret: 'test-secret' });
    const server = createServer(createApp({ db, auth, publicDir, log: quiet }));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    return {
      req: (path, init = {}) => fetch(base + path, { redirect: 'manual', ...init }),
      async close() {
        await new Promise((r) => server.close(r));
        db.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  },
  async worker(password = '', extraEnv = { ALLOW_OPEN: password ? '' : '1' }) {
    const dir = tmp();
    const d1 = fakeD1(join(dir, 'd1.sqlite'));
    const env = { DB: d1, ASSETS: fakeAssets(publicDir), TODOS_PASSWORD: password, ...extraEnv };
    return {
      req: (path, init = {}) => worker.fetch(new Request(`https://todos.test${path}`, init), env),
      async close() {
        d1.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  },
};

const todo = (id, extra = {}) => ({ id, date: '2026-10-14', content: `内容 ${id}`, tag: '工作', due: '', done: false, createdAt: 1, updatedAt: 100, ...extra });

for (const [name, boot] of Object.entries(BACKENDS)) {
  describe(`接口（${name}）`, () => {
    let s;
    const post = (path, body, headers = {}) => s.req(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const list = async () => (await (await s.req('/api/todos')).json()).todos;
    before(async () => { s = await boot(); });
    after(async () => { await s.close(); });

    test('健康检查', async () => {
      const r = await s.req('/api/health');
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), { ok: true });
    });

    test('首次部署：库是空的', async () => {
      const r = await (await s.req('/api/todos')).json();
      assert.deepEqual(r.todos, []);
      assert.equal(r.fresh, true);
    });

    test('写入、读取，并去掉未知字段', async () => {
      const r = await post('/api/sync', { upsert: [todo('a1', { pos: { d: { x: 10.4, y: 20 } }, z: 3, hack: '<script>' })] });
      assert.equal(r.status, 200);
      assert.equal((await r.json()).applied, 1);
      const { todos, fresh } = await (await s.req('/api/todos')).json();
      assert.equal(fresh, false);
      assert.equal(todos.length, 1);
      assert.deepEqual(todos[0].pos, { d: { x: 10, y: 20 } });
      assert.equal(todos[0].z, 3);
      assert.equal('hack' in todos[0], false);
    });

    test('同一条以 updatedAt 新者为准', async () => {
      await post('/api/sync', { upsert: [todo('a1', { content: '新的', updatedAt: 200 })] });
      const stale = await (await post('/api/sync', { upsert: [todo('a1', { content: '旧的', updatedAt: 150 })] })).json();
      assert.equal(stale.applied, 0);
      assert.equal((await list()).find((t) => t.id === 'a1').content, '新的');
    });

    test('删除是墓碑：旧版本不会被写回来，撤销（更新的版本）可以恢复', async () => {
      await post('/api/sync', { remove: [{ id: 'a1', updatedAt: 300 }] });
      await post('/api/sync', { upsert: [todo('a1', { updatedAt: 250 })] });
      assert.equal((await list()).some((t) => t.id === 'a1'), false);
      await post('/api/sync', { upsert: [todo('a1', { content: '撤销回来', updatedAt: 400 })] });
      assert.equal((await list()).find((t) => t.id === 'a1').content, '撤销回来');
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
      for (const body of bad) assert.equal((await post('/api/sync', body)).status, 400, JSON.stringify(body));
      assert.equal((await list()).some((t) => t.id === 'ok1'), false);
    });

    test('大批量写入（超过 D1 一批的条数）全部生效', async () => {
      const many = Array.from({ length: 250 }, (_, i) => todo(`m${i}`, { updatedAt: 500 }));
      const r = await (await post('/api/sync', { upsert: many })).json();
      assert.equal(r.applied, 250);
      assert.equal((await list()).filter((t) => t.id.startsWith('m')).length, 250);
    });

    test('写接口只收 JSON，且有大小限制', async () => {
      const r = await s.req('/api/sync', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
      assert.equal(r.status, 415);
      const big = await post('/api/sync', { upsert: Array.from({ length: 3000 }, (_, i) => todo(`b${i}`)) });
      assert.equal(big.status, 413);
    });

    test('导出备份', async () => {
      const r = await s.req('/api/export');
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-disposition'), /attachment; filename="todos-\d{4}-\d{2}-\d{2}\.json"/);
      assert.ok(Array.isArray((await r.json()).todos));
    });

    test('页面带安全头，且每次都确认新版本', async () => {
      const r = await s.req('/');
      assert.equal(r.status, 200);
      assert.match(r.headers.get('content-type'), /text\/html/);
      assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(r.headers.get('cache-control'), 'no-cache');
      assert.match(await r.text(), /<title>/);
      assert.equal((await s.req('/board.html?d=2026-10-14')).status, 200);
      assert.equal((await s.req('/favicon.ico')).headers.get('content-type'), 'image/png');
      assert.equal((await s.req('/nope.html')).status, 404);
      assert.equal((await s.req('/api/nope')).status, 404);
    });

    test('密码保护：未登录拦截、登录、限流、退出', async () => {
      const p = await boot('秘密口令');
      const ppost = (path, body, headers = {}) => p.req(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
      try {
        assert.equal((await p.req('/api/todos')).status, 401);
        assert.equal((await p.req('/api/health')).status, 200);
        assert.equal((await (await p.req('/api/session')).json()).ok, false);

        const page = await p.req('/board.html?d=2026-10-14');
        assert.equal(page.status, 302);
        assert.equal(page.headers.get('location'), 'login.html?next=board.html%3Fd%3D2026-10-14');
        assert.equal((await p.req('/login.html')).status, 200);
        assert.equal((await p.req('/css/style.css')).status, 200);

        assert.equal((await ppost('/api/login', { password: '不对' })).status, 401);
        const ok = await ppost('/api/login', { password: '秘密口令' });
        assert.equal(ok.status, 204);
        const cookie = ok.headers.get('set-cookie');
        assert.match(cookie, /HttpOnly/);
        assert.match(cookie, /SameSite=Lax/);
        if (name === 'worker') assert.match(cookie, /Secure/); // https 下带 Secure
        const sid = cookie.split(';')[0];

        assert.equal((await p.req('/api/todos', { headers: { Cookie: sid } })).status, 200);
        assert.equal((await p.req('/', { headers: { Cookie: sid } })).status, 200);
        const forged = sid.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
        assert.equal((await p.req('/api/todos', { headers: { Cookie: forged } })).status, 401);

        // 成功登录会清零；之后连续输错 10 次，第 11 次起（哪怕密码对）都被限流
        for (let i = 0; i < 10; i++) assert.equal((await ppost('/api/login', { password: `wrong${i}` })).status, 401);
        assert.equal((await ppost('/api/login', { password: '秘密口令' })).status, 429);

        const out = await ppost('/api/logout', {});
        assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
      } finally {
        await p.close();
      }
    });
  });
}

describe('Node 静态文件', () => {
  let s;
  before(async () => { s = await BACKENDS.node(); });
  after(async () => { await s.close(); });

  test('gzip 与 ETag 304', async () => {
    const css = await s.req('/css/style.css', { headers: { 'Accept-Encoding': 'gzip' } });
    assert.equal(css.headers.get('content-encoding'), 'gzip');
    const again = await s.req('/css/style.css', { headers: { 'If-None-Match': css.headers.get('etag') } });
    assert.equal(again.status, 304);
  });

  test('不能越出 public 目录', async () => {
    for (const p of ['/../server/api.js', '/%2e%2e/server/api.js', '/..%2fpackage.json', '/js/../../package.json']) {
      const r = await s.req(p);
      assert.ok([403, 404].includes(r.status), `${p} -> ${r.status}`);
    }
  });
});

describe('Worker 没设密码时锁住', () => {
  let s;
  before(async () => { s = await BACKENDS.worker('', {}); });
  after(async () => { await s.close(); });

  test('数据接口不开放，页面跳去登录页提示设置密码', async () => {
    assert.deepEqual(await (await s.req('/api/session')).json(), { auth: true, ok: false, setup: true });
    assert.equal((await s.req('/api/todos')).status, 503);
    assert.equal((await s.req('/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 503);
    assert.equal((await s.req('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"password":""}' })).status, 503);
    assert.equal((await s.req('/')).status, 302);
    assert.equal((await s.req('/login.html')).status, 200);
    assert.equal((await s.req('/api/health')).status, 200);
  });
});

test('换了密码，旧会话失效', async () => {
  const a = await createAuth({ password: 'one', secret: 's' });
  const b = await createAuth({ password: 'two', secret: 's' });
  const req = (cookie) => new Request('http://x/', { headers: cookie ? { cookie } : {} });
  const sid = (await a.issue(req())).split(';')[0];
  assert.equal(await a.check(req(sid)), true);
  assert.equal(await b.check(req(sid)), false);
});
