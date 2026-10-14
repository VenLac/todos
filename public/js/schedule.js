/* 日程视图：像 Google 日历那样，选中的每一天一列、纵向 0–24 点
   - 有开始时间的画成色块；只有截止时刻的画成小旗；都没有的放在顶部"未定时间"
   - 空白处拖一下新建；拖色块改时间 / 换天；拖底边改时长；拖进 / 拖出"未定时间"就排上 / 取消时间
   - 触屏：长按才拿起或新建，平时滑动照常滚动；Esc 取消正在进行的拖动
   board.js 通过 ctx 提供数据和弹窗：{ dates, items(), today(), update(id, patch), open(t), create({date,start,end}), rel(d) } */
(function () {
  const { parse, WEEK, colorOf, toMin, fromMin, fmtSpan, shiftDue, dueState } = Todos;
  const SNAP = 15;
  const LONG_PRESS = 320;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const snap = (m) => Math.round(m / SNAP) * SNAP;
  const FLAG = '<svg class="ic" viewBox="0 0 24 24"><path d="M6 21V4M6 4h11l-2 4 2 4H6"/></svg>';

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

  window.Schedule = function (ctx) {
    let root = null; // .sched 滚动容器
    let act = null; // 正在进行的拖动 / 新建
    let keep = null; // 重绘时保持滚动位置
    let raf = 0;
    const hourH = () => (innerWidth <= 600 ? 44 : 52);
    const find = (id) => Todos.all().find((t) => t.id === id);

    function evHTML(ev, H) {
      const t = ev.t;
      const top = (ev.s * H) / 60;
      const height = Math.max(((ev.e - ev.s) * H) / 60 - 2, 20);
      const short = height < 40;
      const lines = Math.max(1, Math.floor((height - 22) / 16)); // 标题能完整显示几行，避免被拦腰截断
      const w = 100 / ev.n;
      return `<div class="ev c${colorOf(t.tag)}${t.done ? ' done' : ''}${short ? ' short' : ''}${dueState(t) === 'over' ? ' over' : ''}" data-id="${t.id}" tabindex="0"
        style="top:${top}px;height:${height}px;left:calc(${ev.lane * w}% + 1px);width:calc(${w}% - 3px);--lines:${lines}" aria-label="${esc(fmtSpan(t))} ${esc(t.content)}">
        <b>${esc(t.content)}</b><time>${fmtSpan(t)}</time><i class="ev-resize" aria-hidden="true"></i></div>`;
    }

    function render(stage) {
      if (root && root.isConnected) keep = { top: root.scrollTop, left: root.scrollLeft };
      const H = hourH();
      const days = ctx.dates;
      const today = ctx.today();
      const cols = new Map(days.map((d) => [d, { timed: [], flags: [], untimed: [] }]));
      for (const t of ctx.items()) {
        const dueDay = t.due && t.due.length > 10 ? t.due.slice(0, 10) : '';
        if (t.start) cols.get(t.date).timed.push(t);
        else if (dueDay && cols.has(dueDay)) cols.get(dueDay).flags.push(t);
        else cols.get(t.date).untimed.push(t);
      }
      const now = new Date();
      const nowMin = now.getHours() * 60 + now.getMinutes();
      const mobile = innerWidth <= 600;
      const colmin = mobile ? (days.length <= 3 ? '0px' : 'calc((100vw - 64px) / 3)') : days.length <= 7 ? '0px' : '150px';

      const heads = days.map((d) => {
        const x = parse(d);
        return `<div class="sch-day${d === today ? ' is-today' : ''}"><span>周${WEEK[x.getDay()]}${ctx.rel(d) ? ` · ${ctx.rel(d)}` : ''}</span><b>${x.getDate()}</b></div>`;
      }).join('');
      const allday = days.map((d) => `<div class="sch-ad" data-date="${d}">${cols.get(d).untimed.map((t) =>
        `<div class="ad-chip c${colorOf(t.tag)}${t.done ? ' done' : ''}" data-id="${t.id}" tabindex="0">${esc(t.content)}</div>`).join('')}</div>`).join('');
      const hours = Array.from({ length: 23 }, (_, i) => `<span style="top:${(i + 1) * H}px">${i + 1}:00</span>`).join('');
      const body = days.map((d) => {
        const c = cols.get(d);
        const evs = lanes(c.timed.map((t) => {
          const s = toMin(t.start);
          return { t, s, e: t.end ? Math.max(toMin(t.end), s + SNAP) : s + 30 };
        }));
        const flags = c.flags.map((t) => `<div class="flag c${colorOf(t.tag)} ${dueState(t)}${t.done ? ' done' : ''}" data-id="${t.id}" tabindex="0" style="top:${(toMin(t.due.slice(11)) * H) / 60}px">
          <span>${FLAG}${t.due.slice(11)} ${esc(t.content)}</span></div>`).join('');
        const nowLine = d === today ? `<div class="now" style="top:${(nowMin * H) / 60}px" aria-hidden="true"></div>` : '';
        return `<div class="sch-col${d === today ? ' is-today' : ''}" data-date="${d}">${evs.map((ev) => evHTML(ev, H)).join('')}${flags}${nowLine}</div>`;
      }).join('');

      stage.innerHTML = `<div class="sched" style="--hour:${H}px;--days:${days.length};--colmin:${colmin}">
        <div class="sch-grid">
          <div class="sch-corner"></div>${heads}
          <div class="sch-corner sch-adlabel">未定<br>时间</div>${allday}
          <div class="sch-hours">${hours}</div>${body}
        </div></div>`;
      root = stage.querySelector('.sched');
      bind();
      fit();
      if (keep) {
        root.scrollTop = keep.top;
        root.scrollLeft = keep.left;
      } else {
        // 第一次打开：今天在里面就滚到现在前两个小时，否则滚到最早的安排，再不然从早上 7 点
        const firsts = [...cols.values()].flatMap((c) => c.timed.map((t) => toMin(t.start)));
        const at = days.includes(today) ? nowMin - 120 : firsts.length ? Math.min(...firsts) - 60 : 7 * 60;
        root.scrollTop = (clamp(at, 0, 24 * 60) * H) / 60;
      }
    }

    // 撑满窗口剩下的高度（时间轴自己滚动，表头和"未定时间"固定在上面）
    function fit() {
      if (!root) return;
      const top = root.getBoundingClientRect().top + scrollY;
      root.style.height = `${Math.max(420, innerHeight - top - (innerWidth <= 820 ? 16 : 24))}px`;
    }

    // ───── 拖动 ─────
    function hit(x, y) {
      for (const col of root.querySelectorAll('.sch-col')) {
        const r = col.getBoundingClientRect();
        if (x < r.left || x >= r.right) continue;
        // "未定时间"那一栏固定在上面，按它在屏幕上的实际位置判断（表头也算进去，放宽一点）
        const ad = root.querySelector(`.sch-ad[data-date="${col.dataset.date}"]`).getBoundingClientRect();
        if (y <= ad.bottom) return { zone: 'allday', date: col.dataset.date };
        return { zone: 'grid', date: col.dataset.date, min: clamp(((y - r.top) * 60) / hourH(), 0, 24 * 60), col };
      }
      return null;
    }
    const colOf = (date) => root.querySelector(`.sch-col[data-date="${date}"]`);
    const label = (s, e) => `${fromMin(s)}${e !== null ? `–${fromMin(e)}` : ''}`;

    function place(ghost, s, e) {
      const H = hourH();
      ghost.style.top = `${(s * H) / 60}px`;
      ghost.style.height = `${Math.max(((e - s) * H) / 60 - 2, 20)}px`;
      ghost.classList.toggle('short', ((e - s) * H) / 60 < 40);
    }

    function begin(a) {
      a.moved = true;
      if (a.kind === 'create') {
        a.ghost = document.createElement('div');
        a.ghost.className = 'ev ghost creating';
        a.ghost.innerHTML = '<b>新建</b><time></time>';
        colOf(a.date).appendChild(a.ghost);
      } else if (a.kind === 'move') {
        a.el.classList.add('is-src');
        a.ghost = document.createElement('div');
        a.ghost.className = `ev ghost c${colorOf(a.t.tag)}`;
        a.ghost.innerHTML = `<b>${esc(a.t.content)}</b><time></time>`;
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
        place(a.el, a.s, a.e);
        a.el.querySelector('time').textContent = label(a.s, a.e);
        return;
      }
      if (a.kind === 'create') {
        const r = colOf(a.date).getBoundingClientRect();
        const m = clamp(((y - r.top) * 60) / hourH(), 0, 24 * 60);
        a.s = Math.min(a.anchor, Math.floor(m / SNAP) * SNAP);
        a.e = Math.max(a.anchor + SNAP, Math.ceil(m / SNAP) * SNAP);
        a.e = Math.min(a.e, 24 * 60);
        place(a.ghost, a.s, a.e);
        a.ghost.querySelector('time').textContent = label(a.s, a.e);
        return;
      }
      // 移动：放到"未定时间"里就是取消时间，放到格子里按指针位置定开始时间
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
      place(a.ghost, a.s, a.e);
      a.ghost.querySelector('time').textContent = label(a.s, a.hasEnd ? a.e : null);
    }

    // 拖到上下左右边缘时自动滚动（在"未定时间"那一栏里不滚）
    function autoscroll() {
      raf = 0;
      if (!act || !act.moved) return;
      const r = root.getBoundingClientRect();
      const gridTop = r.top + root.querySelector('.sch-col').offsetTop;
      const edge = 36;
      const dy = act.y >= gridTop && act.y < gridTop + edge ? -12 : act.y > r.bottom - edge ? 12 : 0;
      const dx = act.x < r.left + 64 ? -12 : act.x > r.right - edge ? 12 : 0;
      if (!dy && !dx) { act.edgeSince = 0; return; }
      // 在边缘停一小会儿才开始滚，只是路过（比如从"未定时间"往下拖）不滚
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

    function commit(a) {
      if (a.kind === 'create') return ctx.create({ date: a.date, start: fromMin(a.s), end: fromMin(a.e) });
      if (a.kind === 'resize') return ctx.update(a.t.id, { end: fromMin(a.e) });
      const target = a.target;
      if (!target) return ctx.update(a.t.id, {});
      if (target.zone === 'allday') return ctx.update(a.t.id, { date: target.date, start: '', end: '', due: shiftDue(a.t, target.date) });
      return ctx.update(a.t.id, {
        date: target.date,
        start: fromMin(a.s),
        end: a.hasEnd ? fromMin(a.e) : '',
        due: shiftDue(a.t, target.date),
      });
    }

    function cancel() {
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
      root.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || act) return;
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
          a = { kind: 'adnew', date: adCell.dataset.date };
        } else if (col) {
          const h = hit(e.clientX, e.clientY);
          a = { kind: 'create', date: col.dataset.date, anchor: Math.floor(h.min / SNAP) * SNAP, at: h.min };
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
        if (a.el) a.el.classList.remove('armed');
        if (e.type === 'pointercancel') {
          act = a;
          cancel();
          return;
        }
        if (a.moved) {
          if (a.ghost && a.kind !== 'create') a.ghost.remove();
          if (a.kind === 'create' && a.ghost) a.ghost.classList.add('pending');
          commit(a);
          return;
        }
        // 没拖动：轻点 / 点击
        if (a.kind === 'create') {
          if (a.touch && !a.armed) return;
          const s = clamp(Math.floor(a.at / 30) * 30, 0, 23 * 60);
          return ctx.create({ date: a.date, start: fromMin(s), end: fromMin(s + 60) });
        }
        if (a.kind === 'resize') return;
        if (a.kind === 'adnew') return ctx.create({ date: a.date });
        if (!a.touch || !a.armed || a.kind === 'tap') ctx.open(a.t);
      };
      root.addEventListener('pointerup', end);
      root.addEventListener('pointercancel', end);
      root.addEventListener('touchmove', (e) => { if (act && act.armed) e.preventDefault(); }, { passive: false });
      root.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    // 键盘：上下键挪 15 分钟（Shift 一小时），左右键换到前一天 / 后一天
    function nudge(t, key, big) {
      const days = ctx.dates;
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
      busy: () => Boolean(act && (act.moved || act.armed)),
    };
  };
})();
