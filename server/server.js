// 入口：读取环境变量，打开数据库，启动 HTTP 服务
//   PORT            监听端口，默认 8080
//   HOST            监听地址，默认 0.0.0.0
//   DATA_DIR        数据目录（SQLite 文件放这里），默认 ./data
//   TODOS_PASSWORD  设置后需要登录才能读写数据（公网部署务必设置）
//   SESSION_SECRET  会话签名密钥；不设则自动生成并存进数据库
//   TRUST_PROXY=1   在反向代理后面时，用 X-Forwarded-For 识别客户端 IP
//   COOKIE_SECURE   1/0 强制开关 Cookie 的 Secure；默认按请求是否 HTTPS 判断
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createAuth, newSecret } from './auth.js';
import { createApp } from './app.js';

const here = dirname(fileURLToPath(import.meta.url));
const env = process.env;
const port = Number(env.PORT) || 8080;
const host = env.HOST || '0.0.0.0';
const dataDir = resolve(env.DATA_DIR || join(here, '..', 'data'));
const flag = (v) => (v === undefined || v === '' ? undefined : /^(1|true|yes)$/i.test(v));

mkdirSync(dataDir, { recursive: true });
const db = openDb(join(dataDir, 'todos.db'));

let secret = env.SESSION_SECRET || db.meta('session_secret');
if (!secret) {
  secret = newSecret();
  db.setMeta('session_secret', secret);
}
const auth = createAuth({ password: env.TODOS_PASSWORD || '', secret, secureCookie: flag(env.COOKIE_SECURE) });

const server = createServer(createApp({
  db,
  auth,
  publicDir: join(here, '..', 'public'),
  trustProxy: flag(env.TRUST_PROXY) ?? false,
}));
server.keepAliveTimeout = 65_000;

server.listen(port, host, () => {
  console.log(`Todos 已启动：http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
  console.log(`数据文件：${join(dataDir, 'todos.db')}`);
  if (!auth.enabled) console.warn('提醒：没有设置 TODOS_PASSWORD，任何能访问这个地址的人都能读写数据。公网部署请务必设置。');
});

function shutdown(sig) {
  console.log(`收到 ${sig}，正在关闭…`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
