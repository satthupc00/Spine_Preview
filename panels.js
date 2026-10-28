// ---------------------------------------------------------------------------
// "Windows" menu + floating tool panels.
//
// Every <section class="fpanel" data-panel="id" data-title="…"> in index.html becomes a floating
// window that is listed in the header "Windows" menu: pick it to open / close, drag its title bar
// to move it, ✕ to close. Open state and position are remembered between sessions. To add a new
// tool later, add another <section class="fpanel"> with its content — nothing else to wire up.
// ---------------------------------------------------------------------------
(() => {
  const STORE_KEY = 'spv-panels';
  const HEADER_H = 58;
  let state = {};
  try { state = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch (e) { state = {}; }
  const save = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* not critical */ } };

  const panels = [...document.querySelectorAll('.fpanel[data-panel]')];
  if (!panels.length) return;
  let zTop = 900;

  // ---- header button + dropdown menu ----
  const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/></svg>';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'windows-btn';
  btn.className = 'menu-btn';
  btn.title = 'Windows: mở / đóng các bảng công cụ';
  btn.setAttribute('aria-haspopup', 'menu');
  btn.innerHTML = `${ICON}<span>Windows</span><svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;
  const tools = document.getElementById('top-tools');
  tools.insertBefore(btn, tools.firstChild);

  const menu = document.createElement('div');
  menu.className = 'win-menu';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  document.body.append(menu);

  function renderMenu() {
    menu.innerHTML = '<div class="win-menu-title">Bảng công cụ</div>';
    panels.forEach(p => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'win-menu-item' + (p.hidden ? '' : ' on');
      item.setAttribute('role', 'menuitemcheckbox');
      item.setAttribute('aria-checked', String(!p.hidden));
      item.innerHTML = '<span class="tick"></span><span class="lbl"></span>';
      item.querySelector('.lbl').textContent = p.dataset.title;
      item.addEventListener('click', () => { toggle(p); closeMenu(); });
      menu.append(item);
    });
  }
  function openMenu() {
    renderMenu();
    const b = btn.getBoundingClientRect();
    menu.style.top = (b.bottom + 6) + 'px';
    menu.style.left = Math.max(8, Math.min(b.left, window.innerWidth - 230)) + 'px';
    menu.hidden = false;
    btn.classList.add('open');
    setTimeout(() => document.addEventListener('mousedown', onOutside, true), 0);
    document.addEventListener('keydown', onEsc, true);
  }
  function closeMenu() {
    menu.hidden = true;
    btn.classList.remove('open');
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('keydown', onEsc, true);
  }
  const onOutside = e => { if (!menu.contains(e.target) && !btn.contains(e.target)) closeMenu(); };
  const onEsc = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); } };
  btn.addEventListener('click', () => (menu.hidden ? openMenu() : closeMenu()));

  // ---- floating panels ----
  function clampInto(p, x, y) {
    const w = p.offsetWidth || 300, h = p.offsetHeight || 200;
    return {
      x: Math.max(4, Math.min(x, window.innerWidth - w - 4)),
      y: Math.max(HEADER_H + 4, Math.min(y, window.innerHeight - Math.min(h, 60) - 4))
    };
  }
  function place(p) {
    const s = state[p.dataset.panel] || {};
    // default: data-default-x / -y on the section, else top-right just left of the Properties column
    const dx = p.dataset.defaultX != null ? Number(p.dataset.defaultX) : window.innerWidth - p.offsetWidth - 300;
    const dy = p.dataset.defaultY != null ? Number(p.dataset.defaultY) : HEADER_H + 70;
    const x = s.x != null ? s.x : dx;
    const y = s.y != null ? s.y : dy;
    const c = clampInto(p, x, y);
    p.style.left = c.x + 'px';
    p.style.top = c.y + 'px';
  }
  function bringToFront(p) { p.style.zIndex = ++zTop; }
  function open(p) {
    p.hidden = false;
    place(p);
    bringToFront(p);
    p.classList.remove('closing');
    p.classList.add('opening');
    p.addEventListener('animationend', () => p.classList.remove('opening'), { once: true });
    (state[p.dataset.panel] = state[p.dataset.panel] || {}).open = true;
    save();
  }
  function close(p) {
    (state[p.dataset.panel] = state[p.dataset.panel] || {}).open = false;
    save();
    p.classList.add('closing');
    setTimeout(() => { p.hidden = true; p.classList.remove('closing'); }, 140);
  }
  const toggle = p => (p.hidden ? open(p) : close(p));

  panels.forEach(p => {
    p.setAttribute('role', 'dialog');
    p.setAttribute('aria-label', p.dataset.title);
    p.querySelector('.fpanel-close').addEventListener('click', () => close(p));
    p.addEventListener('pointerdown', () => bringToFront(p));
    // typing into a text field in a panel never triggers app shortcuts (Space / D / Q / E…)
    p.addEventListener('keydown', e => { if (e.target.matches('input[type="text"], input:not([type]), textarea')) e.stopPropagation(); });

    // drag by the title bar
    const head = p.querySelector('.fpanel-head');
    head.addEventListener('pointerdown', ev => {
      if (ev.button !== 0 || ev.target.closest('button')) return;
      ev.preventDefault();
      const r = p.getBoundingClientRect();
      const off = { x: ev.clientX - r.left, y: ev.clientY - r.top };
      p.classList.add('moving');
      try { head.setPointerCapture(ev.pointerId); } catch (e) { /* fine without capture */ }
      const move = e => {
        const c = clampInto(p, e.clientX - off.x, e.clientY - off.y);
        p.style.left = c.x + 'px';
        p.style.top = c.y + 'px';
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        p.classList.remove('moving');
        const s = (state[p.dataset.panel] = state[p.dataset.panel] || {});
        s.x = parseFloat(p.style.left);
        s.y = parseFloat(p.style.top);
        save();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });

    const saved = state[p.dataset.panel];
    const startOpen = saved && saved.open != null ? saved.open : p.dataset.defaultOpen === '1';
    if (startOpen) { p.hidden = false; place(p); bringToFront(p); }
  });

  // keep open panels inside the window when it is resized
  window.addEventListener('resize', () => panels.forEach(p => { if (!p.hidden) {
    const c = clampInto(p, parseFloat(p.style.left) || 0, parseFloat(p.style.top) || 0);
    p.style.left = c.x + 'px';
    p.style.top = c.y + 'px';
  } }));

  window.MondiroPanels = { open: id => { const p = panels.find(x => x.dataset.panel === id); if (p && p.hidden) open(p); } };
})();
