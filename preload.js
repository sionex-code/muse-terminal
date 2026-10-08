const { ipcRenderer } = require('electron');
const post = (name) => ({ postMessage: (m) => ipcRenderer.send('native', name, m) });
const names = ['endoHatch','endoDataExport','endoGeolocation','endoAccountLogout','endoAppearance','endoLoginAppearance','endoWebAppearance'];
const messageHandlers = {};
for (const n of names) messageHandlers[n] = post(n);
window.webkit = { messageHandlers };
window.__endoBoot = { surface: 'full-app' };
// main -> page: run a call on window.endoHatch
ipcRenderer.on('hatch-call', (_e, fn, args) => {
  const h = window.endoHatch;
  if (h && typeof h[fn] === 'function') h[fn](...args);
  else console.warn('[muse-linux] endoHatch.' + fn + ' unavailable');
});
