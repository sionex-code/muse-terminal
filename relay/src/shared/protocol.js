// Wire protocol between the VPS relay and a worker machine.
//
// worker -> server
//   { t: "hello", name, token, roots, engine, allowShell }
//   { t: "log",  id, stream: "stdout"|"stderr", data }
//   { t: "done", id, ok, exitCode, output, error }
//   { t: "pong" }
//
// server -> worker
//   { t: "welcome", workerId }
//   { t: "deny", reason }
//   { t: "task", id, kind: "agent"|"shell"|"fs", ...payload }
//   { t: "cancel", id }
//   { t: "ping" }

export const PROTOCOL_VERSION = 1;

export function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

export function parse(raw) {
  try {
    const msg = JSON.parse(String(raw));
    return msg && typeof msg.t === "string" ? msg : null;
  } catch {
    return null;
  }
}
