// Lock screen (activation key), Admin panel (manage keys) and the update pill.
// The checking itself happens in the main process — see license.js and updater.js.
(() => {
  const { ipcRenderer, clipboard } = require('electron');

  const call = async (channel, ...args) => {
    const res = await ipcRenderer.invoke(channel, ...args);
    if (res.error) throw new Error(res.error);
    return res.result;
  };
  const el = (tag, attrs = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const c of [].concat(children)) if (c) node.append(c);
    return node;
  };

  // ---- version in brand + title ----
  const version = ipcRenderer.sendSync('get-app-version');
  const brandWhite = document.querySelector('#app-brand .brand-white');
  if (brandWhite) brandWhite.textContent = ` Spine Preview v${version}`;
  document.title = `Spine Preview v${version}`;

  // ---- lock screen ----
  const REASONS = {
    nokey: 'Nhập key kích hoạt mà Mondiro gửi cho bạn để bắt đầu dùng app.',
    invalid: 'Key không đúng. Kiểm tra lại hoặc liên hệ Mondiro.',
    revoked: 'Key của máy này đã bị thu hồi. Liên hệ Mondiro nếu cần dùng tiếp.',
    offline: 'Không kết nối được để kiểm tra key. Hãy kiểm tra mạng rồi thử lại.'
  };

  const lockMsg = el('div', { class: 'lock-msg', text: 'Đang kiểm tra quyền sử dụng...' });
  const keyInput = el('input', { type: 'text', class: 'lock-input', placeholder: 'SPV-XXXX-XXXX-XXXX-XXXX', spellcheck: 'false' });
  const activateBtn = el('button', { class: 'primary-btn', text: 'Kích hoạt' });
  const retryBtn = el('button', { class: 'secondary-btn', text: 'Thử lại' });
  const keyForm = el('div', { class: 'lock-form', hidden: '' }, [keyInput, activateBtn, retryBtn]);
  const lockOverlay = el('div', { id: 'lock-overlay' }, [
    el('div', { class: 'lock-card' }, [
      el('div', { class: 'lock-brand' }, [el('span', { class: 'brand-red', text: 'Mondiro' }), el('span', { class: 'brand-white', text: ' Spine Preview' })]),
      el('div', { class: 'lock-sub', text: `Preview & export animation Spine 3.7.94 · v${version}` }),
      lockMsg,
      keyForm,
      el('button', { class: 'lock-admin-link', text: 'Admin', onclick: () => openAdmin() })
    ]),
    el('div', { class: 'lock-credit', text: 'Created by Mondiro' })
  ]);
  document.body.append(lockOverlay);

  function applyStatus(status) {
    if (status && status.ok) {
      lockOverlay.hidden = true;
      return;
    }
    lockOverlay.hidden = false;
    keyForm.hidden = false;
    lockMsg.textContent = REASONS[(status && status.reason) || 'nokey'] || REASONS.nokey;
    lockMsg.classList.toggle('error', !!status && status.reason !== 'nokey');
    setTimeout(() => keyInput.focus(), 0);
  }

  async function check() {
    try { applyStatus(await call('license-check')); } catch (e) { applyStatus({ ok: false, reason: 'offline' }); }
    refreshAdminButton();
  }

  async function doActivate() {
    activateBtn.disabled = true;
    lockMsg.textContent = 'Đang kiểm tra key...';
    lockMsg.classList.remove('error');
    try { applyStatus(await call('license-activate', keyInput.value)); } catch (e) { applyStatus({ ok: false, reason: 'offline' }); }
    activateBtn.disabled = false;
  }
  activateBtn.addEventListener('click', doActivate);
  keyInput.addEventListener('keydown', e => { if (e.key === 'Enter') doActivate(); e.stopPropagation(); });
  retryBtn.addEventListener('click', check);
  ipcRenderer.on('license-status', (_e, status) => applyStatus(status));

  // ---- top-right buttons: Admin + update pill ----
  const changelogBtn = document.getElementById('changelog-btn');
  const topBar = el('div', { id: 'top-right-bar' });
  changelogBtn.replaceWith(topBar);
  const adminBtn = el('button', { id: 'admin-btn', class: 'top-pill', text: 'Admin', hidden: '', onclick: () => openAdmin() });
  const updatePill = el('button', { id: 'update-pill', class: 'top-pill', hidden: '' });
  topBar.append(updatePill, adminBtn, changelogBtn);

  async function refreshAdminButton() {
    try { adminBtn.hidden = !(await call('admin-status')); } catch (e) { adminBtn.hidden = true; }
  }

  ipcRenderer.on('update-status', (_e, s) => {
    if (s.state === 'downloading') {
      if (s.version) updatePill.dataset.version = s.version;
      updatePill.hidden = false;
      updatePill.disabled = true;
      updatePill.classList.remove('ready');
      updatePill.textContent = `Đang tải v${updatePill.dataset.version || ''}… ${s.percent || 0}%`;
    } else if (s.state === 'ready') {
      updatePill.hidden = false;
      updatePill.disabled = false;
      updatePill.classList.add('ready');
      updatePill.textContent = `Cập nhật v${s.version} ↻`;
      updatePill.title = 'Khởi động lại app để cài bản mới';
    } else if (s.state === 'error' && !updatePill.classList.contains('ready')) {
      updatePill.hidden = true;
    }
  });
  updatePill.addEventListener('click', () => ipcRenderer.send('update-install'));

  // ---- Admin panel ----
  const adminBody = el('div', { class: 'admin-body' });
  const adminMsg = el('div', { class: 'admin-msg' });
  const adminModal = el('div', { id: 'admin-modal', hidden: '' }, [
    el('div', { class: 'admin-card' }, [
      el('div', { class: 'admin-head' }, [
        el('div', { class: 'admin-title', text: 'Quản lý key' }),
        el('button', { class: 'icon-btn', text: '✕', title: 'Đóng', onclick: () => { adminModal.hidden = true; } })
      ]),
      adminMsg,
      adminBody
    ])
  ]);
  document.body.append(adminModal);
  adminModal.addEventListener('keydown', e => e.stopPropagation());

  const setMsg = (text, isError) => {
    adminMsg.textContent = text || '';
    adminMsg.classList.toggle('error', !!isError);
  };
  const busy = async (fn, doneText) => {
    setMsg('Đang lưu lên GitHub...');
    adminModal.classList.add('busy');
    try {
      await fn();
      setMsg(doneText || '');
    } catch (e) {
      setMsg(e.message, true);
    }
    adminModal.classList.remove('busy');
  };

  async function openAdmin() {
    adminModal.hidden = false;
    setMsg('');
    if (await call('admin-status').catch(() => false)) renderList();
    else renderLogin();
  }

  function renderLogin() {
    const tokenInput = el('input', { type: 'password', class: 'lock-input', placeholder: 'github_pat_...' });
    const loginBtn = el('button', { class: 'primary-btn', text: 'Đăng nhập Admin' });
    const login = () => busy(async () => {
      await call('admin-login', tokenInput.value);
      await check();
      renderList();
    });
    loginBtn.addEventListener('click', login);
    tokenInput.addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
    adminBody.replaceChildren(
      el('p', { class: 'admin-hint', text: 'Dán GitHub token có quyền ghi (Contents: Read and write) vào repo Spine_Preview. Token được mã hóa và chỉ lưu trên máy này. Cách tạo token: xem README.' }),
      tokenInput,
      loginBtn
    );
    setTimeout(() => tokenInput.focus(), 0);
  }

  function keyRow(k) {
    const active = k.active !== false;
    const copyBtn = k.key ? el('button', { class: 'text-btn', text: 'Copy key', onclick: () => { clipboard.writeText(k.key); setMsg(`Đã copy key của ${k.name}.`); } }) : null;
    return el('div', { class: 'admin-row' + (active ? '' : ' revoked') }, [
      el('div', { class: 'admin-row-info' }, [
        el('div', { class: 'admin-row-name', text: k.name }),
        el('div', { class: 'admin-row-meta', text: [k.created, k.note, active ? 'Đang dùng' : 'Đã thu hồi'].filter(Boolean).join(' · ') })
      ]),
      copyBtn,
      el('button', {
        class: 'text-btn', text: active ? 'Thu hồi' : 'Mở lại',
        onclick: () => busy(async () => { await call('admin-set-active', k.id, !active); await renderList(); },
          active ? `Đã thu hồi key của ${k.name}. Máy đó sẽ bị khóa trong khoảng 15–20 phút.` : `Đã mở lại key của ${k.name}.`)
      }),
      el('button', {
        class: 'text-btn danger', text: 'Xóa',
        onclick: () => {
          if (!confirm(`Xóa hẳn key của "${k.name}"? Máy đó sẽ bị khóa và key không dùng lại được.`)) return;
          busy(async () => { await call('admin-remove', k.id); await renderList(); }, `Đã xóa key của ${k.name}.`);
        }
      })
    ]);
  }

  async function renderList() {
    const nameInput = el('input', { type: 'text', class: 'lock-input', placeholder: 'Tên đồng nghiệp' });
    const noteInput = el('input', { type: 'text', class: 'lock-input', placeholder: 'Ghi chú (không bắt buộc)' });
    const newKeyBox = el('div', { class: 'admin-newkey', hidden: '' });
    const addBtn = el('button', { class: 'primary-btn', text: '+ Tạo key mới' });
    addBtn.addEventListener('click', () => busy(async () => {
      const name = nameInput.value;
      const { key } = await call('admin-add', name, noteInput.value);
      clipboard.writeText(key);
      await renderList();
      const box = adminBody.querySelector('.admin-newkey');
      box.hidden = false;
      box.replaceChildren(el('div', { text: `Key cho ${name.trim()} (đã copy sẵn, gửi cho họ):` }), el('code', { text: key }));
    }));
    const listEl = el('div', { class: 'admin-list' }, [el('div', { class: 'admin-hint', text: 'Đang tải danh sách...' })]);
    adminBody.replaceChildren(
      el('div', { class: 'admin-add' }, [nameInput, noteInput, addBtn]),
      newKeyBox,
      listEl,
      el('div', { class: 'admin-foot' }, [
        el('span', { class: 'admin-hint', text: 'Lưu ý: tên và ghi chú hiển thị công khai trên GitHub, key thì không.' }),
        el('button', {
          class: 'text-btn', text: 'Đăng xuất Admin',
          onclick: async () => { await call('admin-logout').catch(() => {}); adminModal.hidden = true; check(); }
        })
      ])
    );
    try {
      const keys = await call('admin-list');
      listEl.replaceChildren(...(keys.length ? keys.map(keyRow) : [el('div', { class: 'admin-hint', text: 'Chưa có key nào.' })]));
    } catch (e) {
      listEl.replaceChildren(el('div', { class: 'admin-msg error', text: e.message }));
    }
  }

  // Ctrl+Shift+M opens the Admin panel from anywhere.
  window.addEventListener('keydown', e => {
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'm') { e.preventDefault(); openAdmin(); }
  }, true);

  check();
})();
