// 测试用的替身：用 node:sqlite 模拟 Cloudflare D1，用本地文件模拟静态资源绑定
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { join, normalize, sep, extname } from 'node:path';

export function fakeD1(file) {
  const db = new DatabaseSync(file);
  const isRead = (sql) => /^\s*select/i.test(sql);
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    async all() { return { success: true, results: db.prepare(sql).all(...args), meta: { changes: 0 } }; },
    async first() { return db.prepare(sql).get(...args) ?? null; },
    async run() { return { success: true, results: [], meta: { changes: Number(db.prepare(sql).run(...args).changes) } }; },
    exec() {
      const p = db.prepare(sql);
      return isRead(sql) ? { success: true, results: p.all(...args), meta: { changes: 0 } } : { success: true, results: [], meta: { changes: Number(p.run(...args).changes) } };
    },
  });
  return {
    prepare: (sql) => stmt(sql),
    // 和 D1 一样：一批语句是一个事务，任何一条失败整批回滚
    async batch(list) {
      db.exec('BEGIN');
      try {
        const out = list.map((s) => s.exec());
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    close: () => db.close(),
  };
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };

export function fakeAssets(dir) {
  const root = normalize(dir + sep);
  return {
    async fetch(req) {
      const file = normalize(join(root, decodeURIComponent(new URL(req.url).pathname)));
      if (!file.startsWith(root)) return new Response('Not Found', { status: 404 });
      try {
        return new Response(await readFile(file), { headers: { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', ETag: '"x"' } });
      } catch {
        return new Response('Not Found', { status: 404 });
      }
    },
  };
}
