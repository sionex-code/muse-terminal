// Full screen chat UI for Muse, built with Ink (React for the terminal).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { render, measureElement, Box, Text, useApp, useInput, useStdout } from 'ink';
import chalk from 'chalk';
import wrapAnsi from 'wrap-ansi';
import stringWidth from 'string-width';
import Spinner from 'ink-spinner';
import gradient from 'gradient-string';
import { Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import {
  Muse, loadState, saveState, isMessageEvent, eventText, eventDone, doneText, contextLine, WORKER,
} from './bridge.mjs';

const h = React.createElement;
const ACCENT = '#c084fc';
const ACCENT2 = '#f472b6';
const museGradient = gradient(['#8b5cf6', '#c084fc', '#f472b6', '#fb923c']);

const LOGO = [
  '███╗   ███╗██╗   ██╗███████╗███████╗',
  '████╗ ████║██║   ██║██╔════╝██╔════╝',
  '██╔████╔██║██║   ██║███████╗█████╗  ',
  '██║╚██╔╝██║██║   ██║╚════██║██╔══╝  ',
  '██║ ╚═╝ ██║╚██████╔╝███████║███████╗',
  '╚═╝     ╚═╝ ╚═════╝ ╚══════╝╚══════╝',
].join('\n');

const COMMANDS = [
  ['/new', 'start a new thread'],
  ['/resume', 'pick an earlier conversation to continue'],
  ['/switch', 'switch to another thread (same as /resume)'],
  ['/history', 'show older messages of this thread'],
  ['/clear', 'clear the screen and start a new thread'],
  ['/delete', 'delete this thread from Muse (asks first)'],
  ['/usage', 'plan, weekly usage and when it resets'],
  ['/image', 'attach an image file: /image <path>'],
  ['/paste', 'attach the image on the clipboard (or ctrl+v)'],
  ['/cancel', 'stop the current reply (or esc)'],
  ['/id', 'show this thread\'s session id'],
  ['/help', 'show keys and commands'],
  ['/quit', 'exit (or ctrl+d)'],
];

const IMAGE_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
// One SGR mouse report, with or without the leading escape character.
const MOUSE_RE = /\x1b?\[<\d+;\d+;\d+[Mm]/g;

// ---------- markdown ----------
const markedByWidth = new Map();
function md(text, width) {
  const w = Math.max(40, Math.min(width, 120));
  if (!markedByWidth.has(w)) {
    markedByWidth.set(w, new Marked(markedTerminal({ width: w, reflowText: true, tab: 2, showSectionPrefix: false })));
  }
  try {
    return markedByWidth.get(w).parse(text).replace(/\n+$/, '');
  } catch {
    return text;
  }
}

// ---------- attachments ----------
const kb = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function imageFromFile(file) {
  const ext = path.extname(file).toLowerCase();
  const mime = IMAGE_EXT[ext];
  if (!mime) throw new Error(`Not an image: ${file}`);
  const buf = fs.readFileSync(file);
  if (buf.length > MAX_IMAGE_BYTES) throw new Error(`Image is ${kb(buf.length)}, the limit is ${kb(MAX_IMAGE_BYTES)}`);
  return { filename: path.basename(file), mime, base64: buf.toString('base64'), size: buf.length };
}

function imageFromClipboard() {
  const run = (cmd, args) => execFileSync(cmd, args, { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  let buf = null;
  if (process.env.WAYLAND_DISPLAY) {
    try { buf = run('wl-paste', ['--type', 'image/png']); } catch { /* fall through to xclip */ }
  }
  if (!buf) {
    let targets = '';
    try { targets = run('xclip', ['-selection', 'clipboard', '-t', 'TARGETS', '-o']).toString(); } catch { /* none */ }
    const type = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].find((t) => targets.includes(t));
    if (!type) throw new Error('No image on the clipboard');
    buf = run('xclip', ['-selection', 'clipboard', '-t', type, '-o']);
  }
  if (!buf || !buf.length) throw new Error('No image on the clipboard');
  if (buf.length > MAX_IMAGE_BYTES) throw new Error(`Image is ${kb(buf.length)}, the limit is ${kb(MAX_IMAGE_BYTES)}`);
  return { filename: `pasted-${Date.now()}.png`, mime: 'image/png', base64: buf.toString('base64'), size: buf.length };
}

// A pasted chunk that is just a path to an image (drag and drop) becomes an attachment.
function pastedImagePath(chunk) {
  let p = chunk.trim().replace(/^['"]|['"]$/g, '');
  if (p.startsWith('file://')) p = decodeURIComponent(p.slice(7));
  if (p.startsWith('~/')) p = path.join(os.homedir(), p.slice(2));
  if (!IMAGE_EXT[path.extname(p).toLowerCase()]) return null;
  try { return fs.statSync(p).isFile() ? p : null; } catch { return null; }
}

// ---------- chat area as plain lines ----------
// The chat area is drawn from ready made lines so it can scroll inside a fixed
// screen. Each item becomes an array of styled strings no wider than `width`.
const wrapLines = (text, width) => wrapAnsi(text, Math.max(10, width), { hard: true, trim: false }).split('\n');
const pad = (str, width) => str + ' '.repeat(Math.max(0, width - stringWidth(str)));
const accent = chalk.hex(ACCENT);
const accent2 = chalk.hex(ACCENT2);

function logoLines({ cwd, version }, width) {
  const w = Math.max(40, width);
  const inner = w - 4;
  const logo = museGradient.multiline(LOGO).split('\n');
  const details = [
    chalk.bold('Welcome to ') + accent.bold('Muse') + chalk.dim(`  ${version}`),
    chalk.dim('your Muse agent, in the terminal'),
    '',
    chalk.dim('folder  ') + cwd.replace(os.homedir(), '~'),
    chalk.dim('pc      ') + `${os.hostname()} via ${WORKER}`,
    '',
    accent2('/ ') + chalk.dim('commands   ') + accent2('ctrl+v ') + chalk.dim('image   ') + accent2('esc ') + chalk.dim('stop'),
  ];
  let body;
  if (inner >= 86) body = logo.map((l, i) => l + '    ' + (details[i] || '')).concat(details.slice(logo.length).map((d) => ' '.repeat(40) + d));
  else body = [...logo, '', ...details];
  const border = (s) => accent(s);
  const out = [border('╭' + '─'.repeat(w - 2) + '╮'), border('│') + ' '.repeat(w - 2) + border('│')];
  for (const line of body) for (const l of wrapLines(line, inner - 2)) out.push(border('│') + '  ' + pad(l, inner - 2) + '  ' + border('│'));
  out.push(border('│') + ' '.repeat(w - 2) + border('│'), border('╰' + '─'.repeat(w - 2) + '╯'));
  const credit = chalk.dim('coded by ') + gradient(['#f472b6', '#fb923c'])('WebMarkaz team');
  out.push(' '.repeat(Math.max(0, w - stringWidth(credit) - 1)) + credit, '');
  return out;
}

function itemLines(item, width) {
  switch (item.kind) {
    case 'logo': return logoLines(item, width);
    case 'user': {
      const out = wrapLines(item.text, width - 2).map((l, i) => (i === 0 ? accent2.bold('› ') : '  ') + chalk.white(l));
      if (item.images && item.images.length) out.push('  ' + chalk.cyan(item.images.map((im) => `[image ${im.filename} ${kb(im.size)}]`).join(' ')));
      out.push('');
      return out;
    }
    case 'assistant': {
      const out = [accent.bold('◆ Muse') + (item.time ? chalk.dim(`  ${item.time}`) : '')];
      for (const l of md(item.text, width - 2).split('\n')) for (const w of wrapLines(l, width - 2)) out.push('  ' + w);
      if (item.attachments > 0) out.push('  ' + chalk.dim(`[${item.attachments} attachment${item.attachments > 1 ? 's' : ''}, open the thread in the app to see ${item.attachments > 1 ? 'them' : 'it'}]`));
      out.push('');
      return out;
    }
    case 'error': return [...wrapLines(chalk.red(item.text), width), ''];
    default: return [...wrapLines(chalk.dim(item.text), width), ''];
  }
}

// ---------- pieces ----------
// Welcome card: logo on the left, session details on the right, full width.
function Logo({ cwd, version, width }) {
  const w = Math.max(40, (width || 100) - 2);
  const side = w >= 90;
  const details = h(Box, { flexDirection: 'column', marginLeft: side ? 4 : 0, marginTop: side ? 0 : 1 },
    h(Text, { bold: true }, 'Welcome to ', h(Text, { color: ACCENT, bold: true }, 'Muse'), h(Text, { dimColor: true }, `  ${version}`)),
    h(Text, { dimColor: true }, 'your Muse agent, in the terminal'),
    h(Text, null, ' '),
    h(Text, null, h(Text, { dimColor: true }, 'folder  '), cwd.replace(os.homedir(), '~')),
    h(Text, null, h(Text, { dimColor: true }, 'pc      '), `${os.hostname()} via ${WORKER}`),
    h(Text, null, ' '),
    h(Text, null, h(Text, { color: ACCENT2 }, '/ '), h(Text, { dimColor: true }, 'commands   '), h(Text, { color: ACCENT2 }, 'ctrl+v '), h(Text, { dimColor: true }, 'image   '), h(Text, { color: ACCENT2 }, 'esc '), h(Text, { dimColor: true }, 'stop')));
  return h(Box, { flexDirection: 'column', marginBottom: 1, width: w },
    h(Box, { borderStyle: 'round', borderColor: ACCENT, paddingX: 2, paddingY: 1, flexDirection: side ? 'row' : 'column', width: w },
      h(Text, null, museGradient.multiline(LOGO)),
      details),
    h(Box, { justifyContent: 'flex-end', width: w, paddingRight: 1 },
      h(Text, { dimColor: true }, 'coded by '),
      h(Text, null, gradient(['#f472b6', '#fb923c'])('WebMarkaz team'))));
}

function UserMsg({ item }) {
  return h(Box, { flexDirection: 'column', marginBottom: 1 },
    h(Box, null,
      h(Text, { color: ACCENT2, bold: true }, '› '),
      h(Text, { color: 'white' }, item.text)),
    item.images && item.images.length > 0 && h(Box, { marginLeft: 2 },
      h(Text, { color: 'cyan' }, item.images.map((im) => `[image ${im.filename} ${kb(im.size)}]`).join(' '))));
}

function AssistantMsg({ item, width }) {
  return h(Box, { flexDirection: 'column', marginBottom: 1 },
    h(Box, null,
      h(Text, { color: ACCENT, bold: true }, '◆ Muse'),
      h(Text, { dimColor: true }, item.time ? `  ${item.time}` : '')),
    h(Box, { marginLeft: 2 }, h(Text, null, md(item.text, width - 4))),
    item.attachments > 0 && h(Box, { marginLeft: 2 },
      h(Text, { dimColor: true }, `[${item.attachments} attachment${item.attachments > 1 ? 's' : ''}, open the thread in the app to see ${item.attachments > 1 ? 'them' : 'it'}]`)));
}

function Info({ item }) {
  const color = item.kind === 'error' ? 'red' : undefined;
  return h(Box, { marginBottom: 1 }, h(Text, { color, dimColor: item.kind !== 'error' }, item.text));
}

function StaticItem({ item, width }) {
  switch (item.kind) {
    case 'logo': return h(Logo, { ...item, width });
    case 'user': return h(UserMsg, { item });
    case 'assistant': return h(AssistantMsg, { item, width });
    default: return h(Info, { item });
  }
}

function InputBox({ value, cursor, working, attachments, placeholder, width }) {
  const lines = value.split('\n');
  let pos = cursor;
  let curLine = 0;
  for (let i = 0; i < lines.length; i++) {
    if (pos <= lines[i].length) { curLine = i; break; }
    pos -= lines[i].length + 1;
  }
  const rows = lines.map((line, i) => {
    const prefix = h(Text, { color: i === 0 ? ACCENT2 : 'gray', bold: true }, i === 0 ? '› ' : '  ');
    if (i !== curLine) return h(Box, { key: i }, prefix, h(Text, null, line));
    const before = line.slice(0, pos);
    const at = line[pos] ?? ' ';
    const after = line.slice(pos + 1);
    return h(Box, { key: i }, prefix, h(Text, null, before), h(Text, { inverse: true }, at), h(Text, null, after));
  });
  return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: working ? 'gray' : ACCENT, paddingX: 1, width },
    attachments.length > 0 && h(Text, { color: 'cyan' }, attachments.map((a, i) => `[${i + 1}: ${a.filename} ${kb(a.size)}]`).join(' ')),
    value.length === 0
      ? h(Box, null, h(Text, { color: ACCENT2, bold: true }, '› '), h(Text, { inverse: true }, ' '), h(Text, { dimColor: true }, placeholder))
      : rows);
}

function Palette({ matches, selected }) {
  return h(Box, { flexDirection: 'column', paddingX: 2 },
    matches.map(([cmd, desc], i) => h(Box, { key: cmd },
      h(Text, { color: i === selected ? ACCENT : undefined, bold: i === selected }, (i === selected ? '› ' : '  ') + cmd.padEnd(10)),
      h(Text, { dimColor: true }, desc))));
}

function ThreadPicker({ threads, selected, width }) {
  const rows = Math.max(5, Math.min(15, (process.stdout.rows || 30) - 12));
  const start = Math.max(0, Math.min(selected - Math.floor(rows / 2), threads.length - rows));
  const visible = threads.slice(start, start + rows);
  return h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: ACCENT, paddingX: 1, width },
    h(Text, { bold: true, color: ACCENT }, 'Open a thread  ', h(Text, { dimColor: true }, '↑↓ move · enter open · esc close')),
    visible.map((t, i) => {
      const idx = start + i;
      const on = idx === selected;
      const when = new Date(t.updated_at_ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      const title = (t.title || '(untitled)').slice(0, Math.max(10, width - 30));
      return h(Box, { key: t.session_id },
        h(Text, { color: on ? ACCENT : undefined, bold: on }, (on ? '› ' : '  ') + title),
        t.is_primary && h(Text, { dimColor: true }, ' [main]'),
        t.can_send_messages === false && h(Text, { dimColor: true }, ' [read only]'),
        t.unread_count > 0 && h(Text, { color: ACCENT2 }, ` ${t.unread_count} new`),
        h(Text, { dimColor: true }, `  ${when}`));
    }));
}

// Waiting line: a rotating phrase with a moving colour shimmer, plus what Muse
// is actually doing when the agent reports it.
const WAITING = [
  'Musing', 'Consulting the muses', 'Daydreaming', 'Composing', 'Conjuring', 'Brewing ideas',
  'Painting thoughts', 'Tuning the strings', 'Finding the rhythm', 'Weaving words', 'Sketching',
  'Chasing inspiration', 'Stirring the cauldron', 'Connecting the dots', 'Mulling it over',
  'Riffing', 'Doodling', 'Polishing', 'Humming along', 'Sparking ideas', 'Channeling genius',
  'Reading the stars', 'Mixing colours', 'Crafting', 'Spinning yarns', 'Catching lightning',
];
const SHIMMER = [[139, 92, 246], [192, 132, 252], [244, 114, 182], [251, 146, 60], [244, 114, 182], [192, 132, 252]];
function shimmer(text, frame) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const [r, g, b] = SHIMMER[((i - frame) % SHIMMER.length + SHIMMER.length * 1000) % SHIMMER.length];
    out += `\x1b[38;2;${r};${g};${b}m${text[i]}`;
  }
  return `${out}\x1b[0m`;
}
const pickPhrase = (not) => {
  let p;
  do p = WAITING[Math.floor(Math.random() * WAITING.length)]; while (p === not && WAITING.length > 1);
  return p;
};

function StatusLine({ status, streaming }) {
  const [frame, setFrame] = useState(0);
  const [phrase, setPhrase] = useState(() => pickPhrase());
  useEffect(() => { const t = setInterval(() => setFrame((n) => n + 1), 120); return () => clearInterval(t); }, []);
  useEffect(() => { const t = setInterval(() => setPhrase((p) => pickPhrase(p)), 3500); return () => clearInterval(t); }, []);
  const secs = Math.round((Date.now() - status.since) / 1000);
  const generic = !status.text || ['Muse is working', 'Sending', 'is working'].includes(status.text);
  const activity = streaming ? 'writing' : generic ? (status.text === 'Sending' ? 'sending' : '') : `${status.emoji ? status.emoji + ' ' : ''}${status.text}`;
  return h(Box, { paddingX: 1, marginBottom: 0 },
    h(Text, { color: ACCENT }, h(Spinner, { type: 'star' })),
    h(Text, null, ' ' + shimmer(`${phrase}...`, frame)),
    activity && h(Text, null, '  ', h(Text, { color: 'white' }, activity)),
    h(Text, { dimColor: true }, `  ${secs}s · esc to stop`));
}

// ---------- app ----------
function App({ muse, cwd, resume, version }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [width, setWidth] = useState(stdout.columns || 100);
  const [items, setItems] = useState([{ id: 'logo', kind: 'logo', cwd, version }]);
  const [live, setLive] = useState([]); // [{id, text}]
  const [status, setStatus] = useState(null); // {text, emoji, since}
  const [thread, setThread] = useState({ id: crypto.randomUUID(), isNew: true, title: 'New thread' });
  const [value, setValue] = useState('');
  const [cursor, setCursor] = useState(0);
  const [attachments, setAttachments] = useState([]);
  const [mode, setMode] = useState('chat'); // chat | threads
  const [threads, setThreads] = useState([]);
  const [pick, setPick] = useState(0);
  const [confirm, setConfirm] = useState(null); // { text, onYes }
  const [paletteSel, setPaletteSel] = useState(0);
  const [lastCtrlC, setLastCtrlC] = useState(0);
  const [rows, setRows] = useState(stdout.rows || 30);
  const [scroll, setScroll] = useState(0); // lines scrolled up from the bottom
  const [viewH, setViewH] = useState(Math.max(5, (stdout.rows || 30) - 8));
  const viewRef = useRef(null);
  const lineCache = useRef(new Map());
  const lastTotal = useRef(0);

  const threadRef = useRef(thread);
  threadRef.current = thread;
  const seen = useRef(new Set());
  const contextSent = useRef(new Set());
  const chunks = useRef(new Set());
  const liveRef = useRef(new Map());
  const flushTimer = useRef(null);
  const historyRef = useRef([]);
  const historyIdx = useRef(-1);
  const oldestShown = useRef(0);

  useEffect(() => {
    const onResize = () => { setWidth(stdout.columns || 100); setRows(stdout.rows || 30); lineCache.current.clear(); };
    stdout.on('resize', onResize);
    return () => stdout.off('resize', onResize);
  }, [stdout]);

  const push = useCallback((...entries) => {
    setItems((prev) => [...prev, ...entries.map((e) => ({ id: crypto.randomUUID(), ...e }))]);
  }, []);
  const info = useCallback((text) => push({ kind: 'info', text }), [push]);
  const fail = useCallback((text) => push({ kind: 'error', text }), [push]);

  const flushLive = useCallback(() => {
    flushTimer.current = null;
    setLive([...liveRef.current.entries()].map(([id, text]) => ({ id, text })));
  }, []);
  const scheduleFlush = useCallback(() => {
    if (!flushTimer.current) flushTimer.current = setTimeout(flushLive, 50);
  }, [flushLive]);

  const finalize = useCallback((id, text, extra = {}) => {
    if (seen.current.has(id)) return;
    seen.current.add(id);
    liveRef.current.delete(id);
    scheduleFlush();
    if (text) push({ kind: 'assistant', text, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), ...extra });
  }, [push, scheduleFlush]);

  const remember = useCallback((id) => {
    const state = loadState();
    state.byCwd[cwd] = id;
    state.last = id;
    saveState(state);
  }, [cwd]);

  // Loads the tail of a thread's history into the scrollback.
  const showHistory = useCallback(async (id, count, before = Infinity) => {
    const res = await muse.history(id, 60);
    const events = (res.chat_events || []).filter(isMessageEvent).filter(eventDone);
    for (const e of events) seen.current.add(e.message_id);
    const older = events.filter((e) => (e.seq ?? 0) < before);
    const slice = older.slice(-count);
    if (slice.length) oldestShown.current = slice[0].seq ?? 0;
    push(...slice.map((e) => (e.role === 'user'
      ? { kind: 'user', text: eventText(e) }
      : { kind: 'assistant', text: eventText(e), time: new Date(e.occurred_at_ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), attachments: (e.resources || []).length })));
    const maxSeq = events.reduce((m, e) => Math.max(m, e.seq ?? 0), 0);
    return { maxSeq, count: slice.length };
  }, [muse, push]);

  const openThread = useCallback(async (t) => {
    liveRef.current.clear();
    flushLive();
    setStatus(null);
    seen.current = new Set();
    const next = { id: t.session_id, isNew: false, title: t.title || 'Thread', readOnly: t.can_send_messages === false, isPrimary: !!t.is_primary, channel: t.channel };
    setThread(next);
    threadRef.current = next;
    push({ kind: 'info', text: `── ${next.title} ──` });
    const { maxSeq } = await showHistory(next.id, 8);
    await muse.subscribe(next.id, maxSeq).catch(() => {});
    remember(next.id);
    if (next.readOnly) info('This thread is read only here (it belongs to a messaging channel).');
  }, [muse, push, info, showHistory, remember, flushLive]);

  // Live events from the app.
  useEffect(() => {
    const onEvent = (name, p) => {
      const t = threadRef.current;
      const sid = p.session_id || (p.chat_context && p.chat_context.chat_id) || (p.session && p.session.session_id);
      if (name === 'sessions.updated') {
        if (p.session && p.session.session_id === t.id && p.session.title) setThread((prev) => ({ ...prev, title: p.session.title }));
        return;
      }
      if (!sid || sid !== t.id) return;
      switch (name) {
        case 'agent.status':
          if (p.activity_code === 'online') break;
          setStatus((prev) => ({ since: prev ? prev.since : Date.now(), text: p.activity_text && p.activity_text !== 'is working' ? p.activity_text : 'Muse is working', emoji: p.activity_emoji }));
          break;
        case 'task.status':
          if (p.status === 'running') setStatus((prev) => prev || { since: Date.now(), text: 'Muse is working' });
          else if (['completed', 'failed', 'cancelled'].includes(p.status)) {
            setStatus(null);
            if (p.status === 'failed') fail('Muse stopped with an error.');
          }
          break;
        case 'delta.message_start':
          if (!seen.current.has(p.message_id) && !liveRef.current.has(p.message_id)) { liveRef.current.set(p.message_id, ''); scheduleFlush(); }
          break;
        case 'delta.text_append':
          if (seen.current.has(p.message_id) || chunks.current.has(`${p.message_id}:${p.seq}`)) break;
          chunks.current.add(`${p.message_id}:${p.seq}`);
          liveRef.current.set(p.message_id, (liveRef.current.get(p.message_id) || '') + (p.text || ''));
          scheduleFlush();
          break;
        case 'delta.message_done':
          finalize(p.message_id, [doneText(p), p.display_text || '', liveRef.current.get(p.message_id) || '']
            .reduce((a, b) => (b.trim().length > a.length ? b.trim() : a), ''), { attachments: (p.resources || []).length });
          break;
        case 'delta.message_removed':
          liveRef.current.delete(p.message_id);
          scheduleFlush();
          break;
        default:
          break;
      }
    };
    const onReconnected = () => {
      const t = threadRef.current;
      if (!t.isNew) muse.subscribe(t.id, 0).catch(() => {});
    };
    const onDisconnected = () => fail('Lost the connection to the Muse app. Restart muse.');
    muse.on('event', onEvent);
    muse.on('reconnected', onReconnected);
    muse.on('disconnected', onDisconnected);
    return () => { muse.off('event', onEvent); muse.off('reconnected', onReconnected); muse.off('disconnected', onDisconnected); };
  }, [muse, finalize, scheduleFlush, fail]);

  // Safety net: if a delta was missed, pick finished replies up from history.
  useEffect(() => {
    let stop = false;
    const loop = async () => {
      while (!stop) {
        await new Promise((r) => setTimeout(r, status ? 4000 : 20000));
        const t = threadRef.current;
        if (stop || t.isNew) continue;
        try {
          const res = await muse.history(t.id, 20);
          for (const e of (res.chat_events || []).filter(isMessageEvent)) {
            if (e.role !== 'assistant' || seen.current.has(e.message_id) || liveRef.current.has(e.message_id)) continue;
            if (!e.payload || e.payload.status !== 'completed') continue;
            finalize(e.message_id, eventText(e), { attachments: (e.resources || []).length, time: new Date(e.occurred_at_ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) });
          }
        } catch { /* next round */ }
      }
    };
    loop();
    return () => { stop = true; };
  }, [muse, status, finalize]);

  useEffect(() => {
    if (resume) openThread({ session_id: resume, title: 'Resumed thread' }).catch((e) => fail(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const quit = useCallback(() => { exit(); }, [exit]);

  const send = useCallback(async (text) => {
    const t = threadRef.current;
    if (t.readOnly) { fail('This thread is read only. Use /new or /threads.'); return; }
    const imgs = attachments;
    const body = contextSent.current.has(t.id) ? text : `${contextLine(cwd)}\n${text}`;
    const items = [];
    if (body.trim()) items.push({ type: 'text', text: body });
    for (const im of imgs) items.push({ type: 'image', mime_type: im.mime, data_base64: im.base64, filename: im.filename });
    if (!items.length) return;
    push({ kind: 'user', text: text || '(image)', images: imgs });
    setAttachments([]);
    setStatus({ since: Date.now(), text: 'Sending' });
    try {
      await muse.send(t.id, items);
      contextSent.current.add(t.id);
      if (t.isNew) {
        const next = { ...t, isNew: false };
        setThread(next);
        threadRef.current = next;
        await muse.subscribe(t.id, 0);
        remember(t.id);
      }
      setStatus((prev) => (prev && prev.text === 'Sending' ? { since: prev.since, text: 'Muse is working' } : prev));
    } catch (e) {
      setStatus(null);
      fail(`Send failed: ${e.message}`);
    }
  }, [attachments, cwd, muse, push, fail, remember]);

  const runCommand = useCallback(async (line) => {
    const [cmd, ...rest] = line.split(/\s+/);
    const arg = rest.join(' ');
    switch (cmd) {
      case '/quit': case '/exit': quit(); return;
      case '/help':
        info(['Keys: enter send · alt+enter or \\ at line end for a new line · ctrl+v paste image · ↑↓ input history',
          '      esc stop the reply · ctrl+c clear input (twice to quit) · ctrl+d quit',
          'Drag an image file into the terminal to attach it.',
          ...COMMANDS.map(([c, d]) => `${c.padEnd(10)} ${d}`)].join('\n'));
        return;
      case '/new': {
        const next = { id: crypto.randomUUID(), isNew: true, title: 'New thread' };
        seen.current = new Set();
        liveRef.current.clear();
        flushLive();
        setStatus(null);
        setThread(next);
        threadRef.current = next;
        info('── New thread ──');
        return;
      }
      case '/usage': {
        const u = await muse.usage();
        const pct = u.usage.percentUsed ?? 0;
        const barW = 30;
        const filled = Math.round((pct / 100) * barW);
        const bar = gradient(['#8b5cf6', '#f472b6'])('█'.repeat(filled)) + '\x1b[2m' + '░'.repeat(barW - filled) + '\x1b[0m';
        const resets = u.usage.resetsAt ? new Date(u.usage.resetsAt * 1000).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'unknown';
        info([
          `Plan       ${u.tier.name}`,
          `This week  ${bar} ${pct}% used`,
          `Resets     ${resets}`,
          ...(u.topupRowValueLabel ? [`Extra      ${u.topupRowValueLabel}`] : []),
        ].join('\n'));
        return;
      }
      case '/clear': {
        const next = { id: crypto.randomUUID(), isNew: true, title: 'New thread' };
        seen.current = new Set();
        liveRef.current.clear();
        flushLive();
        setStatus(null);
        setThread(next);
        threadRef.current = next;
        setScroll(0);
        setItems([{ id: crypto.randomUUID(), kind: 'logo', cwd, version }]);
        return;
      }
      case '/delete': {
        const t = threadRef.current;
        if (t.isNew) { info('This thread is not saved in Muse yet, there is nothing to delete.'); return; }
        if (t.isPrimary) { fail('This is your main Muse chat. It cannot be deleted.'); return; }
        if (t.channel) { fail(`This thread belongs to ${t.channel}. Delete it from the Muse app.`); return; }
        setConfirm({
          text: `Delete "${t.title}" from Muse? This removes the whole thread and cannot be undone.`,
          onYes: async () => {
            await muse.deleteThread(t.id);
            const next = { id: crypto.randomUUID(), isNew: true, title: 'New thread' };
            seen.current = new Set();
            liveRef.current.clear();
            flushLive();
            setStatus(null);
            setThread(next);
            threadRef.current = next;
            const state = loadState();
            if (state.byCwd[cwd] === t.id) delete state.byCwd[cwd];
            if (state.last === t.id) delete state.last;
            saveState(state);
            setScroll(0);
            setItems([{ id: crypto.randomUUID(), kind: 'logo', cwd, version }, { id: crypto.randomUUID(), kind: 'info', text: `Deleted "${t.title}" from Muse. You are in a new thread.` }]);
          },
        });
        return;
      }
      case '/resume': case '/switch': case '/threads': case '/open': {
        const list = await muse.threads();
        list.sort((a, b) => (b.updated_at_ms || 0) - (a.updated_at_ms || 0));
        setThreads(list);
        setPick(0);
        setMode('threads');
        return;
      }
      case '/history':
        if (threadRef.current.isNew) { info('No messages in this thread yet.'); return; }
        info('── earlier ──');
        if (!(await showHistory(threadRef.current.id, 10, oldestShown.current || Infinity)).count) info('Nothing earlier.');
        return;
      case '/cancel':
        if (!threadRef.current.isNew) await muse.cancel(threadRef.current.id).catch(() => {});
        setStatus(null);
        return;
      case '/id':
        info(threadRef.current.isNew ? 'Not created yet. It gets an id with the first message.' : threadRef.current.id);
        return;
      case '/paste':
        try { const im = imageFromClipboard(); setAttachments((a) => [...a, im]); } catch (e) { fail(e.message); }
        return;
      case '/image':
        try { setAttachments((a) => [...a, imageFromFile(arg.replace(/^~\//, `${os.homedir()}/`))]); } catch (e) { fail(e.message); }
        return;
      default:
        fail(`Unknown command ${cmd}. Type / to see the list.`);
    }
  }, [muse, quit, info, fail, showHistory, flushLive, cwd, version]);

  const paletteMatches = useMemo(() => {
    if (mode !== 'chat' || !value.startsWith('/') || value.includes(' ') || value.includes('\n')) return [];
    return COMMANDS.filter(([c]) => c.startsWith(value));
  }, [value, mode]);

  // Keystrokes can arrive faster than React re-renders, so the input lives in a
  // ref that is always current, and state only mirrors it for drawing.
  const inp = useRef({ value: '', cursor: 0 });
  const setInput = (v, c = v.length) => {
    const cur = Math.max(0, Math.min(c, v.length));
    inp.current = { value: v, cursor: cur };
    setValue(v);
    setCursor(cur);
  };
  const moveCursor = (c) => setInput(inp.current.value, c);

  const submit = () => {
    const value = inp.current.value;
    let text = value;
    if (paletteMatches.length && !COMMANDS.some(([c]) => c === text.trim())) text = paletteMatches[Math.min(paletteSel, paletteMatches.length - 1)][0];
    text = text.trim();
    if (!text && !attachments.length) return;
    if (text) { historyRef.current.push(text); historyIdx.current = -1; }
    setInput('');
    setPaletteSel(0);
    if (text.startsWith('/')) runCommand(text).catch((e) => fail(e.message));
    else send(text);
  };

  useInput((input, key) => {
    if (confirm) {
      if (input && MOUSE_RE.test(input)) { MOUSE_RE.lastIndex = 0; return; }
      const c = confirm;
      setConfirm(null);
      if (input === 'y' || input === 'Y') c.onYes().catch((e) => fail(`Delete failed: ${e.message}`));
      else info('Not deleted.');
      return;
    }
    if (mode === 'threads') {
      const ms = input ? input.match(MOUSE_RE) : null;
      if (ms) {
        for (const m of ms) {
          const btn = Number(m.slice(m.indexOf('<') + 1, m.indexOf(';')));
          if (btn === 64) setPick((p) => Math.max(0, p - 1));
          else if (btn === 65) setPick((p) => Math.min(threads.length - 1, p + 1));
        }
        return;
      }
      if (key.escape) setMode('chat');
      else if (key.upArrow) setPick((p) => Math.max(0, p - 1));
      else if (key.downArrow) setPick((p) => Math.min(threads.length - 1, p + 1));
      else if (key.return && threads[pick]) { setMode('chat'); openThread(threads[pick]).catch((e) => fail(e.message)); }
      return;
    }

    const { value, cursor } = inp.current;
    // Mouse reports (SGR mode) arrive as text like "[<0;56;41M". The wheel
    // scrolls the chat area; clicks and drags are swallowed, never typed.
    const mouse = input ? input.match(MOUSE_RE) : null;
    if (mouse) {
      for (const m of mouse) {
        const btn = Number(m.slice(m.indexOf('<') + 1, m.indexOf(';')));
        if (btn === 64) scrollBy(3);
        else if (btn === 65) scrollBy(-3);
      }
      input = input.replace(MOUSE_RE, '');
      if (!input) return;
    }
    if (key.pageUp) { scrollBy(Math.max(1, viewH - 2)); return; }
    if (key.pageDown) { scrollBy(-Math.max(1, viewH - 2)); return; }
    if (key.ctrl && input === 'd') { quit(); return; }
    if (key.ctrl && input === 'c') {
      if (value) { setInput(''); return; }
      if (Date.now() - lastCtrlC < 1500) { quit(); return; }
      setLastCtrlC(Date.now());
      info('Press ctrl+c again to quit.');
      return;
    }
    if (key.escape) {
      if (status && !threadRef.current.isNew) { muse.cancel(threadRef.current.id).catch(() => {}); setStatus(null); info('Stopped.'); }
      else if (value.startsWith('/')) setInput('');
      return;
    }
    if (key.ctrl && input === 'v') { runCommand('/paste'); return; }

    if (key.return) {
      if (key.meta || value.slice(0, cursor).endsWith('\\')) {
        const base = key.meta ? value : value.slice(0, cursor - 1) + value.slice(cursor);
        const c = key.meta ? cursor : cursor - 1;
        setInput(base.slice(0, c) + '\n' + base.slice(c), c + 1);
        return;
      }
      submit();
      return;
    }
    if (key.tab) {
      if (paletteMatches.length) setInput(paletteMatches[Math.min(paletteSel, paletteMatches.length - 1)][0] + ' ');
      return;
    }
    if (key.upArrow) {
      if (paletteMatches.length) { setPaletteSel((s) => Math.max(0, s - 1)); return; }
      const hist = historyRef.current;
      if (!hist.length || value.includes('\n')) return;
      historyIdx.current = historyIdx.current === -1 ? hist.length - 1 : Math.max(0, historyIdx.current - 1);
      setInput(hist[historyIdx.current]);
      return;
    }
    if (key.downArrow) {
      if (paletteMatches.length) { setPaletteSel((s) => Math.min(paletteMatches.length - 1, s + 1)); return; }
      const hist = historyRef.current;
      if (historyIdx.current === -1) return;
      historyIdx.current += 1;
      if (historyIdx.current >= hist.length) { historyIdx.current = -1; setInput(''); } else setInput(hist[historyIdx.current]);
      return;
    }
    if (key.leftArrow) { moveCursor(cursor - 1); return; }
    if (key.rightArrow) { moveCursor(cursor + 1); return; }
    if (key.home || (key.ctrl && input === 'a')) { moveCursor(value.lastIndexOf('\n', cursor - 1) + 1); return; }
    if (key.end || (key.ctrl && input === 'e')) { const n = value.indexOf('\n', cursor); moveCursor(n === -1 ? value.length : n); return; }
    if (key.ctrl && input === 'u') { setInput(value.slice(cursor), 0); return; }
    if (key.ctrl && input === 'k') { const n = value.indexOf('\n', cursor); setInput(value.slice(0, cursor) + (n === -1 ? '' : value.slice(n)), cursor); return; }
    if (key.ctrl && input === 'w') {
      const before = value.slice(0, cursor).replace(/\S+\s*$/, '');
      setInput(before + value.slice(cursor), before.length);
      return;
    }
    if (key.backspace || key.delete) {
      if (cursor === 0) { if (!value && attachments.length) setAttachments((a) => a.slice(0, -1)); return; }
      setInput(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1);
      return;
    }
    if (!input || key.ctrl || key.meta) return;

    // Pasted text arrives as one chunk. A path to an image becomes an attachment.
    if (input.length > 1) {
      const img = pastedImagePath(input);
      if (img) {
        try { setAttachments((a) => [...a, imageFromFile(img)]); } catch (e) { fail(e.message); }
        return;
      }
    }
    // When the UI is busy, the last few typed keys and Enter can arrive as one
    // chunk. A chunk whose only line break is at the end is typing, not a paste.
    const typedEnter = /^[^\r\n]*\r$/.test(input);
    const clean = (typedEnter ? input.slice(0, -1) : input).replace(/\r\n?/g, '\n');
    setInput(value.slice(0, cursor) + clean + value.slice(cursor), cursor + clean.length);
    setPaletteSel(0);
    if (typedEnter) submit();
  });

  const boxWidth = Math.max(30, width - 2);
  const placeholder = thread.readOnly ? 'This thread is read only. /new or /resume' : 'Message Muse  (/ for commands)';
  const shortCwd = cwd.replace(os.homedir(), '~');
  const innerW = width - 2;

  // Every message is drawn to plain lines once (cached), so the chat area can
  // show any window of them: a fixed screen with its own scrolling.
  const linesFor = (item, key) => {
    const k = `${key}:${innerW}`;
    if (key && lineCache.current.has(k)) return lineCache.current.get(k);
    let lines;
    try { lines = itemLines(item, innerW); } catch { lines = wrapLines(item.text || '', innerW); }
    if (key) lineCache.current.set(k, lines);
    return lines;
  };
  const allLines = [];
  for (const item of items) allLines.push(...linesFor(item, item.id));
  for (const l of live) if (l.text) allLines.push(...linesFor({ kind: 'assistant', text: l.text }, null));
  while (allLines.length && allLines[allLines.length - 1].trim() === '') allLines.pop();

  // Keep the view still while scrolled up and new lines arrive below.
  const total = allLines.length;
  useEffect(() => {
    if (scroll > 0 && total > lastTotal.current) setScroll((s) => s + (total - lastTotal.current));
    lastTotal.current = total;
  }, [total]); // eslint-disable-line react-hooks/exhaustive-deps

  const maxScroll = Math.max(0, total - viewH);
  const off = Math.min(scroll, maxScroll);
  const end = total - off;
  const visible = allLines.slice(Math.max(0, end - viewH), end);
  // Short chats start at the top; once full, the newest lines stay in view.
  while (visible.length < viewH) visible.push('');

  function scrollBy(n) { setScroll((s) => Math.max(0, Math.min(Math.max(0, total - viewH), s + n))); }

  useEffect(() => {
    if (!viewRef.current) return;
    const { height } = measureElement(viewRef.current);
    if (height > 0 && height !== viewH) setViewH(height);
  });

  const header = h(Box, { paddingX: 1, justifyContent: 'space-between', width },
    h(Text, null,
      h(Text, null, museGradient('◆ MUSE')),
      h(Text, { dimColor: true }, '  ·  '),
      h(Text, { bold: true }, (thread.title || '').slice(0, Math.max(10, width - shortCwd.length - 40))),
      h(Text, { dimColor: true }, thread.isNew ? '  (new)' : '')),
    h(Text, null, h(Text, { dimColor: true }, `${shortCwd}  ·  `), h(Text, { dimColor: true }, 'by '), gradient(['#f472b6', '#fb923c'])('WebMarkaz')));

  const scrolledNote = off > 0 && h(Box, { paddingX: 1, justifyContent: 'center', width },
    h(Text, { color: ACCENT2 }, `↓ ${off} more line${off === 1 ? '' : 's'} below · PgDn or scroll to go down`));

  // Root is one row shorter than the screen: Ink clears and redraws the whole
  // terminal on every frame when its output reaches the full height.
  return h(Box, { flexDirection: 'column', height: Math.max(10, rows - 1), width },
    header,
    h(Box, { borderStyle: 'single', borderTop: true, borderBottom: false, borderLeft: false, borderRight: false, borderColor: 'gray', width }),
    h(Box, { ref: viewRef, flexDirection: 'column', flexGrow: 1, flexShrink: 1, minHeight: 3, overflow: 'hidden', paddingX: 1 },
      h(Text, { wrap: 'truncate' }, visible.join('\n'))),
    scrolledNote,
    status && h(StatusLine, { status, streaming: live.some((l) => l.text) }),
    confirm
      ? h(Box, { borderStyle: 'round', borderColor: 'red', paddingX: 1, width: boxWidth, flexDirection: 'column' },
        h(Text, { color: 'red', bold: true }, confirm.text),
        h(Text, null, h(Text, { bold: true }, 'y'), h(Text, { dimColor: true }, ' delete   any other key: keep it')))
      : mode === 'threads'
      ? h(ThreadPicker, { threads, selected: pick, width: boxWidth })
      : h(InputBox, { value, cursor, working: !!status, attachments, placeholder, width: boxWidth }),
    paletteMatches.length > 0 && h(Palette, { matches: paletteMatches, selected: Math.min(paletteSel, paletteMatches.length - 1) }),
    h(Box, { paddingX: 2, width },
      h(Text, { dimColor: true, wrap: 'truncate' }, 'enter send · alt+enter newline · pgup/pgdn/wheel scroll · / commands · esc stop · ctrl+d quit')));
}

export async function runTui({ cwd, resume, version }) {
  const muse = new Muse();
  process.stdout.write('\x1b[2m  Connecting to Muse...\x1b[0m\r');
  await muse.connect((msg) => process.stdout.write(`\x1b[2K\x1b[2m  ${msg}\x1b[0m\r`));
  // Own screen (alternate buffer, like vim or opencode) with mouse wheel reports.
  const enter = '\x1b[?1049h\x1b[2J\x1b[H\x1b[?1000h\x1b[?1006h';
  const leave = '\x1b[?1000l\x1b[?1006l\x1b[?1049l\x1b[?25h';
  process.stdout.write(enter);
  const restore = () => process.stdout.write(leave);
  process.on('exit', restore);
  const app = render(h(App, { muse, cwd, resume, version }), { exitOnCtrlC: false });
  await app.waitUntilExit();
  restore();
  process.off('exit', restore);
  await muse.close();
}
