// Cloudflare D1 数据层，接口和 sqlite.js 相同。
// 表在第一次用到时自动创建（CREATE ... IF NOT EXISTS），部署时不需要单独跑迁移。
import { SCHEMA, SQL } from './schema.js';

const CHUNK = 100; // 一次 batch 的语句数；分批不影响正确性，因为每条都按 updatedAt 判断新旧，重试是幂等的

export function openD1(d1) {
  let ready = null;
  const init = () => (ready ??= d1.batch(SCHEMA.map((s) => d1.prepare(s))).catch((e) => {
    ready = null;
    throw e;
  }));
  const q = (name, ...args) => d1.prepare(SQL[name]).bind(...args);

  return {
    async list() {
      await init();
      const { results } = await q('list').all();
      return results.map((r) => JSON.parse(r.data));
    },
    async state() {
      await init();
      const r = await q('state').first();
      return { rev: Number(r.rev), fresh: Number(r.n) === 0 };
    },
    async apply({ upsert = [], remove = [] }) {
      await init();
      const stmts = [
        ...upsert.map((t) => q('put', t.id, t.date, JSON.stringify(t), t.updatedAt)),
        ...remove.map((r) => q('del', r.id, r.updatedAt)),
      ];
      let applied = 0;
      for (let i = 0; i < stmts.length; i += CHUNK) {
        const res = await d1.batch(stmts.slice(i, i + CHUNK)); // 每批是一个事务
        for (const r of res) applied += r.meta?.changes || 0;
      }
      return applied;
    },
    async initMeta(key, value) {
      await init();
      await q('initMeta', key, value).run();
      return (await q('getMeta', key).first()).value;
    },
    async fails(ip) {
      await init();
      return (await q('getFails', ip).first()) || null;
    },
    async setFails(ip, n, until) {
      await init();
      await d1.batch([q('pruneFails', Date.now()), q('setFails', ip, n, until)]);
    },
    async clearFails(ip) {
      await init();
      await q('clearFails', ip).run();
    },
  };
}
