const { app, BrowserWindow, ipcMain, dialog, protocol } = require('electron');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Changes Log — lives in changelog.txt (plain text, not in the code) so it can be edited by hand
// without touching any .js file. One entry per line: "version | ghi chú", oldest first (append new
// entries at the end). Lines starting with # or blank lines are ignored (comments/spacing).
// In a packaged build the file is copied next to the app (via package.json's extraResources) so it
// stays editable after install too, instead of being locked inside app.asar.
// ---------------------------------------------------------------------------
function changelogFilePath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'changelog.txt')
    : path.join(__dirname, 'changelog.txt');
}

function loadChangelog() {
  let text;
  try {
    text = fs.readFileSync(changelogFilePath(), 'utf-8');
  } catch (e) {
    return [];
  }
  return text.split(/\r\n|\r|\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      const sep = line.indexOf('|');
      if (sep === -1) return { version: '', notes: line };
      return { version: line.slice(0, sep).trim(), notes: line.slice(sep + 1).trim() };
    });
}

function showChangelog() {
  const entries = loadChangelog();
  const detail = entries.length
    ? entries.map(c => c.version ? `v${c.version}: ${c.notes}` : c.notes).join('\n')
    : `Không đọc được file changelog.txt (${changelogFilePath()})`;
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Changes Log',
    message: 'Spine Preview — Nhật ký cập nhật',
    detail,
    buttons: ['Đóng'],
    noLink: true
  });
}

// Changes Log now lives in the app's own GUI (top-right, next to the brand text) instead of the
// OS menu bar, so the renderer asks for it over IPC — see the 'show-changelog' handler below and
// the #changelog-btn click listener in renderer.js.
ipcMain.on('show-changelog', () => showChangelog());

// Without this, Windows groups the app under Electron's own identity and the taskbar hover
// tooltip / grouping shows "Electron" instead of the app's real name — happens both in dev
// (`npm start`, running electron.exe directly) and, less obviously, in some packaged builds if
// this is left unset. Must be called before `app` is ready, and must match build.appId in
// package.json so a packaged build and a dev run are recognized as the same app.
if (process.platform === 'win32') {
  app.setAppUserModelId('com.mondiro.spinepreview');
}
app.setName('Spine Preview');

// ---------------------------------------------------------------------------
// spine-asset:// — a real hierarchical URL scheme pointing at files on disk.
//
// PIXI's Spine loader resolves the atlas's page image (the ".png" line inside the .atlas) as a
// path RELATIVE to the atlas's own URL. data: and blob: URLs have no directory structure, so that
// resolution fails with them; a custom scheme keeps the folder layout intact and everything just
// works. Registering it as `standard` is what makes relative resolution behave.
// ---------------------------------------------------------------------------
const ASSET_SCHEME = 'spine-asset';

const MIME_BY_EXT = {
  '.json': 'application/json',
  '.atlas': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp'
};

protocol.registerSchemesAsPrivileged([{
  scheme: ASSET_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true, stream: true }
}]);

function installAssetProtocol() {
  protocol.handle(ASSET_SCHEME, async (request) => {
    const cors = { 'Access-Control-Allow-Origin': '*' };
    try {
      let filePath = decodeURIComponent(new URL(request.url).pathname);
      // On Windows the path arrives as /C:/folder/file.png — drop the leading slash so fs can
      // resolve the drive letter.
      if (/^\/[A-Za-z]:\//.test(filePath)) filePath = filePath.slice(1);
      const bytes = await fs.promises.readFile(filePath);
      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: { ...cors, 'Content-Type': MIME_BY_EXT[path.extname(filePath).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' }
      });
    } catch (err) {
      return new Response('Not found', { status: 404, headers: { ...cors, 'Content-Type': 'text/plain; charset=utf-8', 'X-Asset-Error': String(err && err.message) } });
    }
  });
}

const STATE_FILE = path.join(app.getPath('userData'), 'window-state.json');
const MIN_WIDTH = 800;
const MIN_HEIGHT = 600;

function loadWindowState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    const state = JSON.parse(raw);
    return {
      width: Math.max(state.width || 1200, MIN_WIDTH),
      height: Math.max(state.height || 800, MIN_HEIGHT),
      x: state.x,
      y: state.y
    };
  } catch (e) {
    return { width: 1200, height: 800 };
  }
}

function saveWindowState(win) {
  if (!win || win.isDestroyed()) return;
  const bounds = win.getBounds();
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(bounds));
  } catch (e) {
    // ignore write failures — not critical
  }
}

let mainWindow;

function createWindow() {
  const state = loadWindowState();
  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    title: 'Spine Preview',
    backgroundColor: '#12181f',
    // Changes Log lives in the app's own GUI now, not the OS menu bar, so the menu bar goes back
    // to auto-hiding behind Alt like before. F12 still opens DevTools (wired below) when something
    // needs diagnosing on someone else's machine.
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webSecurity: false
    }
  });

  mainWindow.loadFile('index.html');

  let saveTimer = null;
  const scheduleSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveWindowState(mainWindow), 300);
  };
  mainWindow.on('resize', scheduleSave);
  mainWindow.on('move', scheduleSave);
  mainWindow.on('close', () => saveWindowState(mainWindow));
}

app.whenReady().then(() => {
  installAssetProtocol();
  createWindow();
});

// F12 / Ctrl+Shift+I stay available in the packaged app so a user can copy console errors.
app.on('browser-window-created', (_e, win) => {
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const devtools = input.key === 'F12'
      || (input.control && input.shift && input.key.toLowerCase() === 'i');
    if (devtools) {
      win.webContents.toggleDevTools();
      event.preventDefault();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ---- IPC: choose output folder ----
ipcMain.handle('choose-output-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// ---- IPC: export a PNG from a dataURL ----
ipcMain.handle('export-png', async (event, { outputRoot, subFolder, fileName, dataUrl }) => {
  try {
    const dir = path.join(outputRoot, subFolder);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, fileName.endsWith('.png') ? fileName : fileName + '.png');
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
    return { ok: true, filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
