/* 日历页：单击打开一天、拖过多天、Ctrl/⌘ 累加、Shift 选段 */
(function () {
  const { ymd, parse, WEEK, colorOf } = Todos;
  const $ = (s) => document.querySelector(s);
  const grid = $('#grid');
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // 初始月份：?m=YYYY-MM（从看板返回时带回），否则当月
  let view = new Date();
  const m = /^(\d{4})-(\d{2})$/.exec(new URLSearchParams(location.search).get('m') || '');
  if (m) view = new Date(+m[1], +m[2] - 1, 1);
  view = new Date(view.getFullYear(), view.getMonth(), 1);

  const coarse = matchMedia('(pointer: coarse)');
  const pending = new Set(); // Ctrl/⌘/Shift 累加出来的选择（可跨月）
  let anchor = null;
  let drag = null;

  function render() {
    const y = view.getFullYear();
    const mo = view.getMonth();
    $('#title').innerHTML = `<b>${mo + 1}</b><span>月<small>${y}</small></span>`;
    document.title = `${y}年${mo + 1}月 · Todos`;

    const offset = (view.getDay() + 6) % 7; // 周一为一周起点
    const total = new Date(y, mo + 1, 0).getDate();
    const rows = Math.ceil((offset + total) / 7);
    const start = new Date(y, mo, 1 - offset);
    const byDate = Todos.byDate();
    const today = ymd(new Date());

    let html = '';
    for (let i = 0; i < rows * 7; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      const key = ymd(d);
      // 有开始时间的按时间排在前面，其余按创建顺序
      const items = (byDate.get(key) || []).slice().sort((a, b) => (a.start || '99').localeCompare(b.start || '99') || a.createdAt - b.createdAt);
      const open = items.filter((t) => !t.done).length;
      const label = `${d.getMonth() + 1}月${d.getDate()}日 周${WEEK[d.getDay()]}，` + (items.length ? `${items.length} 项待办，${open} 项未完成` : '没有待办');
      // 格子里贴着的迷你便利贴，每张按 id 歪一点
      const tilt = (t) => { let h = 0; for (const ch of t.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return ((h % 7) - 3) * 0.6; };
      const pills = items.slice(0, 3).map((t) => `<span class="pill c${colorOf(t.tag)}${t.done ? ' done' : ''}" style="--r:${tilt(t)}deg">${t.start ? `<time>${t.start}</time>` : ''}<b>${esc(t.content)}</b></span>`).join('');
      const dots = items.slice(0, 6).map((t) => `<i class="c${colorOf(t.tag)}${t.done ? ' done' : ''}" style="--r:${tilt(t) * 3}deg"></i>`).join('');
      const we = d.getDay() === 0 || d.getDay() === 6;
      html += `<button type="button" class="day${d.getMonth() !== mo ? ' out' : ''}${key === today ? ' today' : ''}${key < today ? ' past' : ''}${we ? ' we' : ''}" data-date="${key}" aria-label="${label}" aria-pressed="false" style="--i:${i}">
        <span class="num">${d.getDate()}</span>
        <span class="pills">${pills}</span>${items.length > 3 ? `<span class="more">+${items.length - 3}</span>` : ''}
        <span class="dots">${dots}</span>
      </button>`;
    }
    grid.innerHTML = html;
    grid.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;
    paint();

    const monthItems = Todos.all().filter((t) => t.date.startsWith(`${y}-${String(mo + 1).padStart(2, '0')}`));
    const done = monthItems.filter((t) => t.done).length;
    $('#stat').innerHTML = monthItems.length
      ? `<b>${done}</b><span>/ ${monthItems.length}</span> 本月已完成`
      : '本月还没有待办，点一天开始吧';
    // 进度：本月每项待办一个小方块，完成了就填上标签色（太多时退回进度条）
    const bar = $('#bar');
    const ordered = [...monthItems].sort((p, q) => q.done - p.done || p.date.localeCompare(q.date));
    bar.classList.toggle('squares', monthItems.length <= 60);
    bar.innerHTML = monthItems.length <= 60
      ? ordered.map((t) => `<i class="c${colorOf(t.tag)}${t.done ? ' on' : ''}"></i>`).join('')
      : `<i style="width:${(done / monthItems.length) * 100}%"></i>`;
    $('#progress').classList.toggle('empty', !monthItems.length);
    upcoming(today);
  }

  // 侧栏：从今天起还没完成的事，按日期 / 截止时间排
  // 右侧小字：有开始时间显示开始时间，否则显示当天的截止时刻
  const when = (t) => {
    if (t.start) return `<em>${t.start}</em>`;
    if (t.due && t.due.slice(0, 10) === t.date && t.due.length > 10) return `<em class="due">${t.due.slice(11)} 截止</em>`;
    return '';
  };

  function upcoming(today) {
    const dueKey = (t) => (t.due ? Todos.dueAt(t.due).getTime() : Infinity);
    const startKey = (t) => (t.start ? Todos.toMin(t.start) : Infinity);
    const list = Todos.all()
      .filter((t) => !t.done && t.date >= today)
      .sort((a, b) => a.date.localeCompare(b.date) || startKey(a) - startKey(b) || dueKey(a) - dueKey(b) || a.createdAt - b.createdAt)
      .slice(0, 6);
    const rel = (d) => {
      const n = Math.round((parse(d) - parse(today)) / 864e5);
      return n === 0 ? '今天' : n === 1 ? '明天' : n === 2 ? '后天' : `${parse(d).getMonth() + 1}/${parse(d).getDate()}`;
    };
    $('#upcoming').innerHTML = list.length
      ? list.map((t, i) => `<li><a class="c${colorOf(t.tag)}" href="board.html?d=${t.date}"><time>${i && list[i - 1].date === t.date ? '' : rel(t.date)}</time><span>${esc(t.content)}</span>${when(t)}</a></li>`).join('')
      : '<li class="none">接下来没有待办，难得清闲</li>';
  }

  // 只改 class，拖动时不重绘整个月历
  function paint() {
    for (const c of grid.children) {
      const on = pending.has(c.dataset.date) || (drag && drag.set.has(c.dataset.date));
      c.classList.toggle('sel', !!on);
      c.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    const bar = $('#selbar');
    const n = pending.size;
    bar.classList.toggle('on', n > 0 && !drag);
    $('#selTxt').textContent = coarse.matches ? `已选 ${n} 天 · 轻点增减` : `已选 ${n} 天`;
  }

  function openDays(days) {
    const list = [...days].sort();
    location.href = `board.html?d=${list.join(',')}`;
  }

  function range(a, b) {
    let [x, y] = [parse(a), parse(b)];
    if (x > y) [x, y] = [y, x];
    const out = [];
    for (let d = x; d <= y; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) out.push(ymd(d));
    return out;
  }

  const cellAt = (x, y) => {
    const el = document.elementFromPoint(x, y);
    return el && el.closest ? el.closest('.day') : null;
  };

  // 触屏：轻点打开当天；长按进入多选（按住继续拖可连选，之后轻点增减）；左右滑动翻月；上下滑动照常滚动
  const LONG_PRESS = 380;
  let touch = null;
  grid.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const c = e.target.closest('.day');
    if (!c) return;
    if (e.pointerType === 'touch') {
      const t = { x0: e.clientX, y0: e.clientY, cell: c, armed: false };
      t.timer = setTimeout(() => {
        if (touch !== t) return;
        t.armed = true;
        drag = { set: new Set([c.dataset.date]), moved: false, x: t.x0, y: t.y0 };
        if (navigator.vibrate) navigator.vibrate(12);
        paint();
      }, LONG_PRESS);
      touch = t;
      return;
    }
    e.preventDefault();
    drag = { set: new Set([c.dataset.date]), moved: false, x: e.clientX, y: e.clientY, mod: e.ctrlKey || e.metaKey, shift: e.shiftKey };
    paint();
  });
  grid.addEventListener('touchmove', (e) => { if (touch && touch.armed) e.preventDefault(); }, { passive: false });
  grid.addEventListener('contextmenu', (e) => e.preventDefault());

  document.addEventListener('pointermove', (e) => {
    if (touch && !touch.armed) {
      if (Math.hypot(e.clientX - touch.x0, e.clientY - touch.y0) > 10) clearTimeout(touch.timer);
      return;
    }
    if (!drag) return;
    // 在上一个点和当前点之间插值，鼠标划得快也不会漏格子
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    const steps = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 10));
    let changed = false;
    for (let i = 1; i <= steps; i++) {
      const c = cellAt(drag.x + (dx * i) / steps, drag.y + (dy * i) / steps);
      if (c && !drag.set.has(c.dataset.date)) {
        drag.set.add(c.dataset.date);
        drag.moved = true;
        changed = true;
      }
    }
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (changed) paint();
  });

  function endTouch(e) {
    const t = touch;
    touch = null;
    clearTimeout(t.timer);
    if (t.armed) {
      const d = drag;
      drag = null;
      d.set.forEach((k) => pending.add(k));
      anchor = [...d.set].pop();
      paint();
      return;
    }
    if (e.type !== 'pointerup') return;
    const dx = e.clientX - t.x0;
    const dy = e.clientY - t.y0;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      go(dx < 0 ? 1 : -1);
    } else if (Math.hypot(dx, dy) < 10) {
      const k = t.cell.dataset.date;
      if (pending.size) {
        pending.has(k) ? pending.delete(k) : pending.add(k);
        paint();
      } else {
        openDays([k]);
      }
    }
  }

  document.addEventListener('pointerup', (e) => {
    if (touch) return endTouch(e);
    if (!drag) return;
    const d = drag;
    drag = null;
    const days = [...d.set];
    if (d.mod) {
      if (days.length === 1) {
        pending.has(days[0]) ? pending.delete(days[0]) : pending.add(days[0]);
      } else {
        days.forEach((k) => pending.add(k));
      }
      anchor = days[days.length - 1];
      paint();
    } else if (d.shift && anchor && days.length === 1) {
      range(anchor, days[0]).forEach((k) => pending.add(k));
      paint();
    } else {
      openDays(days);
    }
  });
  document.addEventListener('pointercancel', (e) => {
    if (touch) return endTouch(e);
    drag = null;
    paint();
  });

  // 键盘：Enter / 空格 触发的 click（detail === 0）打开当天
  grid.addEventListener('click', (e) => {
    const c = e.target.closest('.day');
    if (c && e.detail === 0) openDays([c.dataset.date]);
  });

  $('#selOpen').addEventListener('click', () => openDays(pending));
  $('#selClear').addEventListener('click', () => {
    pending.clear();
    paint();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && pending.size) {
      pending.clear();
      paint();
    }
  });

  // 切换月份：卡片顺着翻页方向依次滑入
  let enterTimer;
  const go = (delta) => {
    const prev = view;
    view = delta === 0 ? new Date(new Date().getFullYear(), new Date().getMonth(), 1) : new Date(view.getFullYear(), view.getMonth() + delta, 1);
    if (+view === +prev) return;
    history.replaceState(null, '', `?m=${view.getFullYear()}-${String(view.getMonth() + 1).padStart(2, '0')}`);
    render();
    grid.dataset.dir = view > prev ? 'next' : 'prev';
    grid.classList.remove('enter');
    void grid.offsetWidth;
    grid.classList.add('enter');
    clearTimeout(enterTimer);
    enterTimer = setTimeout(() => grid.classList.remove('enter'), 900);
  };
  $('#prev').addEventListener('click', () => go(-1));
  $('#next').addEventListener('click', () => go(1));
  $('#today').addEventListener('click', () => go(0));

  // 部署在服务器上时：显示导出备份；设了密码时显示退出登录
  if (/^https?:$/.test(location.protocol)) {
    $('#railFoot').hidden = false;
    fetch('api/session').then((r) => r.json()).then((s) => { $('#logout').hidden = !(s.auth && s.ok); }).catch(() => {});
    $('#logout').addEventListener('click', async () => {
      await fetch('api/logout', { method: 'POST' }).catch(() => {});
      location.href = 'login.html';
    });
  }

  Todos.onExternalChange = render;
  // 从浏览器后退回来时（bfcache）重新读取数据
  window.addEventListener('pageshow', (e) => e.persisted && location.reload());
  render();
})();
