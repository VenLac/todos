/* 共享数据层 + 日期工具
   - 所有读写都是同步的：先改内存和 localStorage，页面立刻更新
   - 改动记进"待同步"队列（也存在 localStorage，刷新、断网都不丢），后台批量发给服务器
   - 打开页面、切回页面、网络恢复时从服务器拉最新数据，再叠加本机还没同步的改动
   - 直接双击打开 HTML（file://）或服务器不可用时，退回纯本机存储 */
(function () {
  const KEY = 'todos.v1'; // 全部数据的本机缓存
  const OUTBOX = 'todos.outbox.v1'; // 待同步：{ [id]: 条目 | { id, deleted: true, updatedAt } }
  const SYNCED = 'todos.synced.v1'; // 这个浏览器是否已经和服务器对齐过
  const hasServer = /^https?:$/.test(location.protocol);

  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  };
  const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
  const fmtDay = (s) => {
    const d = parse(s);
    return `${d.getMonth() + 1}月${d.getDate()}日 周${WEEK[d.getDay()]}`;
  };
  const fmtDue = (s) => {
    const d = new Date(s);
    return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  // 同一毫秒内连续改动也保证时间戳递增，服务器按它判断新旧
  let lastStamp = 0;
  const stamp = () => (lastStamp = Math.max(Date.now(), lastStamp + 1));

  // 标签 -> 便利贴颜色（0-5），同一个标签永远同一种颜色
  const COLORS = 6;
  const colorOf = (tag) => {
    if (!tag) return 0;
    let h = 0;
    for (const ch of tag) h = (h * 31 + ch.codePointAt(0)) >>> 0;
    return 1 + (h % (COLORS - 1));
  };

  // ───── localStorage（不可用时退回内存） ─────
  const mem = {};
  const ls = {
    get(k) {
      try {
        const raw = localStorage.getItem(k);
        return raw === null ? (k in mem ? mem[k] : null) : JSON.parse(raw);
      } catch {
        return k in mem ? mem[k] : null;
      }
    },
    set(k, v) {
      mem[k] = v;
      try { localStorage.setItem(k, JSON.stringify(v)); } catch {}
    },
  };

  function seed() {
    const t = new Date();
    const at = (off, h, m) => `${ymd(new Date(t.getFullYear(), t.getMonth(), t.getDate() + off))}T${pad(h)}:${pad(m)}`;
    const day = (off) => ymd(new Date(t.getFullYear(), t.getMonth(), t.getDate() + off));
    const mk = (off, tag, content, due) => {
      const now = stamp();
      return { id: uid(), date: day(off), tag, content, due: due || '', done: false, createdAt: now, updatedAt: now };
    };
    return [
      mk(0, '工作', '整理本周计划，把要推进的三件事写下来', at(0, 18, 0)),
      mk(0, '生活', '买牛奶和鸡蛋'),
      mk(1, '学习', '读完第三章并写 5 条笔记', at(1, 20, 0)),
      mk(1, '生活', '给家里打个电话'),
      mk(2, '工作', '提交周报', at(2, 12, 0)),
    ];
  }

  const cached = ls.get(KEY);
  let list = Array.isArray(cached) ? cached : null;
  if (list === null && !hasServer) {
    list = seed();
    ls.set(KEY, list);
  }
  list = list || [];
  const save = () => ls.set(KEY, list);
  const notify = () => (Todos.onExternalChange || (() => {}))();

  // ───── 同步状态提示：只在不正常时出现 ─────
  let status = hasServer ? 'connecting' : 'local';
  let flag = null;
  function setStatus(s) {
    status = s;
    const text = { offline: '离线中 · 改动已存在本机，联网后自动同步', error: '同步失败 · 改动已存在本机，稍后重试' }[s];
    if (!flag && text && document.body) {
      flag = document.createElement('div');
      flag.className = 'sync-flag';
      flag.setAttribute('role', 'status');
      document.body.appendChild(flag);
    }
    if (flag) {
      flag.textContent = text || '';
      flag.classList.toggle('on', Boolean(text));
    }
  }

  // ───── 与服务器同步 ─────
  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
      location.href = `login.html?next=${encodeURIComponent((location.pathname.split('/').pop() || 'index.html') + location.search)}`;
      throw Object.assign(new Error('unauthorized'), { status: 401 });
    }
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    return res.status === 204 ? null : res.json();
  }

  // 队列每次都从 localStorage 读改写，多个标签页同时开着也不会互相覆盖
  function enqueue(entries) {
    if (!hasServer) return;
    const box = ls.get(OUTBOX) || {};
    for (const e of entries) if (!box[e.id] || box[e.id].updatedAt <= e.updatedAt) box[e.id] = e;
    ls.set(OUTBOX, box);
    scheduleFlush(350);
  }

  let flushTimer = null;
  let flushing = false;
  let backoff = 2000;
  function scheduleFlush(ms) {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, ms);
  }

  async function flush() {
    if (!hasServer || flushing || status === 'connecting') return;
    const box = ls.get(OUTBOX) || {};
    const sent = Object.values(box);
    if (!sent.length) return;
    flushing = true;
    try {
      await api('POST', 'api/sync', {
        upsert: sent.filter((e) => !e.deleted),
        remove: sent.filter((e) => e.deleted).map((e) => ({ id: e.id, updatedAt: e.updatedAt })),
      });
      // 只移除发出去的那一版；发送期间又改过的留着下次发
      const now = ls.get(OUTBOX) || {};
      for (const e of sent) if (now[e.id] && now[e.id].updatedAt <= e.updatedAt) delete now[e.id];
      ls.set(OUTBOX, now);
      backoff = 2000;
      setStatus('synced');
      if (Object.keys(now).length) scheduleFlush(50);
    } catch (e) {
      if (e.status === 401) return;
      setStatus(navigator.onLine === false ? 'offline' : 'error');
      if (e.status === 400) {
        // 服务器拒收的数据重试也没用，丢掉避免卡住队列
        console.warn('服务器拒收了这批改动', e);
        ls.set(OUTBOX, {});
      } else {
        scheduleFlush(backoff);
        backoff = Math.min(backoff * 2, 60000);
      }
    } finally {
      flushing = false;
    }
  }

  let pulling = null;
  function pull() {
    if (!hasServer) return Promise.resolve();
    if (pulling) return pulling;
    pulling = (async () => {
      try {
        const r = await api('GET', 'api/todos');
        const map = new Map(r.todos.map((t) => [t.id, t]));
        // 这个浏览器第一次连上服务器：把本机已有的数据并进去（服务器是空的就先放示例）
        if (!ls.get(SYNCED)) {
          const local = cached === null && r.fresh ? seed() : list;
          const extra = local
            .map((t) => ({ ...t, updatedAt: t.updatedAt || t.createdAt || stamp() }))
            .filter((t) => !map.has(t.id) || map.get(t.id).updatedAt < t.updatedAt);
          enqueue(extra);
          ls.set(SYNCED, true);
        }
        // 叠加本机还没同步上去的改动
        for (const e of Object.values(ls.get(OUTBOX) || {})) {
          if (e.deleted) map.delete(e.id);
          else map.set(e.id, e);
        }
        list = [...map.values()];
        save();
        setStatus('synced');
        notify();
      } catch (e) {
        if (e.status !== 401) setStatus(navigator.onLine === false ? 'offline' : 'error');
      } finally {
        pulling = null;
        flush();
      }
    })();
    return pulling;
  }

  if (hasServer) {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
    pull();
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && pull());
    window.addEventListener('online', () => pull());
    window.addEventListener('offline', () => setStatus('offline'));
    // 页面关闭前把还没发出去的改动尽量发掉
    window.addEventListener('pagehide', () => {
      const box = Object.values(ls.get(OUTBOX) || {});
      if (!box.length || !navigator.sendBeacon) return;
      const body = JSON.stringify({ upsert: box.filter((e) => !e.deleted), remove: box.filter((e) => e.deleted).map(({ id, updatedAt }) => ({ id, updatedAt })) });
      navigator.sendBeacon('api/sync', new Blob([body], { type: 'application/json' }));
    });
  }

  // 其它标签页改了数据
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) {
      list = ls.get(KEY) || [];
      notify();
    }
  });

  // ───── 对外接口（同步调用，和以前一样） ─────
  const touch = (t) => ({ ...t, updatedAt: stamp() });
  const Todos = {
    ymd, parse, pad, WEEK, fmtDay, fmtDue, colorOf,
    all: () => list,
    status: () => status,
    sync: pull,
    byDate() {
      const map = new Map();
      for (const t of list) {
        if (!map.has(t.date)) map.set(t.date, []);
        map.get(t.date).push(t);
      }
      return map;
    },
    add(items) {
      const made = items.map((i) => {
        const now = stamp();
        return { id: uid(), done: false, due: '', tag: '', createdAt: now, ...i, updatedAt: now };
      });
      list = list.concat(made);
      save();
      enqueue(made);
      return made;
    },
    update(id, patch) {
      let changed = null;
      list = list.map((t) => (t.id === id ? (changed = touch({ ...t, ...patch })) : t));
      save();
      if (changed) enqueue([changed]);
    },
    // 一次写入多条修改：patches 是 Map(id -> patch)
    updateMany(patches) {
      if (!patches.size) return;
      const changed = [];
      list = list.map((t) => {
        if (!patches.has(t.id)) return t;
        const n = touch({ ...t, ...patches.get(t.id) });
        changed.push(n);
        return n;
      });
      save();
      enqueue(changed);
    },
    remove(id) {
      const gone = list.find((t) => t.id === id);
      list = list.filter((t) => t.id !== id);
      save();
      if (gone) enqueue([{ id, deleted: true, updatedAt: stamp() }]);
      return gone;
    },
    restore(item) {
      if (list.some((t) => t.id === item.id)) return;
      const back = touch(item);
      list = list.concat(back);
      save();
      enqueue([back]);
    },
    onExternalChange: null,
  };
  window.Todos = Todos;
})();
