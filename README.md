# Todos 便利贴

日历 + 便利贴的待办清单。日历上选一天或几天，打开后可以像在白板上一样自由摆放便利贴，也可以按日期 / 标签 / 列表整理。

- **零依赖**：服务端只用 Node 内置模块（`node:http`、`node:sqlite`），不需要 `npm install`
- **数据持久化**：存在 SQLite 文件里；多台设备、多个浏览器看到的是同一份数据
- **离线可用**：断网时照常增删改，改动暂存在本机，联网后自动同步
- **可选密码**：设置 `TODOS_PASSWORD` 后需要登录
- **可装到手机主屏幕**（PWA）

## 快速开始

需要 Node.js 22.13 或更高版本。

```bash
npm start                         # 打开 http://localhost:8080
TODOS_PASSWORD=你的密码 npm start  # 带密码保护
npm run dev                       # 改了 server/ 下的代码自动重启
npm test                          # 跑接口测试
```

也可以直接双击 `public/index.html` 打开，这时数据只存在当前浏览器里（不同步）。

## 部署

### Docker Compose（推荐）

```bash
cp .env.example .env      # 至少设置 TODOS_PASSWORD
docker compose up -d --build
```

数据在名为 `todos-data` 的数据卷里，升级时 `git pull && docker compose up -d --build` 即可，数据不受影响。

### Docker

```bash
docker build -t todos .
docker run -d --name todos -p 8080:8080 \
  -e TODOS_PASSWORD=你的密码 \
  -v todos-data:/data \
  --restart unless-stopped todos
```

### 直接用 Node 运行

```bash
PORT=8080 DATA_DIR=/var/lib/todos TODOS_PASSWORD=你的密码 node --disable-warning=ExperimentalWarning server/server.js
```

可以用 systemd / pm2 守护进程。

### 反向代理与 HTTPS

公网部署请放在 Caddy / Nginx 后面并启用 HTTPS，同时设置 `TRUST_PROXY=1`。Caddy 示例：

```
todos.example.com {
  reverse_proxy 127.0.0.1:8080
}
```

所有页面和接口都用相对路径，挂在子路径下（如 `example.com/todos/`）也能用，代理时把前缀去掉即可。

## 配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DATA_DIR` | `./data` | 数据目录，数据库文件是其中的 `todos.db` |
| `TODOS_PASSWORD` | 空 | 访问密码；**不设则任何能访问地址的人都能读写** |
| `SESSION_SECRET` | 自动生成 | 登录会话签名密钥，不设则首次启动生成并存进数据库 |
| `TRUST_PROXY` | `0` | 在反向代理后面时设为 `1` |
| `COOKIE_SECURE` | 自动 | 强制开关 Cookie 的 `Secure` 标记 |

登录会话有效期 30 天；修改密码后所有旧会话立即失效。同一 IP 10 分钟内输错 10 次密码会被暂时拒绝。

## 备份与恢复

- **导出**：日历页左下角“导出备份”，或 `GET /api/export`，得到一个 JSON 文件
- **整库备份**：数据库开启了 WAL，热备份请用 SQLite 自带的方式：

  ```bash
  docker compose exec todos node -e "new (require('node:sqlite').DatabaseSync)('/data/todos.db').exec(\"VACUUM INTO '/data/backup.db'\")"
  ```

- **恢复**：停掉服务，把备份文件放回数据目录命名为 `todos.db`，再启动

## 项目结构

```
public/                 前端（纯静态，无构建步骤）
  index.html            日历
  board.html            便利贴：自由贴 / 整理
  login.html            登录
  css/style.css
  js/store.js           数据层：本机缓存 + 待同步队列 + 与服务器同步
  js/calendar.js        日历页交互
  js/board.js           便利贴页交互
  js/login.js
  sw.js                 Service Worker：网络优先、断网用缓存
  manifest.webmanifest  PWA
  icons/
server/
  server.js             入口：读环境变量、启动服务、优雅退出
  app.js                路由、静态文件、接口、数据校验
  db.js                 SQLite 读写
  auth.js               密码登录与会话
test/api.test.js        接口测试（node --test）
Dockerfile / docker-compose.yml / .env.example
```

## 数据同步是怎么做的

- 每条便利贴带 `updatedAt`（毫秒时间戳），服务器对同一 id **以更新的为准**
- 删除记作“墓碑”，所以另一台设备上的旧版本不会把删掉的条目又写回来；撤销删除会生成更新的版本，可以正常恢复
- 前端所有操作先改本机（页面立刻响应），再进入待同步队列（存在 localStorage，刷新、关页、断网都不丢），后台批量 `POST /api/sync`
- 打开页面、切回页面、网络恢复时从服务器拉取最新数据，再叠加本机还没同步的改动
- 某个浏览器第一次连上服务器时，会把它以前只存在本机的数据并进去

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/session` | `{ auth, ok }`：是否需要登录、是否已登录 |
| POST | `/api/login` | `{ password }` |
| POST | `/api/logout` | |
| GET | `/api/todos` | `{ todos, rev, fresh }` |
| POST | `/api/sync` | `{ upsert: [条目], remove: [{ id, updatedAt }] }` |
| GET | `/api/export` | 下载全部数据 |

写接口只接受 `Content-Type: application/json`，配合 `SameSite=Lax` 的 Cookie 防止跨站提交。
