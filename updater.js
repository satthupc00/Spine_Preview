// ---------------------------------------------------------------------------
// Auto update — installed copies check GitHub Releases of this repo (see "publish" in
// package.json) at startup and every hour. A newer version is downloaded in the background, then
// the user is asked to restart; if they choose "later" it installs on the next quit.
// Only works for copies installed with the Setup .exe (NSIS), not the portable .exe.
// ---------------------------------------------------------------------------
const { app, ipcMain, dialog } = require('electron');

const CHECK_EVERY_MS = 60 * 60 * 1000;

function notesToText(notes) {
  if (!notes) return '';
  const raw = Array.isArray(notes) ? notes.map(n => n.note || '').join('\n') : String(notes);
  return raw.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, '').trim();
}

function initUpdater(getWindow) {
  if (!app.isPackaged) return;
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  const send = status => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('update-status', status);
  };
  const install = () => autoUpdater.quitAndInstall(true, true);

  autoUpdater.on('update-available', info => send({ state: 'downloading', version: info.version, percent: 0 }));
  autoUpdater.on('download-progress', p => send({ state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', async info => {
    send({ state: 'ready', version: info.version });
    const win = getWindow();
    const notes = notesToText(info.releaseNotes);
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      title: 'Có bản cập nhật',
      message: `Spine Preview v${info.version} đã tải xong`,
      detail: (notes ? notes + '\n\n' : '') + 'Khởi động lại app để cập nhật ngay?',
      buttons: ['Cập nhật ngay', 'Để sau'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    });
    if (response === 0) install();
  });
  autoUpdater.on('error', err => {
    console.warn('[updater]', err && err.message);
    send({ state: 'error' });
  });

  ipcMain.on('update-install', install);

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 3000);
  setInterval(check, CHECK_EVERY_MS);
}

module.exports = { initUpdater };
