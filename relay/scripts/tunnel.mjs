#!/usr/bin/env node
// One command to run the whole relay on this PC behind a Cloudflare tunnel.
// Works on Windows and Linux. No VPS.
//
//   node scripts/tunnel.mjs setup      first-time setup (the installer runs this)
//   node scripts/tunnel.mjs run        start relay + worker + tunnel in the foreground
//   node scripts/tunnel.mjs service    install autostart and start it now
//   node scripts/tunnel.mjs unservice  remove autostart
//   node scripts/tunnel.mjs status     show the public URL and who is online
//
// Setup flags (for scripts and agents, so nothing asks a question):
//   --hostname muse.example.com   permanent URL on a domain in your Cloudflare account
//   --quick                       temporary trycloudflare.com URL, no account
//   --roots "/a:/b"               folders the agent may touch (default: your home folder)
//   --shell                       allow raw shell commands from Muse (off by default)
//   --no-service                  do not install autostart

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOME_DIR = path.join(os.homedir(), ".muse-relay");
const BIN_DIR = path.join(HOME_DIR, "bin");
const ENV_FILE = path.join(ROOT, ".env");
const CF_CONFIG = path.join(HOME_DIR, "cloudflared.yml");
const URL_FILE = path.join(HOME_DIR, "url.txt");
const WIN = process.platform === "win32";
const PORT = 8787;

const args = process.argv.slice(2);
const cmd = args[0] && !args[0].startsWith("-") ? args[0] : "setup";
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i === -1 ? undefined : args[i + 1]; };

const say = (m) => console.log(m);
const ok = (m) => console.log(`ok    ${m}`);
const die = (m) => { console.error(`fail  ${m}`); process.exit(1); };

// ---------- .env ----------

function readEnv() {
  const out = {};
  if (!fs.existsSync(ENV_FILE)) return out;
  for (const line of fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq > 0) out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
  }
  return out;
}

function writeEnv(updates) {
  const lines = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/) : [];
  const seen = new Set();
  const next = lines.map((line) => {
    const eq = line.indexOf("=");
    const key = eq > 0 && !line.trim().startsWith("#") ? line.slice(0, eq).trim() : null;
    if (key && key in updates) { seen.add(key); return `${key}=${updates[key]}`; }
    return line;
  });
  for (const [k, v] of Object.entries(updates)) if (!seen.has(k)) next.push(`${k}=${v}`);
  fs.writeFileSync(ENV_FILE, next.join("\n").replace(/\n*$/, "\n"), { mode: 0o600 });
}

// ---------- prompts ----------

async function ask(question, fallback = "") {
  if (!process.stdin.isTTY) return fallback;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((r) => rl.question(question, r));
  rl.close();
  return answer.trim() || fallback;
}

// ---------- cloudflared ----------

function cloudflaredPath() {
  const exe = WIN ? "cloudflared.exe" : "cloudflared";
  const local = path.join(BIN_DIR, exe);
  if (fs.existsSync(local)) return local;
  const found = spawnSync(WIN ? "where" : "which", ["cloudflared"], { encoding: "utf8" });
  if (found.status === 0) return found.stdout.split(/\r?\n/)[0].trim();
  return null;
}

async function ensureCloudflared() {
  const have = cloudflaredPath();
  if (have) { ok(`cloudflared found: ${have}`); return have; }
  const arch = os.arch() === "arm64" ? "arm64" : "amd64";
  let asset;
  if (WIN) asset = `cloudflared-windows-${arch === "arm64" ? "amd64" : arch}.exe`;
  else if (process.platform === "linux") asset = `cloudflared-linux-${arch}`;
  else die("On macOS install cloudflared with: brew install cloudflared");
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`;
  say(`...   downloading cloudflared (${asset})`);
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const dest = path.join(BIN_DIR, WIN ? "cloudflared.exe" : "cloudflared");
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) die(`download failed (${res.status}) from ${url}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest, { mode: 0o755 }));
  if (!WIN) fs.chmodSync(dest, 0o755);
  ok(`cloudflared installed to ${dest}`);
  return dest;
}

function cf(bin, cfArgs, { inherit = false } = {}) {
  return spawnSync(bin, cfArgs, { encoding: "utf8", stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"] });
}

function certPath() { return path.join(os.homedir(), ".cloudflared", "cert.pem"); }

function findTunnel(bin, name) {
  const r = cf(bin, ["tunnel", "list", "--name", name, "--output", "json"]);
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout).find((t) => t.name === name) || null; } catch { return null; }
}

// Creates (or reuses) a named tunnel and points the hostname at it.
async function setupPermanent(bin, hostname) {
  if (!fs.existsSync(certPath())) {
    say("\nA browser window opens now. Log in to Cloudflare and pick the domain for this URL.");
    say("(If no browser opens, copy the link printed below into one.)\n");
    const r = cf(bin, ["tunnel", "login"], { inherit: true });
    if (r.status !== 0 || !fs.existsSync(certPath())) die("Cloudflare login did not finish");
  }
  const name = `muse-relay-${os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
  let tunnel = findTunnel(bin, name);
  if (!tunnel) {
    const r = cf(bin, ["tunnel", "create", name]);
    if (r.status !== 0) die(`could not create tunnel:\n${r.stderr || r.stdout}`);
    tunnel = findTunnel(bin, name);
    if (!tunnel) die("tunnel was created but cannot be found");
    ok(`created tunnel ${name}`);
  } else {
    ok(`reusing tunnel ${name}`);
  }
  const route = cf(bin, ["tunnel", "route", "dns", "--overwrite-dns", name, hostname]);
  if (route.status !== 0) die(`could not point ${hostname} at the tunnel:\n${route.stderr || route.stdout}`);
  ok(`${hostname} now points at this PC`);

  const creds = path.join(os.homedir(), ".cloudflared", `${tunnel.id}.json`);
  if (!fs.existsSync(creds)) die(`credentials file missing: ${creds}\nDelete the tunnel in the Cloudflare dashboard and run setup again.`);
  fs.mkdirSync(HOME_DIR, { recursive: true });
  const q = (p) => JSON.stringify(p); // a quoted string is valid YAML, handles Windows backslashes
  fs.writeFileSync(CF_CONFIG, [
    `tunnel: ${tunnel.id}`,
    `credentials-file: ${q(creds)}`,
    "ingress:",
    `  - hostname: ${hostname}`,
    `    service: http://127.0.0.1:${PORT}`,
    "  - service: http_status:404",
    "",
  ].join("\n"));
  return name;
}

// ---------- setup ----------

async function setup() {
  fs.mkdirSync(HOME_DIR, { recursive: true });
  const bin = await ensureCloudflared();
  const env = readEnv();

  // Permanent is the default. A hostname is all it needs.
  let hostname = opt("hostname") || env.TUNNEL_HOSTNAME || "";
  let mode = flag("quick") ? "quick" : "permanent";
  if (mode === "permanent" && !hostname) {
    say("\nPermanent URL (free Cloudflare account + a domain on it).");
    say("Type the address you want, e.g. muse.yourdomain.com. Press Enter to skip and use a temporary URL instead.");
    hostname = await ask("Hostname: ");
    if (!hostname) mode = "quick";
  }

  const roots = opt("roots") || env.WORKER_ROOTS || os.homedir();
  const updates = {
    HOST: "127.0.0.1",
    PORT: String(PORT),
    MCP_TOKEN: env.MCP_TOKEN && !env.MCP_TOKEN.startsWith("change-me") ? env.MCP_TOKEN : crypto.randomBytes(32).toString("hex"),
    WORKER_TOKEN: env.WORKER_TOKEN && !env.WORKER_TOKEN.startsWith("change-me") ? env.WORKER_TOKEN : crypto.randomBytes(32).toString("hex"),
    RELAY_URL: `ws://127.0.0.1:${PORT}/agent`,
    WORKER_NAME: env.WORKER_NAME && env.WORKER_NAME !== "my-pc" ? env.WORKER_NAME : os.hostname(),
    ENGINE: env.ENGINE || "opencode",
    WORKER_ROOTS: roots,
    WORKER_DEFAULT_CWD: env.WORKER_DEFAULT_CWD || roots.split(path.delimiter)[0],
    ALLOW_SHELL: flag("shell") ? "1" : (env.ALLOW_SHELL ?? "0"),
    AUTO_APPROVE: env.AUTO_APPROVE ?? "1",
    TUNNEL_MODE: mode,
  };
  if (mode === "permanent") {
    updates.TUNNEL_NAME = await setupPermanent(bin, hostname);
    updates.TUNNEL_HOSTNAME = hostname;
  }
  writeEnv(updates);
  ok(`wrote ${ENV_FILE} (tokens generated, file is private)`);

  if (!flag("no-service")) await installService();
  else say("\nStart it any time with: npm run tunnel");

  await new Promise((r) => setTimeout(r, 1500));
  await status();
}

// ---------- run (supervisor) ----------

function child(label, command, cmdArgs, { onLine } = {}) {
  let stopped = false;
  let proc;
  const start = () => {
    proc = spawn(command, cmdArgs, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: process.env, windowsHide: true });
    const pipe = (stream) => {
      let buf = "";
      stream.on("data", (d) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, i).replace(/\r$/, "");
          buf = buf.slice(i + 1);
          if (line) { console.log(`[${label}] ${line}`); onLine?.(line); }
        }
      });
    };
    pipe(proc.stdout); pipe(proc.stderr);
    proc.on("exit", (code) => {
      if (stopped) return;
      console.log(`[${label}] exited (${code}), restarting in 3s`);
      setTimeout(start, 3000);
    });
  };
  start();
  return () => { stopped = true; proc?.kill(); };
}

async function run() {
  const env = readEnv();
  if (!env.MCP_TOKEN) die("not set up yet. Run: npm run tunnel -- setup");
  Object.assign(process.env, env);
  const bin = cloudflaredPath();
  if (!bin) die("cloudflared is missing. Run: npm run tunnel -- setup");

  const stops = [];
  stops.push(child("relay", process.execPath, ["src/server/index.js"]));
  await new Promise((r) => setTimeout(r, 800));
  stops.push(child("worker", process.execPath, ["src/worker/index.js"]));

  if (env.TUNNEL_MODE === "quick") {
    stops.push(child("tunnel", bin, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${PORT}`], {
      onLine: (line) => {
        const m = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (m) {
          fs.mkdirSync(HOME_DIR, { recursive: true });
          fs.writeFileSync(URL_FILE, m[0]);
          console.log(`\nMCP URL: ${m[0]}/mcp   (temporary, changes on every start)\n`);
        }
      },
    }));
  } else {
    stops.push(child("tunnel", bin, ["tunnel", "--no-autoupdate", "--config", CF_CONFIG, "run"]));
    console.log(`\nMCP URL: https://${env.TUNNEL_HOSTNAME}/mcp\n`);
  }

  const quit = () => { stops.forEach((s) => s()); setTimeout(() => process.exit(0), 300); };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
}

// ---------- autostart ----------

const SERVICE = "muse-relay";
const unitPath = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "systemd", "user", `${SERVICE}.service`);

async function installService() {
  const self = fileURLToPath(import.meta.url);
  if (WIN) {
    const tr = `"${process.execPath}" "${self}" run`;
    const del = spawnSync("schtasks", ["/Delete", "/TN", SERVICE, "/F"], { stdio: "ignore" });
    void del;
    const r = spawnSync("schtasks", ["/Create", "/TN", SERVICE, "/TR", tr, "/SC", "ONLOGON", "/RL", "LIMITED", "/F"], { encoding: "utf8" });
    if (r.status !== 0) { say(`warn  could not register autostart: ${r.stderr || r.stdout}`); return; }
    spawnSync("schtasks", ["/Run", "/TN", SERVICE], { stdio: "ignore" });
    ok("autostart installed (Task Scheduler, runs at logon) and started");
    return;
  }
  fs.mkdirSync(path.dirname(unitPath), { recursive: true });
  fs.writeFileSync(unitPath, [
    "[Unit]", "Description=Muse relay (relay + worker + Cloudflare tunnel)", "After=network-online.target", "",
    "[Service]", `WorkingDirectory=${ROOT}`, `ExecStart=${process.execPath} ${self} run`, "Restart=always", "RestartSec=5", "",
    "[Install]", "WantedBy=default.target", "",
  ].join("\n"));
  spawnSync("systemctl", ["--user", "daemon-reload"]);
  const r = spawnSync("systemctl", ["--user", "enable", "--now", SERVICE], { encoding: "utf8" });
  if (r.status !== 0) { say(`warn  could not start the service: ${r.stderr}\n      run it by hand with: npm run tunnel -- run`); return; }
  spawnSync("systemctl", ["--user", "restart", SERVICE]);
  const linger = spawnSync("loginctl", ["enable-linger", os.userInfo().username], { stdio: "ignore" });
  ok(`autostart installed (systemd --user) and started${linger.status === 0 ? "" : "; run `sudo loginctl enable-linger $USER` to keep it running after logout"}`);
}

function removeService() {
  if (WIN) {
    spawnSync("schtasks", ["/End", "/TN", SERVICE], { stdio: "ignore" });
    spawnSync("schtasks", ["/Delete", "/TN", SERVICE, "/F"], { stdio: "ignore" });
  } else {
    spawnSync("systemctl", ["--user", "disable", "--now", SERVICE], { stdio: "ignore" });
    fs.rmSync(unitPath, { force: true });
    spawnSync("systemctl", ["--user", "daemon-reload"]);
  }
  ok("autostart removed");
}

// ---------- status ----------

async function status() {
  const env = readEnv();
  const base = env.TUNNEL_MODE === "quick"
    ? (fs.existsSync(URL_FILE) ? fs.readFileSync(URL_FILE, "utf8").trim() : "")
    : (env.TUNNEL_HOSTNAME ? `https://${env.TUNNEL_HOSTNAME}` : "");
  let local = null;
  try { local = await (await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(2000) })).json(); } catch { /* not running */ }
  say("");
  say(local ? `Relay:    running, workers online: ${local.workers.map((w) => w.name).join(", ") || "none yet"}` : "Relay:    not running (start it with: npm run tunnel -- run)");
  if (base) {
    say(`MCP URL:  ${base}/mcp`);
    say(`Header:   Authorization: Bearer ${env.MCP_TOKEN}`);
    say("\nAdd those two in Muse as a remote MCP server (streamable HTTP).");
  } else {
    say("MCP URL:  not known yet. A temporary URL appears once the tunnel is up. Run status again.");
  }
}

// ---------- main ----------

const commands = {
  setup,
  run,
  service: installService,
  unservice: async () => removeService(),
  status,
};
if (!commands[cmd]) die(`unknown command "${cmd}". Use: ${Object.keys(commands).join(", ")}`);
await commands[cmd]();
