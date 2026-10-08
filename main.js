const { app, BrowserWindow, ipcMain, shell, protocol, net } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const { buildInit } = require('./native');

app.commandLine.appendSwitch('enable-features', 'WebRTC');
app.commandLine.appendSwitch('remote-debugging-port', process.env.MUSE_CDP_PORT || '9222');
app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
protocol.registerSchemesAsPrivileged([{ scheme: 'muse', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

let win;
const call = (fn, ...args) => win && win.webContents.send('hatch-call', fn, args);

app.whenReady().then(() => {
  protocol.handle('muse', (req) => {
    const u = new URL(req.url);
    return net.fetch(pathToFileURL(path.join(__dirname, 'hatch', decodeURIComponent(u.pathname))).toString());
  });
  win = new BrowserWindow({
    width: 1100, height: 780, backgroundColor: '#121214', title: 'Muse',
    // --hidden: run with no window so the terminal client can drive it in the background
    show: !process.argv.includes('--hidden'),
    webPreferences: { partition: 'persist:muse', preload: path.join(__dirname, 'preload.js'), contextIsolation: false, sandbox: false, backgroundThrottling: false },
  });
  win.webContents.on('console-message', (_e, lvl, msg) => process.env.MUSE_DEBUG && console.log('[ui]', msg));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  const ua = win.webContents.getUserAgent().replace(/ Electron\/[\d.]+/, '').replace(/ muse-linux\/[\d.]+/, '');
  win.webContents.setUserAgent(ua);
  if (process.argv.includes('--local')) win.loadURL('muse://app/index.html');
  else win.loadURL(process.env.MUSE_URL || 'https://muse.ai/', { userAgent: ua });
  if (process.env.MUSE_SHOT) setTimeout(async () => { require('fs').writeFileSync(process.env.MUSE_SHOT, (await win.webContents.capturePage()).toPNG()); app.quit(); }, 9000);
});

const native = require('./native');
ipcMain.on('native', async (_e, handler, msg) => {
  try { await native.handle({ handler, msg, call, win: () => win, shell, app }); }
  catch (err) { console.error('[native] error', handler, msg && msg.action, err); }
});
app.on('window-all-closed', () => app.quit());
