import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Muse names a thread ("refactor-auth"); opencode names a session ("ses_...").
// This maps one to the other and survives a worker restart, so a follow up
// prompt lands in the same conversation instead of starting cold.
const STORE = path.join(os.homedir(), ".muse-mcp", "sessions.json");

function load() {
  try {
    return JSON.parse(fs.readFileSync(STORE, "utf8"));
  } catch {
    return {};
  }
}

function save(data) {
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  fs.writeFileSync(STORE, JSON.stringify(data, null, 2));
}

// Sessions are scoped per folder: the same key in two projects stays separate.
const keyFor = (name, cwd) => `${path.resolve(cwd)}::${name}`;

export function getSession(name, cwd) {
  return load()[keyFor(name, cwd)] ?? null;
}

export function setSession(name, cwd, sessionId) {
  const data = load();
  data[keyFor(name, cwd)] = sessionId;
  save(data);
}

export function listSessions() {
  return Object.entries(load()).map(([key, sessionId]) => {
    const [cwd, name] = key.split("::");
    return { name, cwd, sessionId };
  });
}

export function forgetSession(name, cwd) {
  const data = load();
  delete data[keyFor(name, cwd)];
  save(data);
}
