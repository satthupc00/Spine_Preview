// ---------------------------------------------------------------------------
// Access keys — who is allowed to use the app.
//
// The list of keys lives in access/keys.json in the GitHub repo (public), so every installed copy
// can read it. Keys are stored there only as SHA-256 hashes, so reading the public file does not
// reveal any usable key. Each installed copy:
//   - asks for a key once, checks it against the list and remembers it,
//   - re-checks the list at startup and every RECHECK_MS while running, and locks itself as soon
//     as its key is revoked (active:false) or deleted,
//   - keeps working offline for up to OFFLINE_GRACE_DAYS since its last successful check,
//   - when its key has a machine limit (maxDevices), signs this machine in to the key's seat list
//     in Firestore; the earliest maxDevices machines may use it, any other gets reason 'full'.
//
// The owner manages the list from the Admin panel inside the app. Admin logs in with a GitHub
// token that can write to the repo; edits are committed straight to access/keys.json through the
// GitHub API. A machine with an admin token saved is always unlocked.
// ---------------------------------------------------------------------------
const { app, ipcMain, net, safeStorage } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OWNER = 'satthupc00';
const REPO = 'Spine_Preview';
const BRANCH = 'main';
const KEYS_PATH = 'access/keys.json';
const RAW_URL = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/${KEYS_PATH}`;
const API = 'https://api.github.com';

const OFFLINE_GRACE_DAYS = 7;
const RECHECK_MS = 15 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10000;
// Firestore project that holds the seat lists (collection spv_seats, one document per key id,
// field devices = { <deviceId>: { name, first, seen } }). Empty = machine limits are off.
const FIREBASE_PROJECT = 'spine-preview';
const SEATS_URL = () => `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/spv_seats`;
const SEEN_EVERY_MS = 12 * 3600 * 1000; // refresh a machine's "last seen" at most this often
const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid typos

const licenseFile = () => path.join(app.getPath('userData'), 'license.json');
const adminFile = () => path.join(app.getPath('userData'), 'admin.dat');
const deviceFile = () => path.join(app.getPath('userData'), 'device.json');

// ---- helpers ---------------------------------------------------------------

function normalizeKey(key) {
  return String(key || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^SPV/, '');
}

function hashKey(key) {
  return crypto.createHash('sha256').update('spine-preview:' + normalizeKey(key)).digest('hex');
}

function generateKey() {
  const bytes = crypto.randomBytes(16);
  let s = '';
  for (let i = 0; i < 16; i++) s += KEY_ALPHABET[bytes[i] % KEY_ALPHABET.length];
  return 'SPV-' + s.match(/.{4}/g).join('-');
}

async function fetchWithTimeout(url, options = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    return await net.fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (e) { return fallback; }
}

function writeJson(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data)); } catch (e) { /* not critical */ }
}

// Admin data (GitHub token + plain keys the admin created) is encrypted with the OS keychain
// (DPAPI on Windows) so it can't be read by copying the file to another machine.
function readAdmin() {
  try {
    const buf = fs.readFileSync(adminFile());
    const text = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf-8');
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

function writeAdmin(data) {
  const text = JSON.stringify(data);
  const buf = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(text) : Buffer.from(text, 'utf-8');
  fs.writeFileSync(adminFile(), buf);
}

// ---- seats: which machines use a key ----------------------------------------

// Stable id for this computer: Windows MachineGuid (survives reinstalling the app), else a random
// id kept in userData. Hashed, so the raw machine id never leaves the computer.
let deviceIdCache = null;
function deviceId() {
  if (deviceIdCache) return deviceIdCache;
  let raw = null;
  if (process.platform === 'win32') {
    try {
      const out = require('child_process').execSync('reg query HKLM\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid', { encoding: 'utf-8', windowsHide: true, timeout: 5000 });
      const m = out.match(/MachineGuid\s+REG_SZ\s+(\S+)/i);
      if (m) raw = m[1];
    } catch (e) { /* fall back to a stored id */ }
  }
  if (!raw) {
    raw = readJson(deviceFile(), {}).id;
    if (!raw) { raw = crypto.randomBytes(16).toString('hex'); writeJson(deviceFile(), { id: raw }); }
  }
  return (deviceIdCache = 'd_' + crypto.createHash('sha256').update('spv-device:' + raw).digest('hex').slice(0, 16));
}

function deviceName() {
  let user = '';
  try { user = os.userInfo().username; } catch (e) { /* no user name */ }
  return [os.hostname(), user].filter(Boolean).join(' · ');
}

const seatsOn = () => !!FIREBASE_PROJECT;

// Firestore document -> [{ id, name, first, seen }] sorted oldest first
function seatDevices(doc) {
  const f = (doc && doc.fields && doc.fields.devices && doc.fields.devices.mapValue && doc.fields.devices.mapValue.fields) || {};
  return Object.entries(f).map(([id, v]) => {
    const g = (v.mapValue && v.mapValue.fields) || {};
    return { id, name: g.name ? g.name.stringValue : '', first: Number((g.first && g.first.integerValue) || 0), seen: Number((g.seen && g.seen.integerValue) || 0) };
  }).sort((a, b) => a.first - b.first);
}

async function readSeat(keyId) {
  const res = await fetchWithTimeout(`${SEATS_URL()}/${keyId}?t=${Date.now()}`, { cache: 'no-store' });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return seatDevices(await res.json());
}

// Write one machine's entry (dev = { name, first, seen }) or remove it (dev = null).
// devId = null clears the whole list.
async function writeSeat(keyId, devId, dev) {
  const field = devId ? `devices.${devId}` : 'devices';
  const fields = devId && dev ? { devices: { mapValue: { fields: { [devId]: { mapValue: { fields: {
    name: { stringValue: String(dev.name || '').slice(0, 80) },
    first: { integerValue: String(dev.first) },
    seen: { integerValue: String(dev.seen) }
  } } } } } } } : {};
  const res = await fetchWithTimeout(`${SEATS_URL()}/${keyId}?updateMask.fieldPaths=${encodeURIComponent(field)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', body: JSON.stringify({ fields })
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
}

// Take (or keep) a seat for this machine. { ok:true } or { ok:false, reason:'full', max }.
// Throws when the seat list can't be reached.
async function claimSeat(entry) {
  const max = Number(entry.maxDevices) || 0;
  if (!seatsOn() || max <= 0) return { ok: true };
  const me = deviceId();
  const devices = await readSeat(entry.id);
  const rank = devices.findIndex(d => d.id === me);
  const now = Date.now();
  if (rank >= 0) {
    // the earliest `max` machines keep the key, so lowering the limit also takes effect
    if (rank >= max) return { ok: false, reason: 'full', max };
    if (now - devices[rank].seen > SEEN_EVERY_MS) writeSeat(entry.id, me, { ...devices[rank], name: deviceName(), seen: now }).catch(() => {});
    return { ok: true };
  }
  if (devices.length >= max) return { ok: false, reason: 'full', max };
  await writeSeat(entry.id, me, { name: deviceName(), first: now, seen: now });
  return { ok: true };
}

// ---- checking this machine's key -------------------------------------------

async function fetchPublicKeyList() {
  // The query string makes the CDN less likely to hand back a stale copy after a revoke.
  const res = await fetchWithTimeout(`${RAW_URL}?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  return Array.isArray(data.keys) ? data.keys : [];
}

let lastStatus = null;

async function checkAccess() {
  const admin = readAdmin();
  if (admin && admin.token) return (lastStatus = { ok: true, mode: 'admin' });

  const store = readJson(licenseFile(), {});
  if (!store.key) return (lastStatus = { ok: false, reason: 'nokey' });

  let keys;
  try {
    keys = await fetchPublicKeyList();
  } catch (e) {
    const graceMs = OFFLINE_GRACE_DAYS * 24 * 3600 * 1000;
    if (store.lastOkAt && Date.now() - store.lastOkAt < graceMs) {
      return (lastStatus = { ok: true, mode: 'offline', name: store.name });
    }
    return (lastStatus = { ok: false, reason: 'offline' });
  }

  const entry = keys.find(k => k.hash === hashKey(store.key));
  if (entry && entry.active !== false) {
    let seat;
    try {
      seat = await claimSeat(entry);
    } catch (e) {
      // seat list unreachable: same offline grace as the key list
      const graceMs = OFFLINE_GRACE_DAYS * 24 * 3600 * 1000;
      if (store.lastOkAt && Date.now() - store.lastOkAt < graceMs) return (lastStatus = { ok: true, mode: 'offline', name: entry.name });
      return (lastStatus = { ok: false, reason: 'offline' });
    }
    if (!seat.ok) {
      writeJson(licenseFile(), { ...store, lastOkAt: 0 });
      return (lastStatus = seat);
    }
    writeJson(licenseFile(), { ...store, lastOkAt: Date.now(), name: entry.name });
    return (lastStatus = { ok: true, mode: 'key', name: entry.name });
  }
  writeJson(licenseFile(), { ...store, lastOkAt: 0 });
  return (lastStatus = { ok: false, reason: entry ? 'revoked' : 'invalid' });
}

async function activate(key) {
  if (!normalizeKey(key)) return { ok: false, reason: 'invalid' };
  let keys;
  try {
    keys = await fetchPublicKeyList();
  } catch (e) {
    return { ok: false, reason: 'offline' };
  }
  const entry = keys.find(k => k.hash === hashKey(key));
  if (!entry) return { ok: false, reason: 'invalid' };
  if (entry.active === false) return { ok: false, reason: 'revoked' };
  let seat;
  try { seat = await claimSeat(entry); } catch (e) { return { ok: false, reason: 'offline' }; }
  if (!seat.ok) return seat;
  writeJson(licenseFile(), { key: key.trim(), lastOkAt: Date.now(), name: entry.name });
  return (lastStatus = { ok: true, mode: 'key', name: entry.name });
}

function isLocked() {
  return !lastStatus || !lastStatus.ok;
}

// ---- admin: editing access/keys.json through the GitHub API -----------------

async function gh(method, url, token, body) {
  const res = await fetchWithTimeout(API + url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json'
    },
    // Without this Chromium serves GitHub's cached copy (max-age=60) right after an edit, so the
    // panel showed stale rows and the next edit failed on an outdated sha.
    cache: 'no-store',
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

function requireToken() {
  const admin = readAdmin();
  if (!admin || !admin.token) throw new Error('Chưa đăng nhập Admin.');
  return admin;
}

async function adminLogin(token) {
  token = String(token || '').trim();
  if (!token) throw new Error('Hãy dán GitHub token.');
  const res = await gh('GET', `/repos/${OWNER}/${REPO}`, token);
  if (res.status === 401) throw new Error('Token không hợp lệ hoặc đã hết hạn.');
  if (!res.ok) throw new Error(`Token không truy cập được repo ${OWNER}/${REPO} (HTTP ${res.status}).`);
  if (res.data.permissions && !res.data.permissions.push) throw new Error('Tài khoản của token này không có quyền ghi vào repo.');
  const prev = readAdmin() || {};
  writeAdmin({ token, plainKeys: prev.plainKeys || {} });
  lastStatus = { ok: true, mode: 'admin' };
  return true;
}

// Logging out forgets the token only; the keys created on this machine stay saved so they can
// still be shown after logging in again.
function adminLogout() {
  const admin = readAdmin();
  if (admin) writeAdmin({ plainKeys: admin.plainKeys || {} });
}

async function readRemoteList(token) {
  const res = await gh('GET', `/repos/${OWNER}/${REPO}/contents/${KEYS_PATH}?ref=${BRANCH}&t=${Date.now()}`, token);
  if (res.status === 404) return { data: { keys: [] }, sha: null };
  if (!res.ok) throw new Error(`Không đọc được danh sách key (HTTP ${res.status}).`);
  const data = JSON.parse(Buffer.from(res.data.content, 'base64').toString('utf-8'));
  if (!Array.isArray(data.keys)) data.keys = [];
  return { data, sha: res.data.sha };
}

// Read-modify-write with the file's sha; if someone else changed it in between, GitHub rejects
// the write (409) and we retry once on the fresh copy.
async function editRemoteList(token, message, mutate) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data, sha } = await readRemoteList(token);
    mutate(data);
    const content = Buffer.from(JSON.stringify(data, null, 2) + '\n', 'utf-8').toString('base64');
    const res = await gh('PUT', `/repos/${OWNER}/${REPO}/contents/${KEYS_PATH}`, token, {
      message, content, branch: BRANCH, ...(sha ? { sha } : {})
    });
    if (res.ok) return data;
    if (res.status !== 409 && res.status !== 422) throw new Error(`Không lưu được lên GitHub (HTTP ${res.status}).`);
  }
  throw new Error('Danh sách vừa bị sửa ở nơi khác, hãy thử lại.');
}

function withPlainKeys(keys) {
  const plainKeys = (readAdmin() || {}).plainKeys || {};
  return keys.map(k => ({ ...k, key: plainKeys[k.id] || null }));
}

function rememberKey(id, key) {
  const admin = readAdmin() || {};
  const plainKeys = { ...(admin.plainKeys || {}) };
  if (key) plainKeys[id] = key; else delete plainKeys[id];
  writeAdmin({ ...admin, plainKeys });
}

// All seat lists at once: { <keyId>: [devices] }, or null when machine limits are off / unreachable.
async function readAllSeats() {
  if (!seatsOn()) return null;
  try {
    const res = await fetchWithTimeout(`${SEATS_URL()}?pageSize=300&t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    const out = {};
    (data.documents || []).forEach(d => { out[d.name.split('/').pop()] = seatDevices(d); });
    return out;
  } catch (e) {
    return null;
  }
}

// Key rows for the Admin panel, each with devices: [...] (or null when limits are off).
async function withSeats(keys) {
  const seats = await readAllSeats();
  return withPlainKeys(keys).map(k => ({ ...k, devices: seats ? (seats[k.id] || []) : null }));
}

async function adminList() {
  const admin = requireToken();
  const { data } = await readRemoteList(admin.token);
  return withSeats(data.keys);
}

function parseMax(n) {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v > 0 ? Math.min(v, 99) : 0;
}

async function adminSetMax(id, maxDevices) {
  const admin = requireToken();
  const max = parseMax(maxDevices);
  const data = await editRemoteList(admin.token, `Access: giới hạn số máy key ${id}`, d => {
    const k = d.keys.find(x => x.id === id);
    if (!k) throw new Error('Không tìm thấy key này nữa.');
    if (max) k.maxDevices = max; else delete k.maxDevices;
  });
  return withSeats(data.keys);
}

async function adminRemoveDevice(keyId, devId) {
  const admin = requireToken();
  if (!seatsOn()) throw new Error('Chưa kết nối Firebase.');
  await writeSeat(keyId, devId, null).catch(e => { throw new Error('Không gỡ được máy (' + e.message + ').'); });
  const { data } = await readRemoteList(admin.token);
  return withSeats(data.keys);
}

async function adminAdd(name, note, maxDevices) {
  const admin = requireToken();
  name = String(name || '').trim();
  if (!name) throw new Error('Hãy nhập tên người dùng.');
  const key = generateKey();
  const id = 'k_' + crypto.randomBytes(4).toString('hex');
  const data = await editRemoteList(admin.token, `Access: thêm key cho ${name}`, d => {
    d.keys.push({
      id, name, note: String(note || '').trim(), hash: hashKey(key), active: true,
      created: new Date().toISOString().slice(0, 10),
      ...(parseMax(maxDevices) ? { maxDevices: parseMax(maxDevices) } : {})
    });
  });
  rememberKey(id, key);
  return { id, key, keys: await withSeats(data.keys) };
}

// Gives an existing person a fresh key (their old key stops working). Used when the old key
// wasn't saved on this machine and can't be shown any more.
async function adminRegenerate(id) {
  const admin = requireToken();
  const key = generateKey();
  const data = await editRemoteList(admin.token, `Access: đổi key ${id}`, d => {
    const k = d.keys.find(x => x.id === id);
    if (!k) throw new Error('Không tìm thấy key này nữa.');
    k.hash = hashKey(key);
    k.active = true;
  });
  rememberKey(id, key);
  if (seatsOn()) await writeSeat(id, null, null).catch(() => {}); // new key = start with no machines
  return { key, keys: await withSeats(data.keys) };
}

async function adminSetActive(id, active) {
  const admin = requireToken();
  const data = await editRemoteList(admin.token, `Access: ${active ? 'mở lại' : 'thu hồi'} key ${id}`, d => {
    const k = d.keys.find(x => x.id === id);
    if (k) k.active = !!active;
  });
  return withSeats(data.keys);
}

async function adminRemove(id) {
  const admin = requireToken();
  const data = await editRemoteList(admin.token, `Access: xóa key ${id}`, d => {
    d.keys = d.keys.filter(x => x.id !== id);
  });
  rememberKey(id, null);
  if (seatsOn()) await writeSeat(id, null, null).catch(() => {});
  return withSeats(data.keys);
}

// ---- wiring ----------------------------------------------------------------

// Wrap handlers so errors reach the renderer as { error } instead of a rejected invoke.
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try { return { result: await fn(...args) }; } catch (err) { return { error: err.message || String(err) }; }
  });
}

function initLicense(getWindow) {
  handle('license-check', () => checkAccess());
  handle('license-activate', key => activate(key));
  handle('admin-status', () => !!(readAdmin() || {}).token);
  handle('admin-login', token => adminLogin(token));
  handle('admin-logout', () => { adminLogout(); return checkAccess(); });
  handle('admin-list', () => adminList());
  handle('admin-add', (name, note, max) => adminAdd(name, note, max));
  handle('admin-set-max', (id, max) => adminSetMax(id, max));
  handle('admin-remove-device', (keyId, devId) => adminRemoveDevice(keyId, devId));
  handle('admin-seats-on', () => seatsOn());
  handle('admin-set-active', (id, active) => adminSetActive(id, active));
  handle('admin-remove', id => adminRemove(id));
  handle('admin-regenerate', id => adminRegenerate(id));

  setInterval(async () => {
    const status = await checkAccess();
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('license-status', status);
  }, RECHECK_MS);
}

module.exports = { initLicense, isLocked, hashKey, normalizeKey, generateKey };
