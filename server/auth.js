// 可选的密码保护（Node 和 Workers 共用，只用 Web Crypto）
// 会话是签名的 Cookie：过期时间 + HMAC，签名里带上密码指纹，改密码后旧会话自动失效。
// locked：没设密码但又不允许开放时（Workers 默认），一律不放行，提示先设置密码。

const COOKIE = 'todos_session';
const MAX_AGE = 30 * 24 * 3600; // 30 天
const enc = new TextEncoder();

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(String(s))));
// 定长比较，避免按时间猜出内容
function same(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function createAuth({ password = '', secret, secureCookie, locked = false }) {
  const enabled = Boolean(password) || locked;
  const pwHash = password ? await sha256(password) : null;
  const pwTag = pwHash ? hex(pwHash).slice(0, 16) : '';
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sign = async (exp) => b64url(await crypto.subtle.sign('HMAC', key, enc.encode(`${exp}:${pwTag}`)));

  const readCookie = (request) => {
    const m = /(?:^|;\s*)todos_session=([^;]+)/.exec(request.headers.get('cookie') || '');
    return m ? decodeURIComponent(m[1]) : '';
  };
  const isSecure = (request) =>
    secureCookie ?? (new URL(request.url).protocol === 'https:' || request.headers.get('x-forwarded-proto') === 'https');

  return {
    enabled,
    needsSetup: locked && !password,
    async check(request) {
      if (!enabled) return true;
      if (!password) return false;
      const [exp, sig] = readCookie(request).split('.');
      if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
      return same(enc.encode(await sign(exp)), enc.encode(sig));
    },
    async verify(input) {
      return Boolean(pwHash) && same(await sha256(input), pwHash);
    },
    async issue(request) {
      const exp = Math.floor(Date.now() / 1000) + MAX_AGE;
      return `${COOKIE}=${exp}.${await sign(exp)}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; SameSite=Lax${isSecure(request) ? '; Secure' : ''}`;
    },
    clear: () => `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
  };
}

export const newSecret = () => b64url(crypto.getRandomValues(new Uint8Array(32)));

// 会话密钥：环境变量优先；否则第一次启动时生成并存进数据库（并发启动也只会留下一个）
export async function loadSecret(db, fromEnv) {
  return fromEnv || db.initMeta('session_secret', newSecret());
}
