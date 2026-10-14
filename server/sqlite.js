// Node 用的数据层：node:sqlite（无需依赖）。接口全部是 async，和 D1 版保持一致。
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA, SQL } from './schema.js';

export function openSqlite(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 3000;');
  for (const s of SCHEMA) db.exec(s);
  const st = Object.fromEntries(Object.entries(SQL).map(([k, s]) => [k, db.prepare(s)]));

  return {
    async list() {
      return st.list.all().map((r) => JSON.parse(r.data));
    },
    async state() {
      const { rev, n } = st.state.get();
      return { rev: Number(rev), fresh: Number(n) === 0 };
    },
    async apply({ upsert = [], remove = [] }) {
      let applied = 0;
      db.exec('BEGIN');
      try {
        for (const t of upsert) applied += Number(st.put.run(t.id, t.date, JSON.stringify(t), t.updatedAt).changes);
        for (const r of remove) applied += Number(st.del.run(r.id, r.updatedAt).changes);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      return applied;
    },
    async initMeta(key, value) {
      st.initMeta.run(key, value);
      return st.getMeta.get(key).value;
    },
    async fails(ip) {
      return st.getFails.get(ip) || null;
    },
    async setFails(ip, n, until) {
      st.pruneFails.run(Date.now());
      st.setFails.run(ip, n, until);
    },
    async clearFails(ip) {
      st.clearFails.run(ip);
    },
    close() {
      db.close();
    },
  };
}
