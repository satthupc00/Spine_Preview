// ---------------------------------------------------------------------------
// "Thứ tự vẽ" (Preview tab): the skeletons on the canvas listed front to back — the top row is
// drawn over everything else. Click a row to select that skeleton (Ctrl/Shift adds), hold & drag
// a row to change the draw order (m-skill §9: the dragged row lifts and follows the pointer, the
// others slide out of the way, Esc cancels). Uses renderer.js globals: instances, selection,
// selectInstance, pushUndoSnapshot, stage, activeTab.
// ---------------------------------------------------------------------------
(() => {
  const panel = document.getElementById('order-panel');
  const list = document.getElementById('order-list');
  if (!panel || !list) return;

  const GRIP = '<svg viewBox="0 0 10 16" width="8" height="13" aria-hidden="true"><g fill="currentColor"><circle cx="2.5" cy="3" r="1.4"/><circle cx="7.5" cy="3" r="1.4"/><circle cx="2.5" cy="8" r="1.4"/><circle cx="7.5" cy="8" r="1.4"/><circle cx="2.5" cy="13" r="1.4"/><circle cx="7.5" cy="13" r="1.4"/></g></svg>';
  let drag = null;
  let lastSig = '';

  // front-most first
  const ordered = () => instances.slice().reverse();

  function render() {
    list.innerHTML = '';
    const rows = ordered();
    if (!rows.length) {
      list.innerHTML = '<div class="order-empty">Chưa có skeleton nào trên khung Preview.</div>';
      return;
    }
    const seen = {};
    rows.forEach((inst, i) => {
      seen[inst.name] = (seen[inst.name] || 0) + 1;
      const row = document.createElement('div');
      row.className = 'order-row' + (selection.includes(inst.id) ? ' selected' : '');
      row.dataset.id = inst.id;
      row.title = i === 0 ? 'Vẽ trên cùng · giữ và kéo để đổi thứ tự' : 'Giữ và kéo để đổi thứ tự vẽ';
      row.innerHTML = `<span class="order-grip">${GRIP}</span><span class="order-name"></span><span class="order-idx">${rows.length - i}</span>`;
      row.querySelector('.order-name').textContent = inst.name;
      row.addEventListener('pointerdown', ev => onDown(ev, row, inst));
      list.appendChild(row);
    });
  }

  function signature() {
    return activeTab + '|' + instances.map(i => i.id + ':' + i.name).join(',') + '|' + selection.join(',');
  }

  // Keep in sync with whatever else changes the canvas (drop, delete, undo, + / -, selection).
  function watch() {
    panel.hidden = activeTab !== 'preview';
    if (!drag) {
      const sig = signature();
      if (sig !== lastSig) { lastSig = sig; render(); }
    }
    requestAnimationFrame(watch);
  }
  requestAnimationFrame(watch);

  // ---- hold & drag ----
  function onDown(ev, row, inst) {
    if (ev.button !== 0) return;
    const rows = [...list.querySelectorAll('.order-row')];
    drag = {
      row, inst, rows,
      pointerId: ev.pointerId,
      startY: ev.clientY,
      from: rows.indexOf(row),
      to: rows.indexOf(row),
      rowH: row.getBoundingClientRect().height + 4, // + gap
      active: false,
      additive: ev.ctrlKey || ev.shiftKey || ev.metaKey
    };
    // Listen on the window, not the row: capture can be refused (synthetic/pen pointers), and
    // the pointer usually leaves the row while dragging anyway.
    try { row.setPointerCapture(ev.pointerId); } catch (e) { /* fine without capture */ }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
  }

  function onMove(ev) {
    if (!drag) return;
    const dy = ev.clientY - drag.startY;
    if (!drag.active) {
      if (Math.abs(dy) < 4) return;
      drag.active = true;
      drag.row.classList.add('dragging');
      list.classList.add('sorting');
    }
    const n = drag.rows.length;
    const minDy = -drag.from * drag.rowH, maxDy = (n - 1 - drag.from) * drag.rowH;
    const clamped = Math.max(minDy, Math.min(maxDy, dy));
    drag.row.style.transform = `translateY(${clamped}px) scale(1.04)`;
    drag.to = Math.max(0, Math.min(n - 1, drag.from + Math.round(clamped / drag.rowH)));
    drag.rows.forEach((r, i) => {
      if (r === drag.row) return;
      let shift = 0;
      if (drag.to > drag.from && i > drag.from && i <= drag.to) shift = -drag.rowH;
      if (drag.to < drag.from && i < drag.from && i >= drag.to) shift = drag.rowH;
      r.style.transform = shift ? `translateY(${shift}px)` : '';
    });
  }

  function finish(commit) {
    const d = drag;
    drag = null;
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    if (!d.active) return d;

    const settle = () => {
      list.classList.remove('sorting');
      d.rows.forEach(r => { r.style.transform = ''; });
      d.row.classList.remove('dragging');
      d.row.style.transition = '';
      lastSig = ''; // re-render with the new order
    };
    // the dragged row has no transform transition while following the pointer; give it one for
    // the short flight into its slot (or back home)
    d.row.style.transition = 'transform .2s cubic-bezier(.22, 1, .36, 1), box-shadow .2s ease';
    if (commit && d.to !== d.from) {
      // fly the dragged row into its slot, then apply the order
      d.row.style.transform = `translateY(${(d.to - d.from) * d.rowH}px)`;
      const front = ordered();
      const [moved] = front.splice(d.from, 1);
      front.splice(d.to, 0, moved);
      pushUndoSnapshot();
      instances = front.reverse();
      stage.applyLayerOrder(instances.map(i => i.spine));
      setTimeout(() => { settle(); }, 200);
    } else {
      d.row.style.transform = ''; // back to where it was
      setTimeout(settle, 200);
    }
    return d;
  }

  function onUp() {
    const d = finish(true);
    if (d && !d.active) { selectInstance(d.inst.id, d.additive); lastSig = ''; }
  }
  function onCancel() { finish(false); }
  function onKey(e) {
    if (e.key === 'Escape' && drag) { e.preventDefault(); e.stopPropagation(); finish(false); }
  }
})();
