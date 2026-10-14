// 表结构和 SQL：Node（node:sqlite）和 Cloudflare D1 共用同一份
// 每条便利贴整体存成 JSON；date 单独成列方便按日期查。
// 删除记作墓碑（deleted=1）。写入时只有 updatedAt 不比库里旧才生效（"新的为准"），判断放在 SQL 里，不用先读再写。

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS todos (
    id TEXT PRIMARY KEY, date TEXT NOT NULL, data TEXT NOT NULL,
    updated_at INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0)`,
  'CREATE INDEX IF NOT EXISTS todos_date ON todos(date)',
  'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS login_fails (ip TEXT PRIMARY KEY, n INTEGER NOT NULL, until INTEGER NOT NULL)',
];

export const SQL = {
  list: 'SELECT data FROM todos WHERE deleted = 0 ORDER BY date, updated_at',
  state: 'SELECT COALESCE(MAX(updated_at), 0) AS rev, COUNT(*) AS n FROM todos',
  put: `INSERT INTO todos (id, date, data, updated_at, deleted) VALUES (?, ?, ?, ?, 0)
    ON CONFLICT(id) DO UPDATE SET date = excluded.date, data = excluded.data, updated_at = excluded.updated_at, deleted = 0
    WHERE excluded.updated_at >= todos.updated_at`,
  del: `INSERT INTO todos (id, date, data, updated_at, deleted) VALUES (?, '', '{}', ?, 1)
    ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, deleted = 1
    WHERE excluded.updated_at >= todos.updated_at`,
  getMeta: 'SELECT value FROM meta WHERE key = ?',
  // 只在还没有时写入：多个进程 / Worker 实例同时首次启动也只会留下同一个值
  initMeta: 'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING',
  getFails: 'SELECT n, until FROM login_fails WHERE ip = ?',
  setFails: 'INSERT INTO login_fails (ip, n, until) VALUES (?, ?, ?) ON CONFLICT(ip) DO UPDATE SET n = excluded.n, until = excluded.until',
  clearFails: 'DELETE FROM login_fails WHERE ip = ?',
  pruneFails: 'DELETE FROM login_fails WHERE until < ?',
};
