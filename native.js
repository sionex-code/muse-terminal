// Linux stand-in for the macOS Swift shell: answers the web UI's bridge calls.
const log = (...a) => console.log('[bridge]', ...a);
const seen = new Set();

function buildInit() {
  return {
    surface: 'full-app', platform: 'linux', nodeId: 'linux-' + require('os').hostname(),
    displayName: require('os').hostname(), calendarEventDetails: false,
    accountSession: null, subscriptionViewerKey: null, layoutViewerKey: null,
    gatewayUrl: undefined, vmName: undefined, vmAuthToken: undefined,
    vms: [], localConnectors: [], attended: true, present: true, cookieSession: false,
  };
}

async function handle({ handler, msg, call, win, shell }) {
  if (handler !== 'endoHatch') { log(handler, JSON.stringify(msg)); return; }
  const a = msg && msg.action;
  if (!seen.has(a)) { seen.add(a); log('action', a, JSON.stringify(msg).slice(0, 200)); }
  switch (a) {
    case 'ready': call('init', buildInit()); break;
    case 'openLink': shell.openExternal(msg.url || msg.href); break;
    default: break;
  }
}
module.exports = { handle, buildInit };
