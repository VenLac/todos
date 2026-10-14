// SQLite 数据层（Node 内置 node:sqlite，无需任何依赖）
// 每条便利贴整体存成 JSON；date 单独成列方便按日期查。
// 删除记作墓碑（deleted=1），同一 id 以 updatedAt 新者为准，多设备同步不会把删掉的又写回来。
import { DatabaseSync } from 'node:sqlite';

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS todos (
      id         TEXT PRIMARY KEY,
      date       TEXT NOT NULL,
      data       TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted    INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS todos_date ON todos(date);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);

  const q = {
    list: db.prepare('SELECT data FROM todos WHERE deleted = 0 ORDER BY date, updated_at'),
    rev: db.prepare('SELECT COALESCE(MAX(updated_at), 0) AS rev, COUNT(*) AS n FROM todos'),
    stamp: db.prepare('SELECT updated_at FROM todos WHERE id = ?'),
    put: db.prepare(`INSERT INTO todos (id, date, data, updated_at, deleted) VALUES (?, ?, ?, ?, 0)
      ON CONFLICT(id) DO UPDATE SET date = excluded.date, data = excluded.data, updated_at = excluded.updated_at, deleted = 0`),
    del: db.prepare(`INSERT INTO todos (id, date, data, updated_at, deleted) VALUES (?, '', '{}', ?, 1)
      ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, deleted = 1`),
    getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
    setMeta: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
  };

  const newer = (id, at) => {
    const row = q.stamp.get(id);
    return !row || at >= row.updated_at;
  };

  return {
    list: () => q.list.all().map((r) => JSON.parse(r.data)),
    // rev：最近一次改动的时间；fresh：库里从没有过数据（首次部署）
    state() {
      const { rev, n } = q.rev.get();
      return { rev, fresh: n === 0 };
    },
    apply({ upsert = [], remove = [] }) {
      let applied = 0;
      db.exec('BEGIN');
      try {
        for (const t of upsert) if (newer(t.id, t.updatedAt)) { q.put.run(t.id, t.date, JSON.stringify(t), t.updatedAt); applied++; }
        for (const r of remove) if (newer(r.id, r.updatedAt)) { q.del.run(r.id, r.updatedAt); applied++; }
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      return applied;
    },
    meta: (key) => q.getMeta.get(key)?.value,
    setMeta: (key, value) => q.setMeta.run(key, value),
    close: () => db.close(),
  };
}
