// Talks to the logged-in muse-linux app over its debug port. The app keeps the
// login and the encrypted gateway; this file calls the same sendRequest and
// onEvent the web UI uses, and forwards live events through a CDP binding.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORTS = [Number(process.env.MUSE_CDP_PORT) || 9333, 9222];
const STATE_FILE = path.join(os.homedir(), '.config', 'muse-term', 'state.json');
const EVENT_NAMES = [
  'agent.status', 'task.status', 'sessions.updated',
  'delta.message_start', 'delta.text_append', 'delta.message_done', 'delta.message_removed',
  'delta.tool_start', 'delta.tool_done',
];
export const CAPABILITIES = ['chat_cancel', 'delta_stream'];

export function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return { byCwd: {} }; }
}
export function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

async function findPage() {
  for (const port of PORTS) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) });
      const page = (await res.json()).find((p) => p.type === 'page' && p.url.startsWith('https://muse.ai'));
      if (page) return page;
    } catch { /* nothing on this port */ }
  }
  return null;
}

export async function ensureApp(onStatus = () => {}) {
  let page = await findPage();
  if (page) return page;
  onStatus('Starting Muse in the background...');
  spawn(path.join(APP_DIR, 'muse'), ['--hidden'], {
    cwd: APP_DIR, detached: true, stdio: 'ignore',
    env: { ...process.env, MUSE_CDP_PORT: String(PORTS[0]) },
  }).unref();
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    page = await findPage();
    if (page) return page;
  }
  throw new Error('Muse app did not start. Run ./muse in the muse-terminal folder once and check that you are logged in.');
}

// The gateway client lives in a React context; walk the tree to find it.
// Looked up again whenever the app reconnects, since the value is replaced.
const FIND_RPC = `(() => {
  const el = [...document.body.children].find(e => Object.keys(e).some(k => k.startsWith('__reactFiber')));
  if (!el) return null;
  let f = el[Object.keys(el).find(k => k.startsWith('__reactFiber'))];
  while (f.return) f = f.return;
  const stack = [f]; let best = null;
  while (stack.length) { const x = stack.pop();
    const v = x.memoizedProps && x.memoizedProps.value;
    if (v && typeof v === 'object' && typeof v.sendRequest === 'function') { best = v; if (v.isReady) break; }
    if (x.sibling) stack.push(x.sibling); if (x.child) stack.push(x.child); }
  return best;
})()`;

const RPC = `((window.__museTerm && window.__museTerm.rpc && window.__museTerm.rpc.isReady) ? window.__museTerm.rpc : ${FIND_RPC})`;

export class Muse extends EventEmitter {
  constructor() {
    super();
    this.id = 0;
    this.pending = new Map();
    this.closed = false;
  }

  async connect(onStatus) {
    const page = await ensureApp(onStatus);
    await new Promise((resolve, reject) => {
      this.ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 1e9 });
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => this.#onMessage(raw));
      this.ws.on('close', () => {
        for (const p of this.pending.values()) p.reject(new Error('Lost connection to the Muse app'));
        this.pending.clear();
        if (!this.closed) this.emit('disconnected');
      });
    });
    await this.#send('Runtime.enable');
    await this.#send('Runtime.addBinding', { name: 'museTermEmit' });
    onStatus?.('Connecting to Muse...');
    const end = Date.now() + 60000;
    while (Date.now() < end) {
      if (await this.#install()) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!this.installed) throw new Error('Muse is not connected. Run ./muse in the muse-terminal folder and check the login.');
    // The app reconnects on its own; when it does, listeners must be re-added.
    this.watch = setInterval(async () => {
      try { if ((await this.#install()) === 'fresh') this.emit('reconnected'); } catch { /* retried next tick */ }
    }, 5000);
  }

  // Adds our listeners to the current gateway client. Returns false when the
  // client is not ready, true when already installed, 'fresh' when (re)added.
  async #install() {
    const result = await this.#evaluate(`(() => {
      const rpc = ${FIND_RPC};
      if (!rpc || !rpc.isReady) return false;
      const t = window.__museTerm;
      if (t && t.rpc === rpc) return true;
      if (t) t.unsubs.forEach(u => { try { u(); } catch {} });
      const unsubs = ${JSON.stringify(EVENT_NAMES)}.map(n => rpc.onEvent(n, p => {
        try { museTermEmit(JSON.stringify([n, p])); } catch {}
      }));
      window.__museTerm = { rpc, unsubs };
      return 'fresh';
    })()`).catch(() => false);
    if (result) this.installed = true;
    return result;
  }

  #onMessage(raw) {
    const m = JSON.parse(raw);
    if (m.id && this.pending.has(m.id)) {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
      return;
    }
    if (m.method === 'Runtime.bindingCalled' && m.params.name === 'museTermEmit') {
      try {
        const [name, payload] = JSON.parse(m.params.payload);
        this.emit('event', name, payload || {});
      } catch { /* malformed event */ }
    }
  }

  #send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async #evaluate(expression) {
    const r = await this.#send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      const ex = r.exceptionDetails.exception;
      throw new Error(((ex && (ex.description || ex.value)) || r.exceptionDetails.text || 'error').toString().split('\n')[0]);
    }
    return r.result.value;
  }

  async call(method, params = {}) {
    const json = await this.#evaluate(`(async () => {
      const r = ${RPC};
      if (!r) throw new Error('Muse UI not loaded');
      return JSON.stringify(await r.sendRequest(${JSON.stringify(method)}, ${JSON.stringify(params)}));
    })()`);
    return JSON.parse(json);
  }

  threads() { return this.call('sessions.list', {}).then((r) => (r.sessions || []).filter((t) => !t.archived)); }

  history(sessionId, limit = 40) {
    return this.call('chat.history', { session_id: sessionId, limit });
  }

  subscribe(sessionId, afterSeq = 0) {
    return this.call('chat.subscribe', {
      session_id: sessionId,
      after_stream_seq: afterSeq,
      after_chat_event_seq: afterSeq,
      capabilities: CAPABILITIES,
    });
  }

  // items: [{type:'text',text}, {type:'image',mime_type,data_base64,filename}]
  send(sessionId, items) {
    const onlyText = items.length === 1 && items[0].type === 'text';
    return this.call('chat.stream', {
      ...(onlyText ? { message: items[0].text } : { items }),
      session_id: sessionId,
      capabilities: CAPABILITIES,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  }

  cancel(sessionId) { return this.call('chat.cancel', { session_id: sessionId }); }

  // Deletes one thread from Muse, the way the app's own delete does: stop any
  // running reply first, then delete, and check the server confirmed it.
  async deleteThread(sessionId) {
    await this.cancel(sessionId).catch(() => {});
    const r = await this.call('session.delete', { method: '/api/session/delete', session_id: sessionId });
    if (!r || r.deleted !== true) throw new Error('Muse did not confirm the delete');
  }

  // Plan and weekly usage. This is a Next.js server action, not a gateway
  // method, and its id changes with each Muse deploy, so it is looked up in the
  // loaded scripts on first use.
  async usage() {
    const raw = await this.#evaluate(`(async () => {
      let id = window.__museTermUsageId;
      if (!id) {
        const urls = [...new Set(performance.getEntriesByType('resource').map(e => e.name).filter(u => /_next\\/static.*\\.js/.test(u)))];
        for (const u of urls) {
          const t = await (await fetch(u)).text();
          const m = t.match(/"([0-9a-f]{40,})"[^)]{0,200}?"fetchSubscriptionAction"/);
          if (m) { id = m[1]; break; }
        }
        if (!id) throw new Error('Could not find the usage call in the Muse app');
        window.__museTermUsageId = id;
      }
      const r = await fetch('/', { method: 'POST', headers: { 'Next-Action': id, Accept: 'text/x-component', 'Content-Type': 'text/plain;charset=UTF-8' }, body: '[{}]' });
      if (!r.ok) { window.__museTermUsageId = null; throw new Error('Usage request failed: HTTP ' + r.status); }
      return r.text();
    })()`);
    const line = raw.split('\n').find((l) => l.startsWith('1:'));
    const data = line && JSON.parse(line.slice(2));
    if (!data || !data.success) throw new Error((data && data.error) || 'Usage is not available');
    return data.subscription;
  }

  async close() {
    this.closed = true;
    clearInterval(this.watch);
    try {
      await this.#evaluate(`(() => { const t = window.__museTerm; if (t) { t.unsubs.forEach(u => { try { u(); } catch {} }); window.__museTerm = null; } return true; })()`);
    } catch { /* app already gone */ }
    try { this.ws.close(); } catch { /* already closed */ }
  }
}

// ---------- helpers shared by the TUI and print mode ----------
export const isMessageEvent = (e) => e.event_name === 'message.user' || e.event_name === 'message.assistant';

export function eventText(e) {
  return (e.display_text || (e.payload && typeof e.payload.content === 'string' ? e.payload.content : '') || '').trim();
}

export function eventDone(e) {
  const status = e.payload && e.payload.status;
  return e.display_text_ready !== false && (status == null || ['completed', 'failed', 'cancelled'].includes(status));
}

// Final text of a delta.message_done payload.
export function doneText(p) {
  const msgs = (p.transcript && p.transcript.messages) || [];
  const parts = [];
  for (const m of msgs) {
    if (m.role && m.role !== 'assistant') continue;
    for (const c of m.content || []) if (c.type === 'text' && c.text) parts.push(c.text);
  }
  return (parts.join('\n\n') || p.display_text || '').trim();
}

// Put in front of the first message Muse gets from this terminal in a thread.
// Muse runs on its own VM, so it has to be told that the folder is on the PC
// and how to reach it, or it answers about its own machine.
export const WORKER = process.env.MUSE_WORKER || os.hostname();
export function contextLine(cwd) {
  return `[Terminal session on my PC (worker ${WORKER}), folder: ${cwd}. `
    + `This folder is on my PC, not on your VM. For anything about files, code or commands here, `
    + `use the ${WORKER} worker through the muse-mcp relay with ${cwd} as the working directory.]`;
}
