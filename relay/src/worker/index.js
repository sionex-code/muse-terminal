import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { loadEnv, need, num } from "../shared/env.js";
import { parse, send } from "../shared/protocol.js";
import { Runner } from "./runner.js";

loadEnv();

const RELAY_URL = need("RELAY_URL");
const WORKER_TOKEN = need("WORKER_TOKEN");
const WORKER_NAME = process.env.WORKER_NAME || os.hostname();
const ENGINE = process.env.ENGINE || "opencode";
const ALLOW_SHELL = process.env.ALLOW_SHELL === "1";
const TASK_TIMEOUT = num("TASK_TIMEOUT", 900);

const ROOTS = (process.env.WORKER_ROOTS || os.homedir())
  .split(path.delimiter) // ":" on Linux/macOS, ";" on Windows (drive letters contain ":")
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => path.resolve(entry));

const DEFAULT_CWD = path.resolve(process.env.WORKER_DEFAULT_CWD || ROOTS[0]);

let ws = null;
let backoff = 1000;

const runner = new Runner({
  roots: ROOTS,
  defaultCwd: DEFAULT_CWD,
  timeoutSeconds: TASK_TIMEOUT,
  allowShell: ALLOW_SHELL,
  onLog: (id, stream, data) => send(ws, { t: "log", id, stream, data }),
});

function connect() {
  console.log(`[worker] connecting to ${RELAY_URL} as ${WORKER_NAME}`);
  ws = new WebSocket(RELAY_URL);

  ws.on("open", () => {
    backoff = 1000;
    send(ws, {
      t: "hello",
      name: WORKER_NAME,
      token: WORKER_TOKEN,
      engine: ENGINE,
      roots: ROOTS,
      allowShell: ALLOW_SHELL,
    });
  });

  ws.on("message", async (raw) => {
    const msg = parse(raw);
    if (!msg) return;

    if (msg.t === "welcome") {
      console.log(`[worker] online. engine=${ENGINE} roots=${ROOTS.join(", ")}`);
      return;
    }
    if (msg.t === "deny") {
      console.error(`[worker] relay refused the connection: ${msg.reason}`);
      process.exit(1);
    }
    if (msg.t === "ping") {
      send(ws, { t: "pong" });
      return;
    }
    if (msg.t === "cancel") {
      console.log(`[worker] cancel ${msg.id}`);
      runner.cancel(msg.id);
      return;
    }
    if (msg.t === "task") {
      console.log(`[worker] task ${msg.id} (${msg.kind}) in ${msg.cwd || DEFAULT_CWD}`);
      let result;
      try {
        result = await runner.handle(msg);
      } catch (err) {
        result = { ok: false, error: err.message };
      }
      send(ws, { t: "done", id: msg.id, ...result });
      console.log(`[worker] task ${msg.id} ${result.ok ? "done" : "failed"}`);
    }
  });

  ws.on("close", (code) => {
    console.log(`[worker] disconnected (${code}), retrying in ${Math.round(backoff / 1000)}s`);
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, 30_000);
  });

  ws.on("error", (err) => console.error(`[worker] socket error: ${err.message}`));
}

connect();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`[worker] ${signal}, exiting`);
    try { ws?.close(); } catch {}
    process.exit(0);
  });
}
