/* 看板页：自由贴（可拖动摆放的便利贴墙）/ 日程（时间轴）/ 整理（按日期、标签、列表），新建、编辑、完成、删除并可撤销 */
(function () {
  const { ymd, parse, fmtDay, colorOf, toMin, dueAt, dueState, fmtDueFor, fmtSpan } = Todos;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
  };

  const ICON = {
    check: '<svg class="ic" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    edit: '<svg class="ic" viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16v4z"/></svg>',
    trash: '<svg class="ic" viewBox="0 0 24 24"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/></svg>',
    clock: '<svg class="ic" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
    flag: '<svg class="ic" viewBox="0 0 24 24"><path d="M6 21V4M6 4h11l-2 4 2 4H6"/></svg>',
    plus: '<svg class="ic" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  };

  // ───── 读取选中的日期 ─────
  const dates = [...new Set((new URLSearchParams(location.search).get('d') || '').split(',').filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s)))].sort();
  if (!dates.length) {
    location.replace('index.html');
    return;
  }
  $('#back').href = `index.html?m=${dates[0].slice(0, 7)}`;
  const dateSet = new Set(dates);
  const today = () => ymd(new Date());

  const S = {
    view: ['list', 'schedule'].includes(store.get('todos.view')) ? store.get('todos.view') : 'canvas',
    group: ['tag', 'flat'].includes(store.get('todos.group')) ? store.get('todos.group') : 'date',
    tag: null,
    hideDone: false,
  };

  const mine = () => Todos.all().filter((t) => dateSet.has(t.date));
  const visible = (items) => items.filter((t) => (S.tag === null || (t.tag || '') === S.tag) && !(S.hideDone && t.done));
  const hash = (s) => { let h = 0; for (const c of s) h = (h * 33 + c.charCodeAt(0)) >>> 0; return h; };
  const dueKey = (t) => (t.due ? dueAt(t.due).getTime() : Infinity);
  const startKey = (t) => (t.start ? toMin(t.start) : Infinity);
  const byDate = (a, b) => a.date.localeCompare(b.date) || a.done - b.done || startKey(a) - startKey(b) || dueKey(a) - dueKey(b) || a.createdAt - b.createdAt;
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const md = (d) => { const x = parse(d); return `${x.getMonth() + 1}/${x.getDate()}`; };
  const rel = (d) => ({ [today()]: '今天', [ymd(new Date(Date.now() + 864e5))]: '明天', [ymd(new Date(Date.now() - 864e5))]: '昨天' }[d] || '');

  // ───── 头部 / 筛选 ─────
  function head(items) {
    const first = parse(dates[0]);
    const last = parse(dates[dates.length - 1]);
    const contiguous = (last - first) / 864e5 + 1 === dates.length;
    const mdz = (d) => `${d.getMonth() + 1}月${d.getDate()}日`;
    let title;
    if (dates.length === 1) title = fmtDay(dates[0]);
    else if (contiguous) title = `${mdz(first)} – ${mdz(last)}`;
    else title = `${dates.length} 天的便利贴`;
    $('#title').textContent = title;
    document.title = `${title} · Todos`;

    const done = items.filter((t) => t.done).length;
    const over = items.filter((t) => dueState(t) === 'over').length;
    let sub = dates.length > 1 ? (contiguous ? `${dates.length} 天 · ` : `${dates.map(md).join('、')} · `) : (rel(dates[0]) ? `${rel(dates[0])} · ` : '');
    sub += items.length ? `${items.length} 项，已完成 ${done}` : '还没有便利贴';
    $('#sub').innerHTML = esc(sub) + (over ? ` · <span class="over">${over} 项已逾期</span>` : '');
  }

  function chips(items) {
    const counts = new Map();
    for (const t of items) counts.set(t.tag || '', (counts.get(t.tag || '') || 0) + 1);
    if (S.tag !== null && !counts.has(S.tag)) S.tag = null;
    const one = (tag, label, n) => `<button type="button" class="chip c${tag === null ? 0 : colorOf(tag)}" data-tag="${tag === null ? '' : esc(tag)}" data-all="${tag === null ? 1 : 0}" aria-pressed="${S.tag === tag}">${tag === null ? '' : '<i></i>'}${esc(label)}<em>${n}</em></button>`;
    $('#chips').innerHTML = !items.length ? '' :
      one(null, '全部', items.length) + [...counts].sort((a, b) => b[1] - a[1]).map(([tag, n]) => one(tag, tag || '未分类', n)).join('');
    $('#tagList').innerHTML = [...new Set(Todos.all().map((t) => t.tag).filter(Boolean))].map((t) => `<option value="${esc(t)}">`).join('');
  }

  const dueHTML = (t) => {
    if (!t.due) return '';
    const st = dueState(t);
    const txt = fmtDueFor(t);
    return `<span class="due ${st}">${ICON.flag}${st === 'over' ? txt.replace('截止', '已逾期') : txt}</span>`;
  };
  const spanHTML = (t) => (t.start ? `<span class="span-chip">${ICON.clock}${fmtSpan(t)}</span>` : '');

  // ───── 自由贴：画布 ─────
  const noteSize = () => { const s = innerWidth <= 370 ? 140 : innerWidth <= 600 ? 150 : 212; return { w: s, h: s }; };
  // 桌面和手机各记一套摆放位置，互不干扰
  const layout = () => (innerWidth <= 600 ? 'm' : 'd');
  const posOf = (t) => (t.pos && t.pos[layout()]) || null;
  const withPos = (t, p) => ({ pos: { ...(t.pos || {}), [layout()]: { x: Math.round(p.x), y: Math.round(p.y) } } });
  let canvas = null;
  let justAdded = new Set();

  function slots(W, n) {
    const { w, h } = noteSize();
    const [PAD, GAP] = layout() === 'm' ? [14, 18] : [28, 30];
    const cols = Math.max(1, Math.floor((W - PAD * 2 + GAP) / (w + GAP)));
    const span = cols * (w + GAP) - GAP;
    const left = Math.max(PAD, (W - span) / 2);
    return Array.from({ length: n }, (_, i) => ({ x: Math.round(left + (i % cols) * (w + GAP)), y: PAD + Math.floor(i / cols) * (h + GAP + 6) }));
  }
  const jitter = (id, k) => ((hash(id + k) % 13) - 6);

  // 没有位置的便利贴找一个不和别人重叠的空位，并记下来
  function placeMissing(items, W) {
    const { w, h } = noteSize();
    const placed = items.map(posOf).filter(Boolean);
    const missing = items.filter((t) => !posOf(t)).sort(byDate);
    if (!missing.length) return;
    const hit = (p) => placed.some((q) => Math.abs(q.x - p.x) < w * 0.7 && Math.abs(q.y - p.y) < h * 0.7);
    const patches = new Map();
    let i = 0;
    for (const t of missing) {
      let p;
      do { p = slots(W, i + 1)[i]; i++; } while (hit(p));
      const pos = { x: p.x + jitter(t.id, 'x'), y: p.y + jitter(t.id, 'y') };
      patches.set(t.id, withPos(t, pos));
      placed.push(pos);
    }
    Todos.updateMany(patches);
  }

  function noteHTML(t, W) {
    const { w } = noteSize();
    const rot = ((hash(t.id) % 51) - 25) / 10; // -2.5° ~ 2.5°
    const p = posOf(t);
    const x = Math.max(0, Math.min(p.x, W - w - 6));
    return `<article class="note c${colorOf(t.tag)}${t.done ? ' done' : ''}${justAdded.has(t.id) ? ' pop' : ''}" style="left:${x}px;top:${Math.max(0, p.y)}px;z-index:${t.z || 1};--rot:${rot}deg" data-id="${t.id}" tabindex="0" aria-label="${esc(t.content)}，${fmtDay(t.date)}。方向键移动，回车编辑">
      <div class="paper">
        <div class="note-top"><span class="tag${t.tag ? '' : ' none'}">${t.tag ? `#${esc(t.tag)}` : '未分类'}</span><span class="note-date">${dates.length > 1 ? md(t.date) : ''}</span></div>
        <p class="note-body">${esc(t.content)}</p>
        <div class="note-foot">${spanHTML(t)}${dueHTML(t)}
          <span class="acts">
            <button type="button" data-act="done" aria-label="${t.done ? '标为未完成' : '标为完成'}" title="${t.done ? '标为未完成' : '完成'}">${ICON.check}</button>
            <button type="button" data-act="del" aria-label="删除" title="删除">${ICON.trash}</button>
          </span>
        </div>
        ${t.done ? '<span class="stamp" aria-hidden="true">已完成</span>' : ''}
      </div>
    </article>`;
  }

  function renderCanvas(items) {
    const stage = $('#stage');
    stage.innerHTML = '<div class="canvas" id="canvas"><p class="canvas-hint">拖动便利贴随意摆放 · 双击空白处贴一张</p></div>';
    canvas = $('#canvas');
    const W = canvas.clientWidth;
    placeMissing(items, W);
    const all = mine();
    const list = visible(all);
    canvas.insertAdjacentHTML('beforeend', list.map((t) => noteHTML(t, W)).join(''));
    canvas.classList.toggle('has-notes', list.length > 0);
    if (!list.length) canvas.insertAdjacentHTML('beforeend', `<div class="canvas-empty"><b>${all.length ? '没有符合筛选的便利贴' : '这里还空着'}</b><span>${all.length ? '换个标签，或关掉“隐藏已完成”' : '双击任意空白处，或按 N 贴第一张'}</span></div>`);
    fitCanvas();
    justAdded = new Set();
  }

  function fitCanvas() {
    if (!canvas) return;
    const { h } = noteSize();
    let bottom = 0;
    for (const n of canvas.querySelectorAll('.note')) bottom = Math.max(bottom, n.offsetTop + h);
    const minH = Math.max(480, innerHeight - (canvas.getBoundingClientRect().top + scrollY) - 28);
    canvas.style.height = `${Math.max(minH, bottom + 120)}px`;
  }

  function tidy() {
    if (!canvas) return;
    const W = canvas.clientWidth;
    const list = visible(mine()).sort(byDate);
    const pos = slots(W, list.length);
    const xy = new Map(list.map((t, i) => [t.id, { x: pos[i].x + jitter(t.id, 'x'), y: pos[i].y + jitter(t.id, 'y') }]));
    Todos.updateMany(new Map(list.map((t) => [t.id, { ...withPos(t, xy.get(t.id)), z: 1 }])));
    canvas.classList.add('tidying');
    for (const [id, p] of xy) {
      const el = canvas.querySelector(`[data-id="${id}"]`);
      if (el) Object.assign(el.style, { left: `${p.x}px`, top: `${p.y}px`, zIndex: 1 });
    }
    setTimeout(() => { canvas.classList.remove('tidying'); fitCanvas(); }, 650);
  }

  // 拖动：鼠标按下后移动超过 4px 才算拖，否则当作点击打开编辑。
  // 触屏：轻点打开编辑；长按把便利贴"拿起来"再拖；直接滑动则照常滚动页面。
  let drag = null;
  const topZ = () => Math.max(1, ...mine().map((t) => t.z || 1));
  const LONG_PRESS = 320;
  function lift(d) {
    d.armed = true;
    d.z = topZ() + 1;
    d.el.style.zIndex = d.z;
    d.el.classList.add('dragging');
    if (navigator.vibrate) navigator.vibrate(12);
  }
  $('#stage').addEventListener('pointerdown', (e) => {
    if (S.view !== 'canvas' || e.button !== 0) return;
    const el = e.target.closest('.note');
    if (!el || e.target.closest('button')) return;
    drag = { el, id: el.dataset.id, sx: e.clientX, sy: e.clientY, x: el.offsetLeft, y: el.offsetTop, moved: false, touch: e.pointerType === 'touch' };
    if (drag.touch) {
      const d = drag;
      d.timer = setTimeout(() => drag === d && lift(d), LONG_PRESS);
      return;
    }
    e.preventDefault();
    el.focus({ preventScroll: true });
    drag.z = topZ() + 1;
    el.style.zIndex = drag.z;
    try { el.setPointerCapture(e.pointerId); } catch {}
  });
  // 拿起来之后不让页面跟着手指滚动
  $('#stage').addEventListener('touchmove', (e) => { if (drag && drag.armed) e.preventDefault(); }, { passive: false });
  $('#stage').addEventListener('contextmenu', (e) => { if (e.target.closest('.note')) e.preventDefault(); });
  $('#stage').addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.sx;
    const dy = e.clientY - drag.sy;
    if (drag.touch && !drag.armed) {
      if (Math.hypot(dx, dy) > 8) { clearTimeout(drag.timer); drag = null; } // 是在滚动
      return;
    }
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    if (!drag.moved) { drag.moved = true; drag.el.classList.add('dragging'); }
    const { w } = noteSize();
    drag.nx = Math.max(0, Math.min(drag.x + dx, canvas.clientWidth - w - 6));
    drag.ny = Math.max(0, drag.y + dy);
    drag.el.style.left = `${drag.nx}px`;
    drag.el.style.top = `${drag.ny}px`;
    if (drag.ny + 360 > canvas.offsetHeight) canvas.style.height = `${drag.ny + 360}px`;
  });
  const endDrag = (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    clearTimeout(d.timer);
    d.el.classList.remove('dragging');
    if (d.moved) {
      const t = Todos.all().find((x) => x.id === d.id);
      if (t) Todos.update(d.id, { ...withPos(t, { x: d.nx, y: d.ny }), z: d.z });
      fitCanvas();
    } else if (e.type === 'pointerup' && !d.armed) {
      if (d.z) Todos.update(d.id, { z: d.z });
      openDialog(Todos.all().find((t) => t.id === d.id));
    } else if (d.z) {
      Todos.update(d.id, { z: d.z });
    }
  };
  $('#stage').addEventListener('pointerup', endDrag);
  $('#stage').addEventListener('pointercancel', endDrag);

  $('#stage').addEventListener('dblclick', (e) => {
    if (S.view !== 'canvas' || e.target !== canvas) return;
    const { w } = noteSize();
    openDialog(null, { date: dates.length === 1 ? dates[0] : (dateSet.has(today()) ? today() : null), pos: { x: Math.max(0, e.offsetX - w / 2), y: Math.max(0, e.offsetY - 30) } });
  });

  // ───── 整理视图 ─────
  function rowHTML(t) {
    return `<div class="row c${colorOf(t.tag)}${t.done ? ' done' : ''}" data-id="${t.id}" tabindex="0">
      <button type="button" class="chk" data-act="done" aria-label="${t.done ? '标为未完成' : '标为完成'}">${ICON.check}</button>
      <span class="txt">${esc(t.content)}</span>
      <span class="meta">
        ${S.group !== 'tag' ? `<span class="tag-chip${t.tag ? '' : ' none'}">${t.tag ? esc(t.tag) : '未分类'}</span>` : ''}
        ${S.group !== 'date' && dates.length > 1 ? `<span class="date-chip">${md(t.date)}</span>` : ''}
        ${spanHTML(t)}${dueHTML(t)}
      </span>
      <button type="button" class="row-del" data-act="del" aria-label="删除">${ICON.trash}</button>
    </div>`;
  }

  // 左侧是大号标记（日期数字 / 标签名），右侧是这一组的清单
  function groupHTML({ key, mark, title, sub, items, add, cls = '' }) {
    const open = items.filter((t) => !t.done).length;
    return `<section class="group ${cls}">
      <header class="glabel">
        <span class="mark">${mark}</span>
        <span class="gtext"><h3>${title}</h3><span class="gsub">${sub ? `${sub} · ` : ''}${items.length ? `${open} 项待办${items.length - open ? `，${items.length - open} 项完成` : ''}` : '空'}</span></span>
        ${add ? `<button type="button" class="add" data-act="new" ${add} aria-label="在「${esc(key)}」里新建">${ICON.plus}<span>添加</span></button>` : ''}
      </header>
      <div class="rows">${items.length ? items.map(rowHTML).join('') : '<p class="none">还没有</p>'}</div>
    </section>`;
  }

  function renderList(items) {
    const list = visible(items);
    const stage = $('#stage');
    if (!items.length || (!list.length && S.group !== 'date')) {
      stage.innerHTML = `<div class="empty"><b>${items.length ? '没有符合筛选的便利贴' : '这几天还是空的'}</b>${items.length ? '换个标签，或关掉“隐藏已完成”' : '按 N 或点“新建”贴第一张'}</div>`;
      return;
    }
    let groups;
    if (S.group === 'date') {
      const m = new Map(dates.map((d) => [d, []]));
      list.sort(byDate).forEach((t) => m.get(t.date).push(t));
      groups = [...m].filter(([, arr]) => arr.length || dates.length <= 7).map(([d, arr]) => {
        const x = parse(d);
        return { key: fmtDay(d), mark: x.getDate(), title: `${x.getMonth() + 1}月 · 周${Todos.WEEK[x.getDay()]}${rel(d) ? `<em>${rel(d)}</em>` : ''}`, items: arr, add: `data-date="${d}"`, cls: d === today() ? 'is-today' : '' };
      });
    } else if (S.group === 'tag') {
      const m = new Map();
      list.sort(byDate).forEach((t) => { const k = t.tag || ''; if (!m.has(k)) m.set(k, []); m.get(k).push(t); });
      groups = [...m].sort((a, b) => b[1].length - a[1].length).map(([tag, arr]) => ({
        key: tag || '未分类', mark: '<i class="swatch"></i>', title: tag ? `#${esc(tag)}` : '未分类', items: arr, add: `data-tag="${esc(tag)}"`, cls: `c${colorOf(tag)} by-tag`,
      }));
    } else {
      list.sort((a, b) => a.done - b.done || dueKey(a) - dueKey(b) || byDate(a, b));
      groups = [{ key: '全部', mark: list.length, title: '全部', sub: '按截止时间排', items: list, add: '', cls: 'flat' }];
    }
    stage.innerHTML = `<div class="groups g-${S.group}">${groups.map(groupHTML).join('')}</div>`;
  }

  // ───── 渲染 ─────
  function render() {
    const items = mine();
    head(items);
    chips(items);
    document.body.dataset.view = S.view;
    $('#stage').className = `stage ${S.view}`;
    document.querySelectorAll('.mode [data-view]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === S.view)));
    document.querySelectorAll('[data-group]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.group === S.group)));
    moveThumbs();
    if (S.view === 'canvas') renderCanvas(items);
    else if (S.view === 'schedule') { canvas = null; sched.render($('#stage')); }
    else { canvas = null; renderList(items); }
  }

  // 分段按钮下面的白色滑块：跟着选中项滑过去
  function moveThumbs() {
    for (const [box, sel] of [[$('.mode'), '[aria-selected="true"]'], [$('#groupSeg'), '[aria-pressed="true"]']]) {
      const thumb = box.querySelector('.thumb');
      const btn = box.querySelector(sel);
      if (!thumb || !btn || !btn.offsetWidth) continue;
      thumb.style.width = `${btn.offsetWidth}px`;
      thumb.style.transform = `translateX(${btn.offsetLeft}px)`;
      requestAnimationFrame(() => box.classList.add('ready'));
    }
  }

  // 视图切换动画：支持 View Transitions 的浏览器里，内容顺着切换方向滑入；不支持就直接切
  function transition(dir, apply) {
    if (!document.startViewTransition || reduced() || document.visibilityState !== 'visible') return apply();
    const html = document.documentElement;
    html.dataset.vt = dir;
    document.startViewTransition(apply).finished.finally(() => delete html.dataset.vt);
  }

  // 日程（时间轴）视图
  const sched = Schedule({
    dates,
    today,
    rel,
    items: () => visible(mine()),
    update(id, patch) {
      if (Object.keys(patch).length) Todos.update(id, patch);
      render();
    },
    open: (t) => openDialog(t),
    create: ({ date, start = '', end = '' }) => openDialog(null, { date, start, end }),
  });

  // ───── 交互：按钮 / 行 ─────
  $('#stage').addEventListener('click', (e) => {
    const actEl = e.target.closest('[data-act]');
    const act = actEl && actEl.dataset.act;
    if (act === 'new') return openDialog(null, { date: actEl.dataset.date, tag: actEl.dataset.tag });
    const host = e.target.closest('[data-id]');
    if (!host) return;
    const t = Todos.all().find((x) => x.id === host.dataset.id);
    if (!t) return;
    if (act === 'done') {
      Todos.update(t.id, { done: !t.done });
      render();
      const el = $(`#stage [data-id="${t.id}"]`);
      if (el && !t.done) el.classList.add('just-done');
      if (el) el.focus({ preventScroll: true });
    } else if (act === 'del') {
      removeWithUndo(t);
    } else if (S.view === 'list') {
      openDialog(t);
    }
  });

  let nudgeTimer;
  $('#stage').addEventListener('keydown', (e) => {
    const el = e.target.closest('[data-id]');
    if (!el || e.target !== el) return;
    const t = Todos.all().find((x) => x.id === el.dataset.id);
    if (!t) return;
    if (e.key === 'Enter') { e.preventDefault(); openDialog(t); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeWithUndo(t); return; }
    if (S.view === 'schedule') {
      if (sched.nudge(t, e.key, e.shiftKey)) {
        e.preventDefault();
        requestAnimationFrame(() => { const again = $(`#stage [data-id="${t.id}"]`); if (again) again.focus(); });
      }
      return;
    }
    const step = e.shiftKey ? 40 : 10;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!d || S.view !== 'canvas') return;
    e.preventDefault();
    const { w } = noteSize();
    const x = Math.max(0, Math.min(el.offsetLeft + d[0], canvas.clientWidth - w - 6));
    const y = Math.max(0, el.offsetTop + d[1]);
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(() => { Todos.update(t.id, withPos(Todos.all().find((q) => q.id === t.id) || t, { x, y })); fitCanvas(); }, 250);
  });

  function removeWithUndo(t) {
    Todos.remove(t.id);
    render();
    toast('已删除一张便利贴', '撤销', () => {
      Todos.restore(t);
      render();
    });
  }

  // 工具栏
  const VIEWS = ['canvas', 'schedule', 'list'];
  const GROUPS = ['date', 'tag', 'flat'];
  document.querySelectorAll('.mode [data-view]').forEach((b) => b.addEventListener('click', () => {
    const next = b.dataset.view;
    if (S.view === next || drag || sched.busy()) return;
    transition(VIEWS.indexOf(next) > VIEWS.indexOf(S.view) ? 'fwd' : 'back', () => {
      S.view = next;
      store.set('todos.view', next);
      render();
    });
  }));
  document.querySelectorAll('[data-group]').forEach((b) => b.addEventListener('click', () => {
    const next = b.dataset.group;
    if (S.group === next) return;
    transition(GROUPS.indexOf(next) > GROUPS.indexOf(S.group) ? 'fwd' : 'back', () => {
      S.group = next;
      store.set('todos.group', next);
      render();
    });
  }));
  $('#chips').addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    S.tag = b.dataset.all === '1' ? null : b.dataset.tag;
    render();
  });
  $('#hideDone').addEventListener('change', (e) => {
    S.hideDone = e.target.checked;
    render();
  });
  $('#tidyBtn').addEventListener('click', tidy);
  let resizeTimer;
  addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      moveThumbs();
      if (S.view !== 'list' && !drag && !sched.busy()) render();
    }, 150);
  });

  // ───── 弹窗 ─────
  const dlg = $('#dlg');
  let editing = null;
  let newPos = null;
  const F = { sh: '#fSH', sm: '#fSM', eh: '#fEH', em: '#fEM', y: '#fDY', mo: '#fDMo', d: '#fDD', h: '#fDH', mi: '#fDMi' };
  const fv = (k) => $(F[k]).value.trim();
  const setF = (vals) => { for (const [k, v] of Object.entries(vals)) $(F[k]).value = v; };
  const dueParts = () => ({ y: fv('y'), mo: fv('mo'), d: fv('d'), h: fv('h'), mi: fv('mi') });
  const pickedDates = () => [...document.querySelectorAll('#dchips input:checked')].map((i) => i.value);
  // 时间按哪一天补齐：编辑时是"日期"里的那天；新建时是勾选的每一天
  const bases = () => (editing ? [$('#fDate').value || editing.date] : pickedDates().length ? pickedDates() : [dates[0]]);

  const fmtLen = (m) => (m % 60 ? (m >= 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分` : `${m} 分钟`) : `${m / 60} 小时`);
  function fmtFull(v) {
    const d = parse(v.slice(0, 10));
    const year = d.getFullYear() === new Date().getFullYear() ? '' : `${d.getFullYear()}年`;
    return `${year}${d.getMonth() + 1}月${d.getDate()}日 周${Todos.WEEK[d.getDay()]}${v.length > 10 ? ` ${v.slice(11)}` : ''}`;
  }

  // 占位符显示"空着会补成什么"，下面一行实时显示最终结果
  function syncWhen() {
    const bs = bases();
    const [y, m, d] = bs[0].split('-');
    const same = (i) => bs.every((b) => b.split('-')[i] === bs[0].split('-')[i]);
    $('#fDY').placeholder = same(0) ? y : '当年';
    $('#fDMo').placeholder = same(0) && same(1) ? String(Number(m)) : '当月';
    $('#fDD').placeholder = bs.length === 1 ? String(Number(d)) : '当天';

    const lines = [];
    const sp = When.span(fv('sh'), fv('sm'), fv('eh'), fv('em'));
    if (sp.error) lines.push(`<span class="bad">${esc(sp.error)}</span>`);
    else if (sp.start) lines.push(`<span>${ICON.clock}${sp.start}${sp.end ? ` – ${sp.end}，${fmtLen(toMin(sp.end) - toMin(sp.start))}` : ' 开始'}</span>`);
    const p = dueParts();
    const du = When.due(p, bs[0]);
    if (du.error) lines.push(`<span class="bad">${esc(du.error)}</span>`);
    else if (du.value) {
      const perDay = bs.length > 1 && !p.y && !p.mo && !p.d;
      lines.push(`<span>${ICON.flag}${perDay ? `每张各自当天${du.value.length > 10 ? ` ${du.value.slice(11)} ` : ''}截止` : `${fmtFull(du.value)} 截止`}</span>`);
    }
    $('#whenPreview').innerHTML = lines.join('') || '<span class="muted">不定时间，也没有截止</span>';
    $('#dueClear').hidden = !Object.values(p).some(Boolean);
  }

  function syncSwatch() {
    $('#tagSwatch').className = `c${colorOf($('#fTag').value.trim().replace(/^#/, ''))}`;
  }

  // opts: { date: 只预选这一天, tag: 预填标签, pos: 画布上的位置, start / end: 预填时间 }
  function openDialog(t, opts = {}) {
    editing = t || null;
    newPos = opts.pos || null;
    const only = opts.date;
    $('#err').textContent = '';
    $('#dlgTitle').textContent = t ? '编辑便利贴' : '新建便利贴';
    $('#fSave').textContent = t ? '保存' : (dates.length > 1 && !only ? '创建（每天一张）' : '创建');
    $('#fContent').value = t ? t.content : '';
    $('#fTag').value = t ? t.tag : (opts.tag !== undefined ? opts.tag : (S.tag || ''));
    $('#datesCreate').hidden = !!t;
    $('#dateEdit').hidden = !t;
    $('#fDel').hidden = !t;
    if (t) $('#fDate').value = t.date;
    else {
      $('#dchips').innerHTML = dates.map((d) => {
        const dt = parse(d);
        return `<label class="dchip"><input type="checkbox" value="${d}"${!only || only === d ? ' checked' : ''}><span>${dt.getMonth() + 1}/${dt.getDate()} 周${Todos.WEEK[dt.getDay()]}${d === today() ? ' · 今天' : ''}</span></label>`;
      }).join('');
    }
    const s = When.splitHM(t ? t.start : opts.start || '');
    const e = When.splitHM(t ? t.end : opts.end || '');
    const du = When.splitDue(t ? t.due : '', t ? t.date : '');
    setF({ sh: s.h, sm: s.mi, eh: e.h, em: e.mi, ...du });
    syncSwatch();
    syncWhen();
    dlg.classList.remove('closing');
    dlg.showModal();
    $('#fContent').focus();
  }

  // 关闭也有动画；Esc、点遮罩、取消都走这里
  let closing = false;
  function closeDialog() {
    if (!dlg.open || closing) return;
    closing = true;
    const finish = () => {
      if (!closing) return;
      closing = false;
      dlg.classList.remove('closing');
      dlg.close();
      if (S.view === 'schedule') render(); // 收掉时间轴上"新建"的虚影
    };
    if (reduced()) return finish();
    dlg.classList.add('closing');
    dlg.addEventListener('animationend', finish, { once: true });
    setTimeout(finish, 320);
  }

  $('#newBtn').addEventListener('click', () => openDialog());
  $('#fab').addEventListener('click', () => openDialog());
  $('#fCancel').addEventListener('click', closeDialog);
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); closeDialog(); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) closeDialog(); }); // 点击遮罩关闭
  $('#fTag').addEventListener('input', syncSwatch);
  $('#fDate').addEventListener('input', syncWhen);
  $('#dchips').addEventListener('change', syncWhen);
  When.bindParts($('#spanParts'), syncWhen);
  When.bindParts($('#dueParts'), syncWhen);
  $('#dueClear').addEventListener('click', () => {
    setF({ y: '', mo: '', d: '', h: '', mi: '' });
    syncWhen();
    $('#fDY').focus();
  });
  $('#fDel').addEventListener('click', () => {
    const t = editing;
    closeDialog();
    if (t) removeWithUndo(t);
  });
  $('#form').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('#form').requestSubmit();
  });

  $('#form').addEventListener('submit', (e) => {
    e.preventDefault();
    const fail = (msg, el) => {
      $('#err').textContent = msg;
      if (el) el.focus();
    };
    const content = $('#fContent').value.trim();
    const tag = $('#fTag').value.trim().replace(/^#+/, '');
    if (!content) return fail('先写点内容吧', $('#fContent'));
    const sp = When.span(fv('sh'), fv('sm'), fv('eh'), fv('em'));
    if (sp.error) return fail(sp.error, $('#fSH'));
    const p = dueParts();

    if (editing) {
      const date = $('#fDate').value || editing.date;
      const du = When.due(p, date);
      if (du.error) return fail(du.error, $('#fDY'));
      Todos.update(editing.id, { content, tag, date, start: sp.start, end: sp.end, due: du.value });
      closeDialog();
      render();
      if (!dateSet.has(date)) toast(`已移动到 ${fmtDay(date)}，不在当前所选日期里`);
      return;
    }
    const picked = pickedDates();
    if (!picked.length) return fail('至少选一天');
    // 年月日空着时，每张按自己那天补齐
    const dues = picked.map((d) => When.due(p, d));
    const bad = dues.find((r) => r.error);
    if (bad) return fail(bad.error, $('#fDY'));
    const z = topZ() + 1;
    const made = Todos.add(picked.map((date, i) => ({
      date, content, tag, start: sp.start, end: sp.end, due: dues[i].value,
      z: z + i, ...(newPos ? withPos({}, { x: newPos.x + i * 26, y: newPos.y + i * 26 }) : {}),
    })));
    justAdded = new Set(made.map((t) => t.id));
    closeDialog();
    render();
    toast(picked.length > 1 ? `已在 ${picked.length} 天各贴一张` : '已贴好一张便利贴');
  });

  // ───── Esc：先取消正在进行的拖动；没有的话回到日历（弹窗自己处理 Esc） ─────
  function cancelCanvasDrag() {
    const d = drag;
    drag = null;
    clearTimeout(d.timer);
    d.el.classList.remove('dragging');
    if (d.moved) Object.assign(d.el.style, { left: `${d.x}px`, top: `${d.y}px` });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || dlg.open || e.defaultPrevented) return;
    if (drag) { e.preventDefault(); cancelCanvasDrag(); return; }
    if (sched.cancel()) { e.preventDefault(); return; }
    const el = document.activeElement;
    if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) { el.blur(); return; }
    e.preventDefault();
    location.href = $('#back').href;
  });

  // ───── 提示条 ─────
  let toastTimer;
  function toast(msg, btnText, onClick) {
    const el = $('#toast');
    $('#toastTxt').textContent = msg;
    const b = $('#toastBtn');
    b.textContent = btnText || '';
    b.onclick = () => {
      el.classList.remove('on');
      onClick && onClick();
    };
    el.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('on'), 5000);
  }

  // 快捷键 N 新建
  document.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() !== 'n' || e.ctrlKey || e.metaKey || e.altKey || dlg.open) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;
    e.preventDefault();
    openDialog();
  });

  const idle = () => !dlg.open && !drag && !sched.busy();
  Todos.onExternalChange = () => idle() && render();
  window.addEventListener('pageshow', (e) => e.persisted && render());
  setInterval(() => idle() && render(), 60000); // 逾期状态、"现在"红线随时间刷新
  render();
})();
