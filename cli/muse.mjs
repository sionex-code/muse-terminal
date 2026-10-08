#!/usr/bin/env node
// Entry point: `muse` opens the TUI, `muse -p "..."` prints one reply for scripts.
import crypto from 'node:crypto';
import { Muse, loadState, saveState, doneText, contextLine } from './bridge.mjs';

const VERSION = 'v0.2';
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
const cwd = process.cwd();

function usage() {
  console.log(`muse ${VERSION}, Muse in the terminal

  muse                   open the chat UI in a new thread
  muse -c                continue the last thread used in this folder
  muse -r <session id>   resume a thread
  muse -p "prompt"       send one message, stream the reply to stdout, exit
       -c with -p continues the last thread in this folder
       --timeout <s>     give up after this many seconds (default 600)
  muse threads           list your threads
  muse usage             show plan and weekly usage`);
}

async function printMode(prompt) {
  const muse = new Muse();
  await muse.connect((m) => process.stderr.write(`${m}\n`));
  const state = loadState();
  const resume = args.includes('-c') ? state.byCwd[cwd] : undefined;
  const sid = resume || crypto.randomUUID();
  const text = `${contextLine(cwd)}\n${prompt}`;
  const streamed = new Set();
  const old = new Set();
  const chunks = new Set();
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  let quietTimer = null;
  muse.on('event', (name, p) => {
    if (p.session_id !== sid && !(p.chat_context && p.chat_context.chat_id === sid)) return;
    if (p.message_id && old.has(p.message_id)) return;
    if (name === 'delta.text_append') {
      const k = `${p.message_id}:${p.seq}`;
      if (chunks.has(k)) return;
      chunks.add(k);
      streamed.add(p.message_id);
      process.stdout.write(p.text || '');
    }
    if (name === 'delta.message_done') {
      if (chunks.has(`${p.message_id}:done`)) return;
      chunks.add(`${p.message_id}:done`);
      if (!streamed.has(p.message_id)) process.stdout.write(doneText(p));
      process.stdout.write('\n');
    }
    // Muse can send several messages in one turn, so wait a moment after it finishes.
    if (name === 'task.status' && ['completed', 'failed', 'cancelled'].includes(p.status)) {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => resolveDone(p.status === 'completed' ? 0 : 1), 1500);
    }
    if (name === 'task.status' && p.status === 'running') clearTimeout(quietTimer);
  });
  if (resume) {
    const hist = await muse.history(sid, 40);
    for (const e of hist.chat_events || []) old.add(e.message_id);
    const maxSeq = (hist.chat_events || []).reduce((m, e) => Math.max(m, e.seq ?? 0), 0);
    await muse.subscribe(sid, maxSeq);
    await muse.send(sid, [{ type: 'text', text }]);
  } else {
    await muse.send(sid, [{ type: 'text', text }]);
    await muse.subscribe(sid, 0);
  }
  state.byCwd[cwd] = sid;
  state.last = sid;
  saveState(state);
  const timeout = (Number(flag('--timeout')) || 600) * 1000;
  const code = await Promise.race([done, new Promise((r) => setTimeout(() => { process.stderr.write(`No reply within ${timeout / 1000}s. Thread: ${sid}\n`); r(1); }, timeout))]);
  await muse.close();
  return code;
}

async function main() {
  if (args.includes('-h') || args.includes('--help')) return usage();
  if (args[0] === 'threads' || args[0] === 'usage') {
    const muse = new Muse();
    await muse.connect();
    if (args[0] === 'threads') {
      const list = (await muse.threads()).sort((a, b) => b.updated_at_ms - a.updated_at_ms);
      for (const t of list) console.log(`${t.session_id}  ${(t.title || '(untitled)').padEnd(40).slice(0, 40)}  ${new Date(t.updated_at_ms).toLocaleString()}`);
    } else {
      const u = await muse.usage();
      console.log(`${u.tier.name}: ${u.usage.percentUsed ?? 0}% of the weekly limit used, resets ${new Date(u.usage.resetsAt * 1000).toLocaleString()}`);
      if (u.topupRowValueLabel) console.log(`Extra tokens: ${u.topupRowValueLabel}`);
    }
    await muse.close();
    return;
  }
  if (args.includes('-p')) {
    const prompt = flag('-p');
    if (!prompt) { usage(); process.exit(2); }
    process.exit(await printMode(prompt));
  }
  if (!process.stdin.isTTY) { console.error('muse needs a terminal. Use muse -p "..." in scripts.'); process.exit(2); }
  const { runTui } = await import('./tui.mjs');
  let resume = flag('-r');
  if (args.includes('-c')) resume = loadState().byCwd[cwd];
  await runTui({ cwd, resume, version: VERSION });
  process.exit(0);
}

main().catch((err) => { console.error(`\x1b[31m${err.message}\x1b[0m`); process.exit(1); });
