/* 日程视图：Google 日历式的时间轴
   - 显示的是一段连续的日子（日 / 3 天 / 周），可以前后翻，不受"选中了哪几天"限制
   - 有开始时间的画成色块；只有截止时刻的画成小旗；都没有的放在顶部"未排期"
   - 点任务 → 详情卡（完成 / 编辑 / 删除）；空白处拖一下或点一下 → 快速新建卡（输入标题回车就建好）
   - 拖色块改时间 / 换天；拖底边改时长；拖进 / 拖出"未排期"就排上 / 取消时间；色块左边的圆圈直接勾选完成
   - 触屏：长按才拿起或新建，平时滑动照常滚动；Esc 先关卡片、再取消拖动 */
(function () {
  const { parse, WEEK, colorOf, toMin, fromMin, fmtSpan, shiftDue, dueState, fmtDueFor } = Todos;
  const SNAP = 15;
  const LONG_PRESS = 320;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const snap = (m) => Math.round(m / SNAP) * SNAP;
  const svg = (d) => `<svg class="ic" viewBox="0 0 24 24"><path d="${d}"/></svg>`;
  const I = {
    flag: svg('M6 21V4M6 4h11l-2 4 2 4H6'),
    clock: '<svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
    check: svg('M5 12.5l4.5 4.5L19 7.5'),
    edit: svg('M4 20h4L19 9l-4-4L4 16v4z'),
    trash: svg('M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13'),
    close: svg('M6 6l12 12M18 6L6 18'),
  };
  const dayText = (d) => { const x = parse(d); return `${x.getMonth() + 1}月${x.getDate()}日 周${WEEK[x.getDay()]}`; };

  // 同一时间段重叠的色块并排：按开始时间依次放进第一条空着的"车道"
  function lanes(evs) {
    evs.sort((a, b) => a.s - b.s || b.e - a.e);
    let group = [];
    let ends = [];
    let groupEnd = -1;
    const flush = () => {
      for (const ev of group) ev.n = ends.length;
      group = [];
      ends = [];
    };
    for (const ev of evs) {
      if (ev.s >= groupEnd) flush();
      let lane = ends.findIndex((end) => end <= ev.s);
      if (lane < 0) lane = ends.push(0) - 1;
      ends[lane] = ev.e;
      ev.lane = lane;
      groupEnd = Math.max(groupEnd, ev.e);
      group.push(ev);
    }
    flush();
    return evs;
  }

  /* ctx：
       days()            当前显示的日子（连续）          selected    用户在日历里选中的日子（Set）
       today() rel(d)    今天 / "今天""明天"            items()     这些日子里要显示的任务
       update(id, patch) toggle(t) remove(t) edit(t)     改 / 勾选 / 删除 / 打开完整编辑
       add({content,date,start,end})                     快速新建
       more({content,date,start,end})                    转到完整新建弹窗
       focusDay(d)       点日期表头：只看这一天 */
  window.Schedule = function (ctx) {
    let root = null; // .sched 滚动容器
    let act = null; // 正在进行的拖动 / 新建
    let pop = null; // 打开着的卡片 { el, ghost, src }
    let keep = null; // 重绘时保持滚动位置
    let raf = 0;
    const mobile = () => innerWidth <= 600;
    const hourH = () => (mobile() ? 48 : 56);
    const find = (id) => Todos.all().find((t) => t.id === id);

    // ───── 卡片（详情 / 快速新建） ─────
    function closePop() {
      if (!pop) return false;
      const p = pop;
      pop = null;
      p.el.remove();
      if (p.ghost) p.ghost.remove();
      if (p.src) p.src.classList.remove('is-open');
      return true;
    }

    function place(el, rect) {
      if (mobile()) return el.classList.add('sheet'); // 手机上从底部升起
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      let x = rect.right + 10;
      if (x + w > innerWidth - 12) x = rect.left - w - 10;
      if (x < 12) x = clamp(rect.left, 12, innerWidth - w - 12);
      el.style.left = `${x}px`;
      el.style.top = `${clamp(rect.top - 4, 12, innerHeight - h - 12)}px`;
    }

    function mount(el, anchor, extra = {}) {
      closePop();
      document.body.appendChild(el);
      pop = { el, ...extra };
      place(el, anchor.getBoundingClientRect());
    }

    function showInfo(t, src) {
      if (!src) return;
      const c = document.createElement('div');
      c.className = `pop info c${colorOf(t.tag)}${t.done ? ' done' : ''}`;
      c.tabIndex = -1;
      c.setAttribute('role', 'dialog');
      c.setAttribute('aria-label', '任务详情');
      const when = t.start ? `${dayText(t.date)} · ${fmtSpan(t)}` : `${dayText(t.date)} · 未排期`;
      const st = dueState(t);
      c.innerHTML = `
        <div class="pop-bar">
          <button type="button" data-a="edit" aria-label="编辑" title="编辑">${I.edit}</button>
          <button type="button" data-a="del" aria-label="删除" title="删除">${I.trash}</button>
          <button type="button" data-a="close" aria-label="关闭" title="关闭">${I.close}</button>
        </div>
        <div class="pop-title">
          <button type="button" class="chk" data-a="done" aria-label="${t.done ? '标为未完成' : '标为完成'}">${I.check}</button>
          <div><h3>${esc(t.content)}</h3><p class="pop-sub">${when}</p></div>
        </div>
        ${t.due ? `<p class="pop-row ${st}">${I.flag}${st === 'over' ? '已逾期 · ' : ''}${fmtDueFor(t)}</p>` : ''}
        ${t.tag ? `<p class="pop-row"><span class="tag-chip">${esc(t.tag)}</span></p>` : ''}
        <div class="pop-actions"><button type="button" class="btn primary" data-a="done">${t.done ? '标为未完成' : '标为完成'}</button></div>`;
      c.addEventListener('click', (e) => {
        const b = e.target.closest('[data-a]');
        if (!b) return;
        closePop();
        if (b.dataset.a === 'edit') ctx.edit(t);
        else if (b.dataset.a === 'del') ctx.remove(t);
        else if (b.dataset.a === 'done') ctx.toggle(t);
      });
      src.classList.add('is-open');
      mount(c, src, { src });
      c.focus({ preventScroll: true });
    }

    function openQuick({ date, start = '', end = '' }, anchor, ghost) {
      const c = document.createElement('form');
      c.className = 'pop quick';
      c.setAttribute('aria-label', '快速新建');
      c.innerHTML = `
        <input class="pop-input" placeholder="添加标题" maxlength="500" aria-label="标题" autocomplete="off" enterkeyhint="done">
        <p class="pop-row">${I.clock}${dayText(date)} · ${start ? `${start}${end ? `–${end}` : ''}` : '未排期'}</p>
        <div class="pop-actions">
          <button type="button" class="btn soft" data-a="more">更多选项</button>
          <button type="submit" class="btn primary">保存</button>
        </div>`;
      const input = c.querySelector('input');
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); closePop(); }
      });
      c.addEventListener('submit', (e) => {
        e.preventDefault();
        const content = input.value.trim();
        if (!content) { input.focus(); input.classList.remove('shake'); void input.offsetWidth; input.classList.add('shake'); return; }
        closePop();
        ctx.add({ content, date, start, end });
      });
      c.querySelector('[data-a=more]').addEventListener('click', () => {
        const content = input.value.trim();
        closePop();
        ctx.more({ content, date, start, end });
      });
      mount(c, anchor, { ghost });
      input.focus({ preventScroll: true });
    }

    // 点卡片外面就收起（新建过程中输入了内容也直接丢弃，和 Google 日历一样）
    document.addEventListener('pointerdown', (e) => {
      if (pop && !pop.el.contains(e.target)) closePop();
    }, true);
    addEventListener('resize', closePop);

    // ───── 绘制 ─────
    function evHTML(ev, H) {
      const t = ev.t;
      const top = (ev.s * H) / 60;
      const height = Math.max(((ev.e - ev.s) * H) / 60 - 2, 22);
      const short = height < 44;
      const lines = Math.max(1, Math.floor((height - (short ? 8 : 24)) / 16)); // 标题能完整显示几行
      const w = 100 / ev.n;
      return `<div class="ev c${colorOf(t.tag)}${t.done ? ' done' : ''}${short ? ' short' : ''}${ev.n > 1 ? ' crowded' : ''}${dueState(t) === 'over' ? ' over' : ''}" data-id="${t.id}" tabindex="0"
        style="top:${top}px;height:${height}px;left:calc(${ev.lane * w}% + 2px);width:calc(${w}% - 4px);--lines:${lines}" aria-label="${esc(fmtSpan(t))} ${esc(t.content)}">
        <button type="button" class="chk" data-a="done" tabindex="-1" aria-label="${t.done ? '标为未完成' : '标为完成'}">${I.check}</button>
        <span class="ev-text"><b>${esc(t.content)}</b><time>${fmtSpan(t)}</time></span><i class="ev-resize" aria-hidden="true"></i></div>`;
    }

    function render(stage) {
      closePop();
      if (root && root.isConnected) keep = { top: root.scrollTop, left: root.scrollLeft };
      const H = hourH();
      const days = ctx.days();
      const today = ctx.today();
      const cols = new Map(days.map((d) => [d, { timed: [], flags: [], untimed: [] }]));
      for (const t of ctx.items()) {
        const dueDay = t.due && t.due.length > 10 ? t.due.slice(0, 10) : '';
        const own = cols.get(t.date);
        if (!own) continue;
        if (t.start) own.timed.push(t);
        else if (dueDay && cols.has(dueDay)) cols.get(dueDay).flags.push(t);
        else own.untimed.push(t);
      }
      const now = new Date();
      const nowMin = now.getHours() * 60 + now.getMinutes();
      const colmin = mobile() ? (days.length <= 3 ? '0px' : 'calc((100vw - 64px) / 3)') : days.length <= 7 ? '0px' : '150px';
      const partial = days.length > 1 && days.some((d) => ctx.selected.has(d)) && days.some((d) => !ctx.selected.has(d)); // 选中的只是其中几天时才标出来

      const heads = days.map((d) => {
        const x = parse(d);
        return `<button type="button" class="sch-day${d === today ? ' is-today' : ''}${partial && ctx.selected.has(d) ? ' is-sel' : ''}" data-date="${d}" title="只看这一天" aria-label="${dayText(d)}${ctx.rel(d) ? `，${ctx.rel(d)}` : ''}">
          <span>周${WEEK[x.getDay()]}${ctx.rel(d) ? ` · ${ctx.rel(d)}` : ''}</span><b>${x.getDate()}</b></button>`;
      }).join('');
      const allday = days.map((d) => `<div class="sch-ad" data-date="${d}">${cols.get(d).untimed.map((t) =>
        `<div class="ad-chip c${colorOf(t.tag)}${t.done ? ' done' : ''}" data-id="${t.id}" tabindex="0"><button type="button" class="chk" data-a="done" tabindex="-1" aria-label="${t.done ? '标为未完成' : '标为完成'}">${I.check}</button><span>${esc(t.content)}</span></div>`).join('')}</div>`).join('');
      const hours = Array.from({ length: 23 }, (_, i) => `<span style="top:${(i + 1) * H}px">${i + 1}:00</span>`).join('');
      const body = days.map((d) => {
        const c = cols.get(d);
        const evs = lanes(c.timed.map((t) => {
          const s = toMin(t.start);
          return { t, s, e: t.end ? Math.max(toMin(t.end), s + SNAP) : s + 30 };
        }));
        const flags = c.flags.map((t) => `<div class="flag c${colorOf(t.tag)} ${dueState(t)}${t.done ? ' done' : ''}" data-id="${t.id}" tabindex="0" style="top:${(toMin(t.due.slice(11)) * H) / 60}px">
          <span>${I.flag}${t.due.slice(11)} ${esc(t.content)}</span></div>`).join('');
        const isToday = d === today;
        const mark = isToday ? `<div class="past" style="height:${(nowMin * H) / 60}px" aria-hidden="true"></div><div class="now" style="top:${(nowMin * H) / 60}px" aria-hidden="true"></div>` : '';
        return `<div class="sch-col${isToday ? ' is-today' : ''}${partial && ctx.selected.has(d) ? ' sel' : ''}" data-date="${d}">${mark}${evs.map((ev) => evHTML(ev, H)).join('')}${flags}</div>`;
      }).join('');

      stage.innerHTML = `<div class="sched" style="--hour:${H}px;--days:${days.length};--colmin:${colmin}">
        <div class="sch-grid">
          <div class="sch-corner"></div>${heads}
          <div class="sch-corner sch-adlabel">未排期</div>${allday}
          <div class="sch-hours">${hours}</div>${body}
        </div></div>`;
      root = stage.querySelector('.sched');
      bind();
      fit();
      if (keep) {
        root.scrollTop = keep.top;
        root.scrollLeft = keep.left;
      } else {
        // 第一次打开：有今天就滚到现在前两个小时，否则滚到最早的安排前一小时，再不然 7 点；留一点余量，别让整点标签贴着表头
        const firsts = [...cols.values()].flatMap((c) => c.timed.map((t) => toMin(t.start)));
        const at = days.includes(today) ? nowMin - 120 : firsts.length ? Math.min(...firsts) - 60 : 7 * 60;
        root.scrollTop = Math.max(0, (clamp(at, 0, 23 * 60) * H) / 60 - 14);
      }
    }

    // 撑满窗口剩下的高度（时间轴自己滚动，表头和"未排期"固定在上面）
    function fit() {
      if (!root) return;
      const top = root.getBoundingClientRect().top + scrollY;
      root.style.height = `${Math.max(420, innerHeight - top - (innerWidth <= 820 ? 14 : 22))}px`;
    }

    // ───── 拖动 ─────
    function hit(x, y) {
      for (const col of root.querySelectorAll('.sch-col')) {
        const r = col.getBoundingClientRect();
        if (x < r.left || x >= r.right) continue;
        // "未排期"那一栏固定在上面，按它在屏幕上的实际位置判断（表头也算进去）
        const ad = root.querySelector(`.sch-ad[data-date="${col.dataset.date}"]`).getBoundingClientRect();
        if (y <= ad.bottom) return { zone: 'allday', date: col.dataset.date };
        return { zone: 'grid', date: col.dataset.date, min: clamp(((y - r.top) * 60) / hourH(), 0, 24 * 60), col };
      }
      return null;
    }
    const colOf = (date) => root.querySelector(`.sch-col[data-date="${date}"]`);
    const label = (s, e) => `${fromMin(s)}${e !== null ? `–${fromMin(e)}` : ''}`;

    function put(ghost, s, e) {
      const H = hourH();
      ghost.style.top = `${(s * H) / 60}px`;
      ghost.style.height = `${Math.max(((e - s) * H) / 60 - 2, 22)}px`;
      ghost.classList.toggle('short', ((e - s) * H) / 60 < 44);
    }

    function makeGhost(date, s, e) {
      const g = document.createElement('div');
      g.className = 'ev ghost creating';
      g.innerHTML = '<span class="ev-text"><b>新任务</b><time></time></span>';
      colOf(date).appendChild(g);
      put(g, s, e);
      g.querySelector('time').textContent = label(s, e);
      return g;
    }

    function begin(a) {
      a.moved = true;
      if (a.kind === 'create') {
        a.ghost = makeGhost(a.date, a.anchor, a.anchor + 60);
      } else if (a.kind === 'move') {
        a.el.classList.add('is-src');
        a.ghost = document.createElement('div');
        a.ghost.className = `ev ghost c${colorOf(a.t.tag)}`;
        a.ghost.innerHTML = `<span class="ev-text"><b>${esc(a.t.content)}</b><time></time></span>`;
      } else if (a.kind === 'resize') {
        a.el.classList.add('resizing');
      }
      root.classList.add('is-dragging');
    }

    function update(a, x, y) {
      a.x = x;
      a.y = y;
      const h = hit(x, y);
      if (a.kind === 'resize') {
        const r = colOf(a.t.date).getBoundingClientRect();
        a.e = clamp(snap(((y - r.top) * 60) / hourH()), a.s + SNAP, 24 * 60);
        put(a.el, a.s, a.e);
        a.el.querySelector('time').textContent = label(a.s, a.e);
        return;
      }
      if (a.kind === 'create') {
        const r = colOf(a.date).getBoundingClientRect();
        const m = clamp(((y - r.top) * 60) / hourH(), 0, 24 * 60);
        // 没往下拖多少（长按、或者只是轻轻动了一下）就给一小时，和"点一下空白"一致
        if (!a.sized && Math.abs(y - a.sy) < 8) {
          a.s = Math.min(a.anchor, 23 * 60);
          a.e = Math.min(a.s + 60, 24 * 60);
        } else {
          a.sized = true;
          a.s = Math.min(a.anchor, Math.floor(m / SNAP) * SNAP);
          a.e = Math.min(Math.max(a.anchor + SNAP, Math.ceil(m / SNAP) * SNAP), 24 * 60);
        }
        put(a.ghost, a.s, a.e);
        a.ghost.querySelector('time').textContent = label(a.s, a.e);
        return;
      }
      // 移动：放到"未排期"里就是取消时间，放到格子里按指针位置定开始时间
      if (!h) return;
      a.target = h;
      if (h.zone === 'allday') {
        const cell = root.querySelector(`.sch-ad[data-date="${h.date}"]`);
        a.ghost.classList.add('as-chip');
        a.ghost.removeAttribute('style');
        if (a.ghost.parentNode !== cell) cell.appendChild(a.ghost);
        a.ghost.querySelector('time').textContent = '';
        return;
      }
      a.ghost.classList.remove('as-chip');
      if (a.ghost.parentNode !== h.col) h.col.appendChild(a.ghost);
      a.s = clamp(snap(h.min - a.offset), 0, 24 * 60 - a.dur);
      a.e = a.s + a.dur;
      put(a.ghost, a.s, a.e);
      a.ghost.querySelector('time').textContent = label(a.s, a.hasEnd ? a.e : null);
    }

    // 拖到上下左右边缘时自动滚动：停在边缘一小会儿才开始，只是路过不滚
    function autoscroll() {
      raf = 0;
      if (!act || !act.moved) return;
      const r = root.getBoundingClientRect();
      const gridTop = r.top + root.querySelector('.sch-col').offsetTop;
      const edge = 36;
      const dy = act.y >= gridTop && act.y < gridTop + edge ? -12 : act.y > r.bottom - edge ? 12 : 0;
      const dx = act.x < r.left + 64 ? -12 : act.x > r.right - edge ? 12 : 0;
      if (!dy && !dx) { act.edgeSince = 0; return; }
      const now = performance.now();
      if (!act.edgeSince) act.edgeSince = now;
      if (now - act.edgeSince < 250) { raf = requestAnimationFrame(autoscroll); return; }
      const before = [root.scrollTop, root.scrollLeft];
      root.scrollTop += dy;
      root.scrollLeft += dx;
      if (root.scrollTop === before[0] && root.scrollLeft === before[1]) return; // 到头了
      update(act, act.x, act.y);
      raf = requestAnimationFrame(autoscroll);
    }

    // 拖完以后落到哪；返回 false 表示和原来一样（当作没动）
    function commit(a) {
      const t = a.t;
      if (a.kind === 'resize') return a.e === (t.end ? toMin(t.end) : a.s + 30) ? false : ctx.update(t.id, { end: fromMin(a.e) });
      const target = a.target;
      if (!target) return false;
      if (target.zone === 'allday') {
        if (!t.start && target.date === t.date) return false;
        return ctx.update(t.id, { date: target.date, start: '', end: '', due: shiftDue(t, target.date) });
      }
      const start = fromMin(a.s);
      const end = a.hasEnd ? fromMin(a.e) : '';
      if (target.date === t.date && start === t.start && end === (t.end || '')) return false;
      return ctx.update(t.id, { date: target.date, start, end, due: shiftDue(t, target.date) });
    }

    function cancel() {
      if (closePop()) return true;
      if (!act) return false;
      const a = act;
      act = null;
      clearTimeout(a.timer);
      cancelAnimationFrame(raf);
      if (a.ghost) a.ghost.remove();
      if (a.el) {
        a.el.classList.remove('is-src', 'resizing', 'armed');
        if (a.kind === 'resize') ctx.update(a.t.id, {}); // 恢复原来的高度
      }
      if (root) root.classList.remove('is-dragging');
      return true;
    }

    function bind() {
      root.addEventListener('click', (e) => {
        const dayBtn = e.target.closest('.sch-day');
        if (dayBtn) return ctx.focusDay(dayBtn.dataset.date);
        const chk = e.target.closest('.chk');
        if (chk) {
          const host = chk.closest('[data-id]');
          const t = host && find(host.dataset.id);
          if (t) ctx.toggle(t);
        }
      });

      root.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || act || e.target.closest('.chk, .sch-day')) return;
        const resize = e.target.closest('.ev-resize');
        const ev = e.target.closest('.ev, .ad-chip');
        const flag = e.target.closest('.flag');
        const col = e.target.closest('.sch-col');
        const adCell = e.target.closest('.sch-ad');
        let a;
        if (resize && ev) {
          const t = find(ev.dataset.id);
          a = { kind: 'resize', t, el: ev, s: toMin(t.start), e: t.end ? toMin(t.end) : toMin(t.start) + 30 };
        } else if (ev) {
          const t = find(ev.dataset.id);
          const chip = ev.classList.contains('ad-chip');
          const s = t.start ? toMin(t.start) : 0;
          const dur = chip ? 60 : t.end ? toMin(t.end) - s : 30;
          const h = hit(e.clientX, e.clientY);
          a = { kind: 'move', t, el: ev, dur, hasEnd: chip || Boolean(t.end), offset: chip || !h || h.zone !== 'grid' ? 0 : snap(h.min - s) };
        } else if (flag) {
          a = { kind: 'tap', t: find(flag.dataset.id), el: flag };
        } else if (adCell) {
          a = { kind: 'adnew', date: adCell.dataset.date, el: adCell };
        } else if (col) {
          const h = hit(e.clientX, e.clientY);
          if (!h || h.zone !== 'grid') a = { kind: 'adnew', date: col.dataset.date, el: root.querySelector(`.sch-ad[data-date="${col.dataset.date}"]`) };
          else a = { kind: 'create', date: col.dataset.date, anchor: Math.floor(h.min / SNAP) * SNAP, at: h.min };
        } else return;
        if (!a.t && a.kind !== 'create' && a.kind !== 'adnew') return;
        Object.assign(a, { sx: e.clientX, sy: e.clientY, x: e.clientX, y: e.clientY, touch: e.pointerType === 'touch', moved: false, armed: false });
        act = a;
        if (a.touch) {
          if (a.kind === 'tap' || a.kind === 'adnew') return;
          a.timer = setTimeout(() => {
            if (act !== a) return;
            a.armed = true;
            if (a.el) a.el.classList.add('armed');
            if (navigator.vibrate) navigator.vibrate(12);
            begin(a);
            update(a, a.x, a.y);
          }, LONG_PRESS);
          return;
        }
        e.preventDefault();
        a.armed = true;
        try { root.setPointerCapture(e.pointerId); } catch {}
      });

      root.addEventListener('pointermove', (e) => {
        const a = act;
        if (!a) return;
        const dist = Math.hypot(e.clientX - a.sx, e.clientY - a.sy);
        a.x = e.clientX;
        a.y = e.clientY;
        if (a.touch && !a.armed) {
          if (dist > 8) { clearTimeout(a.timer); act = null; } // 是在滚动
          return;
        }
        if (a.kind === 'tap' || a.kind === 'adnew') return;
        if (!a.moved) {
          if (dist < 4) return;
          begin(a);
        }
        update(a, e.clientX, e.clientY);
        if (!raf) raf = requestAnimationFrame(autoscroll);
      });

      const end = (e) => {
        const a = act;
        if (!a) return;
        act = null;
        clearTimeout(a.timer);
        cancelAnimationFrame(raf);
        raf = 0;
        root.classList.remove('is-dragging');
        if (a.el) a.el.classList.remove('armed', 'is-src');
        if (e.type === 'pointercancel') {
          act = a;
          cancel();
          return;
        }
        if (a.kind === 'move' && a.ghost) a.ghost.remove();
        if (a.moved) {
          if (a.kind === 'create') return openQuick({ date: a.date, start: fromMin(a.s), end: fromMin(a.e) }, a.ghost, a.ghost);
          if (commit(a) === false && a.t) showInfo(a.t, root.querySelector(`[data-id="${a.t.id}"]`));
          return;
        }
        // 没拖动：轻点
        if (a.kind === 'create') {
          if (a.touch) return; // 手机上轻点空白不新建（滑动时容易误碰），长按才建
          const s = clamp(Math.floor(a.at / 30) * 30, 0, 23 * 60);
          const ghost = makeGhost(a.date, s, s + 60);
          return openQuick({ date: a.date, start: fromMin(s), end: fromMin(s + 60) }, ghost, ghost);
        }
        if (a.kind === 'adnew') return openQuick({ date: a.date }, a.el);
        if (a.kind === 'resize') return;
        showInfo(a.t, a.el);
      };
      root.addEventListener('pointerup', end);
      root.addEventListener('pointercancel', end);
      root.addEventListener('touchmove', (e) => { if (act && act.armed) e.preventDefault(); }, { passive: false });
      root.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    // 键盘：上下键挪 15 分钟（Shift 一小时），左右键换到前一天 / 后一天
    function nudge(t, key, big) {
      const days = ctx.days();
      if (key === 'ArrowLeft' || key === 'ArrowRight') {
        const i = days.indexOf(t.date) + (key === 'ArrowLeft' ? -1 : 1);
        if (i < 0 || i >= days.length) return true;
        ctx.update(t.id, { date: days[i], due: shiftDue(t, days[i]) });
        return true;
      }
      if (!t.start || (key !== 'ArrowUp' && key !== 'ArrowDown')) return false;
      const step = (big ? 60 : SNAP) * (key === 'ArrowUp' ? -1 : 1);
      const s = toMin(t.start);
      const e = t.end ? toMin(t.end) : null;
      const len = e === null ? 0 : e - s;
      const ns = clamp(s + step, 0, 24 * 60 - Math.max(len, SNAP));
      ctx.update(t.id, { start: fromMin(ns), end: e === null ? '' : fromMin(ns + len) });
      return true;
    }

    return {
      render,
      fit,
      cancel,
      nudge,
      busy: () => Boolean(pop || (act && (act.moved || act.armed))),
    };
  };
})();
