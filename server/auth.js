// 可选的密码保护：设置 TODOS_PASSWORD 后，读写数据需要先登录。
// 会话是签名的 Cookie（过期时间 + HMAC），签名里带上密码指纹，改密码后旧会话自动失效。
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const COOKIE = 'todos_session';
const MAX_AGE = 30 * 24 * 3600; // 30 天
const sha = (s) => createHash('sha256').update(String(s)).digest();

export function createAuth({ password, secret, secureCookie }) {
  const enabled = Boolean(password);
  const pwHash = enabled ? sha(password) : null;
  const pwTag = enabled ? pwHash.toString('hex').slice(0, 16) : '';
  const sign = (exp) => createHmac('sha256', secret).update(`${exp}:${pwTag}`).digest('base64url');

  // 简单的登录频率限制：每个 IP 10 分钟内最多 10 次失败
  const fails = new Map();
  const WINDOW = 10 * 60 * 1000;
  const LIMIT = 10;

  function readCookie(req) {
    const m = /(?:^|;\s*)todos_session=([^;]+)/.exec(req.headers.cookie || '');
    return m ? decodeURIComponent(m[1]) : '';
  }

  function isSecure(req) {
    if (secureCookie !== undefined) return secureCookie;
    return req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
  }

  return {
    enabled,
    check(req) {
      if (!enabled) return true;
      const [exp, sig] = readCookie(req).split('.');
      if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
      const want = Buffer.from(sign(exp));
      const got = Buffer.from(sig);
      return want.length === got.length && timingSafeEqual(want, got);
    },
    // 返回 'ok' | 'wrong' | 'limited'
    attempt(ip, input) {
      const now = Date.now();
      const f = fails.get(ip);
      if (f && f.until > now && f.n >= LIMIT) return 'limited';
      if (enabled && timingSafeEqual(sha(input), pwHash)) {
        fails.delete(ip);
        return 'ok';
      }
      const cur = f && f.until > now ? f : { n: 0, until: now + WINDOW };
      cur.n++;
      fails.set(ip, cur);
      return 'wrong';
    },
    issue(req) {
      const exp = Math.floor(Date.now() / 1000) + MAX_AGE;
      return `${COOKIE}=${exp}.${sign(exp)}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; SameSite=Lax${isSecure(req) ? '; Secure' : ''}`;
    },
    clear: () => `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
  };
}

export const newSecret = () => randomBytes(32).toString('base64url');
