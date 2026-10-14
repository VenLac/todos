/* 只填一部分的时间：空着的部分按"这一天"补齐
   - 开始 / 结束：时、分；分不填就是整点
   - 截止：年、月、日、时、分；年月日空着就用这一天的，时分都空着就是"那天截止"（不限时刻）
   例：这一天是 2026-10-14，截止只填"15 日 18 时" → 2026-10-15T18:00；只填"18 时" → 2026-10-14T18:00 */
(function (root) {
  const pad = (n) => String(n).padStart(2, '0');
  const realDay = (y, mo, d) => {
    const x = new Date(y, mo - 1, d);
    return x.getFullYear() === y && x.getMonth() === mo - 1 && x.getDate() === d;
  };

  // 时刻：都空 → ''；只填了分 → 错；分空 → 整点
  function hm(h, mi, { allow24 = false } = {}) {
    if (h === '' && mi === '') return { value: '' };
    if (h === '') return { error: '先填小时' };
    const H = Number(h);
    const M = mi === '' ? 0 : Number(mi);
    if (M > 59) return { error: '分钟是 0–59' };
    if (H > 23 && !(allow24 && H === 24 && M === 0)) return { error: '小时是 0–23' };
    return { value: `${pad(H)}:${pad(M)}` };
  }

  // 截止：p = { y, mo, d, h, mi }（字符串，可空）；base = 'YYYY-MM-DD'
  function due(p, base) {
    if (!['y', 'mo', 'd', 'h', 'mi'].some((k) => p[k] !== '')) return { value: '' };
    const [by, bm, bd] = base.split('-').map(Number);
    const y = p.y === '' ? by : p.y.length <= 2 ? 2000 + Number(p.y) : Number(p.y);
    const mo = p.mo === '' ? bm : Number(p.mo);
    const d = p.d === '' ? bd : Number(p.d);
    if (y < 1970 || y > 2999) return { error: '年份不太对' };
    if (mo < 1 || mo > 12) return { error: '月份是 1–12' };
    if (!realDay(y, mo, d)) return { error: `${y} 年 ${mo} 月没有 ${d} 日` };
    const t = hm(p.h, p.mi);
    if (t.error) return t;
    return { value: `${y}-${pad(mo)}-${pad(d)}${t.value ? `T${t.value}` : ''}` };
  }

  // 开始 / 结束
  function span(sh, sm, eh, em) {
    const s = hm(sh, sm);
    if (s.error) return { error: `开始：${s.error}` };
    const e = hm(eh, em, { allow24: true });
    if (e.error) return { error: `结束：${e.error}` };
    if (e.value && !s.value) return { error: '有结束就要先填开始' };
    if (e.value && e.value <= s.value) return { error: '结束要晚于开始' };
    return { start: s.value, end: e.value };
  }

  // 编辑时把已有的截止拆回格子；和这一天同一天的，年月日留空（这样改了日期，截止跟着走）
  function splitDue(value, base) {
    if (!value) return { y: '', mo: '', d: '', h: '', mi: '' };
    const [date, time = ''] = value.split('T');
    const [y, mo, d] = date.split('-');
    const same = date === base;
    return { y: same ? '' : y, mo: same ? '' : String(Number(mo)), d: same ? '' : String(Number(d)), h: time.slice(0, 2), mi: time.slice(3, 5) };
  }
  const splitHM = (v) => (v ? { h: v.slice(0, 2), mi: v.slice(3, 5) } : { h: '', mi: '' });

  // 第一位数字就能确定位数时直接跳到下一格：小时 3–9、月 2–9、日 4–9
  const EARLY = { h: 3, mo: 2, d: 4, mi: 6 };

  // 输入体验：只收数字；填满自动跳格；空格子里退格回上一格；冒号、点、空格也能跳格
  function bindParts(container, onChange) {
    const inputs = () => [...container.querySelectorAll('input.tp')];
    const go = (el, step) => {
      const list = inputs();
      const next = list[list.indexOf(el) + step];
      if (next) {
        next.focus();
        next.select();
      }
    };
    container.addEventListener('input', (e) => {
      const el = e.target;
      if (!el.matches('input.tp')) return;
      const clean = el.value.replace(/\D/g, '').slice(0, el.maxLength);
      if (clean !== el.value) el.value = clean;
      const early = EARLY[el.dataset.part];
      if (clean.length >= el.maxLength || (clean.length === 1 && early && Number(clean) >= early)) go(el, 1);
      onChange();
    });
    container.addEventListener('keydown', (e) => {
      const el = e.target;
      if (!el.matches('input.tp')) return;
      const atStart = el.selectionStart === 0 && el.selectionEnd === 0;
      const atEnd = el.selectionStart === el.value.length;
      if (e.key === 'Backspace' && el.value === '') { e.preventDefault(); go(el, -1); }
      else if ([':', '：', '.', '。', ' ', '/', '-'].includes(e.key)) { e.preventDefault(); if (el.value) go(el, 1); }
      else if (e.key === 'ArrowLeft' && atStart) { e.preventDefault(); go(el, -1); }
      else if (e.key === 'ArrowRight' && atEnd) { e.preventDefault(); go(el, 1); }
    });
    container.addEventListener('focusin', (e) => e.target.matches('input.tp') && e.target.select());
  }

  root.When = { hm, due, span, splitDue, splitHM, bindParts, pad };
})(typeof window !== 'undefined' ? window : globalThis);
