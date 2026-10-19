// ---------------------------------------------------------------------------
// App shell UI shared by every screen (Mondiro m-skill §2b, §5, §6.1):
//   - header "latest" badge + icon-only update button (refresh-cw)
//   - in-app update modal (never the OS dialog): notes, "Để sau", progress button
//   - toast (bottom centre) and confirm modal (replaces window.confirm)
//   - "Thả để mở" dashed overlay while files are dragged over a drop zone
// Exposed as window.MondiroUI = { toast, confirm }.
// ---------------------------------------------------------------------------
(() => {
  const { ipcRenderer } = require('electron');
  const call = async (channel, ...args) => {
    const res = await ipcRenderer.invoke(channel, ...args);
    if (res && res.error) throw new Error(res.error);
    return res ? res.result : null;
  };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const ICON_REFRESH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>';
  const ICON_SPARKLES = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.13-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.13a.5.5 0 0 1 .96 0L14.06 8.5A2 2 0 0 0 15.5 9.94l6.13 1.58a.5.5 0 0 1 0 .96L15.5 14.06a2 2 0 0 0-1.44 1.44l-1.58 6.13a.5.5 0 0 1-.96 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/></svg>';

  const version = ipcRenderer.sendSync('get-app-version');
  document.documentElement.classList.add('electron');
  const nameEl = document.querySelector('.brand-name');
  if (nameEl) nameEl.title = `Mondiro Spine Preview v${version}`;

  // ---- toast ----
  let toastTimer = null;
  function toast(message, ms = 2600) {
    let t = document.getElementById('app-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'app-toast';
      t.className = 'toast';
      t.setAttribute('role', 'status');
      document.body.append(t);
    }
    t.textContent = message;
    t.classList.remove('show');
    void t.offsetWidth; // restart the slide-in
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }

  // ---- confirm modal (Promise<boolean>) ----
  function confirmDialog({ title, message, okText = 'Đồng ý', cancelText = 'Huỷ', danger = false }) {
    return new Promise(resolve => {
      const back = document.createElement('div');
      back.className = 'mdl-back';
      back.innerHTML = `<div class="mdl-card" role="alertdialog" aria-modal="true">
        <div class="mdl-title">${esc(title)}</div>
        ${message ? `<div class="mdl-msg">${esc(message)}</div>` : ''}
        <div class="mdl-actions"><button class="mdl-cancel">${esc(cancelText)}</button><button class="mdl-ok${danger ? ' danger' : ''}">${esc(okText)}</button></div>
      </div>`;
      const done = ok => {
        document.removeEventListener('keydown', onKey, true);
        back.classList.add('closing');
        setTimeout(() => back.remove(), 160);
        resolve(ok);
      };
      const onKey = e => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); done(true); }
      };
      back.querySelector('.mdl-cancel').onclick = () => done(false);
      back.querySelector('.mdl-ok').onclick = () => done(true);
      back.addEventListener('mousedown', e => { if (e.target === back) done(false); });
      document.addEventListener('keydown', onKey, true);
      document.body.append(back);
      back.querySelector('.mdl-ok').focus();
    });
  }

  // ---- header: latest badge + update button ----
  const latestEl = document.createElement('span');
  latestEl.className = 'latest-pill';
  latestEl.textContent = 'latest';
  latestEl.hidden = true;
  if (nameEl) nameEl.append(latestEl);
  const setLatest = on => {
    if (latestEl.hidden === !on) return;
    latestEl.hidden = !on;
    if (on) { latestEl.classList.remove('pop'); void latestEl.offsetWidth; latestEl.classList.add('pop'); }
  };

  const updBtn = document.createElement('button');
  updBtn.type = 'button';
  updBtn.className = 'ibtn upd';
  updBtn.innerHTML = ICON_REFRESH;
  const setUpdBtn = (cls, tip) => {
    updBtn.classList.remove('checking', 'ok', 'news', 'fail');
    if (cls) updBtn.classList.add(cls);
    const t = 'Kiểm tra cập nhật' + (tip ? ' · ' + tip : '');
    updBtn.title = t;
    updBtn.setAttribute('aria-label', t);
  };
  setUpdBtn(null, `đang dùng v${version}`);
  (document.getElementById('top-tools') || document.body).append(updBtn);

  // ---- update modal ----
  const upd = { state: 'idle', version: null, notes: [], percent: 0 };
  let modal = null;

  function renderModal() {
    if (!modal) return;
    modal.querySelector('.upd-title-text').textContent = `Có bản mới ${upd.version || ''}`;
    const notesEl = modal.querySelector('.upd-notes');
    notesEl.innerHTML = upd.notes.length
      ? '<ul>' + upd.notes.map(n => `<li>${esc(n)}</li>`).join('') + '</ul>'
      : '<div class="upd-notes-empty">Bản cập nhật này không có ghi chú.</div>';
    const go = modal.querySelector('.upd-go');
    const label = go.querySelector('span');
    go.classList.toggle('ready', upd.state === 'ready');
    go.classList.toggle('failed', upd.state === 'error');
    go.querySelector('.bar').style.width = (upd.state === 'downloading' ? upd.percent : upd.state === 'ready' ? 100 : 0) + '%';
    if (upd.state === 'ready') label.textContent = 'Cập nhật ngay · khởi động lại';
    else if (upd.state === 'error') label.textContent = 'Tải lỗi · thử lại';
    else label.textContent = `Đang tải ${upd.percent || 0}%`;
  }

  function openModal() {
    if (modal) { renderModal(); return; }
    modal = document.createElement('div');
    modal.className = 'upd-back';
    modal.innerHTML = `<div class="upd-card" role="dialog" aria-modal="true" aria-labelledby="upd-title">
      <div class="upd-title" id="upd-title">${ICON_SPARKLES}<span class="upd-title-text"></span></div>
      <div class="upd-sub">Bạn đang dùng bản ${esc(version)}. Json đang mở và cài đặt được giữ nguyên khi cập nhật.</div>
      <div class="upd-notes"></div>
      <div class="upd-actions"><button class="upd-later">Để sau</button><button class="upd-go"><i class="bar"></i><span></span></button></div>
    </div>`;
    modal.querySelector('.upd-later').onclick = closeModal;
    modal.querySelector('.upd-go').onclick = () => {
      if (upd.state === 'ready') ipcRenderer.send('update-install');
      else if (upd.state === 'error') { upd.state = 'downloading'; upd.percent = 0; renderModal(); ipcRenderer.send('update-retry'); }
    };
    modal.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); e.stopPropagation(); });
    document.body.append(modal);
    renderModal();
    modal.querySelector('.upd-later').focus();
  }
  function closeModal() {
    if (!modal) return;
    const m = modal;
    modal = null;
    m.classList.add('closing');
    setTimeout(() => m.remove(), 160);
  }

  ipcRenderer.on('update-status', (_e, s) => {
    if (s.version) upd.version = s.version;
    if (Array.isArray(s.notes)) upd.notes = s.notes;
    if (s.state === 'available') {
      upd.state = 'downloading'; upd.percent = 0;
      setLatest(false);
      setUpdBtn('news', `có bản ${upd.version}, đang tải`);
      openModal();
    } else if (s.state === 'downloading') {
      upd.state = 'downloading'; upd.percent = s.percent || 0;
      setLatest(false);
      setUpdBtn('news', `đang tải bản ${upd.version || ''} ${upd.percent}%`);
    } else if (s.state === 'ready') {
      upd.state = 'ready';
      setLatest(false);
      setUpdBtn('news', `bản ${upd.version} đã tải xong, bấm để cập nhật`);
      openModal();
    } else if (s.state === 'error') {
      if (upd.state === 'downloading') { upd.state = 'error'; setUpdBtn('fail', 'tải bản mới bị lỗi, bấm để thử lại'); }
    }
    renderModal();
  });

  updBtn.addEventListener('click', async () => {
    // A download already running / finished: just bring the modal back.
    if (upd.state === 'downloading' || upd.state === 'ready' || upd.state === 'error') { openModal(); return; }
    if (updBtn.classList.contains('checking')) return;
    setUpdBtn('checking', 'đang kiểm tra…');
    let r;
    try { r = await call('update-check-now'); } catch (e) { r = { state: 'error' }; }
    if (!r || r.state === 'error') {
      setUpdBtn('fail', 'không kiểm tra được, thử lại sau');
      toast('Không kiểm tra được cập nhật, thử lại sau');
    } else if (r.state === 'latest') {
      setLatest(true);
      setUpdBtn('ok', 'đã là bản mới nhất');
      toast(`Đã là bản mới nhất (v${version})`);
    } else {
      setLatest(false);
      setUpdBtn('news', `có bản ${r.version}`);
      // Installed copies get 'available' from electron-updater and open the modal themselves;
      // a dev run (npm start) can't download, so just say so.
      if (!r.canDownload) toast(`Có bản ${r.version} trên GitHub (bản chạy thử không tự cập nhật)`);
    }
  });

  // initial + hourly "latest" badge
  const refreshLatest = async () => {
    if (upd.state !== 'idle') return;
    try {
      const latest = await call('check-latest');
      if (latest === true) { setLatest(true); setUpdBtn('ok', 'đã là bản mới nhất'); }
      else if (latest === false) setLatest(false);
    } catch (e) { /* offline: keep state */ }
  };
  refreshLatest();
  setInterval(refreshLatest, 60 * 60 * 1000);

  // ---- "Thả để mở" overlay while files are dragged over a drop zone ----
  function wireDropZone(el, label) {
    if (!el) return;
    const ov = document.createElement('div');
    ov.className = 'drop-over';
    ov.textContent = label;
    el.append(ov);
    const hasFiles = e => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    el.addEventListener('dragenter', e => { if (hasFiles(e)) el.classList.add('file-over'); });
    el.addEventListener('dragover', e => { if (hasFiles(e)) el.classList.add('file-over'); });
    el.addEventListener('dragleave', e => { if (!e.relatedTarget || !el.contains(e.relatedTarget)) el.classList.remove('file-over'); });
    el.addEventListener('drop', () => el.classList.remove('file-over'), true);
  }
  wireDropZone(document.getElementById('preview-canvas-wrap'), 'Thả để mở');
  wireDropZone(document.getElementById('json-list-wrap'), 'Thả để thêm vào Json List');
  window.addEventListener('dragend', () => document.querySelectorAll('.file-over').forEach(n => n.classList.remove('file-over')));

  window.MondiroUI = { toast, confirm: confirmDialog };
})();
