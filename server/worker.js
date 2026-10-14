// Cloudflare Workers 入口：/api/ 走 api.js（数据在 D1），其它请求交给静态资源（public/）
// 环境变量 / 密钥：
//   TODOS_PASSWORD  访问密码（用 `wrangler secret put TODOS_PASSWORD` 设置）
//   ALLOW_OPEN=1    不设密码也允许访问（默认不允许：workers.dev 是公网地址）
//   SESSION_SECRET  会话签名密钥；不设则首次请求时生成并存进 D1
//   COOKIE_SECURE   1/0 强制开关 Cookie 的 Secure；默认按请求是否 HTTPS 判断
import { SECURITY_HEADERS, handleApi, needsLogin, loginRedirect } from './api.js';
import { createAuth, loadSecret } from './auth.js';
import { openD1 } from './d1.js';

const flag = (v) => (v === undefined || v === '' ? undefined : /^(1|true|yes)$/i.test(v));

// 同一个 Worker 实例里复用数据库和登录配置；密码改了（重新部署）就重建
let cached = null;
async function setup(env) {
  const key = `${env.TODOS_PASSWORD || ''}\n${env.ALLOW_OPEN || ''}\n${env.SESSION_SECRET || ''}`;
  if (cached?.key === key && cached.binding === env.DB) return cached;
  const db = openD1(env.DB);
  const secret = await loadSecret(db, env.SESSION_SECRET);
  const auth = await createAuth({
    password: env.TODOS_PASSWORD || '',
    secret,
    secureCookie: flag(env.COOKIE_SECURE),
    locked: !env.TODOS_PASSWORD && !flag(env.ALLOW_OPEN),
  });
  cached = { key, binding: env.DB, db, auth };
  return cached;
}

function withHeaders(res, extra = {}) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries({ ...SECURITY_HEADERS, ...extra })) out.headers.set(k, v);
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { db, auth } = await setup(env);

    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, { db, auth, ip: request.headers.get('cf-connecting-ip') || '' });
    }

    let path = url.pathname;
    if (path.endsWith('/')) path += 'index.html';
    if (path === '/favicon.ico') path = '/icons/icon-180.png';
    if (needsLogin(path) && !(await auth.check(request))) return loginRedirect(url);

    const asset = await env.ASSETS.fetch(new Request(new URL(path + url.search, url), request));
    // 和 Node 版一样每次都确认是否有新版本（有 ETag，没变化时很便宜）
    return withHeaders(asset, asset.ok ? { 'Cache-Control': 'no-cache' } : {});
  },
};
