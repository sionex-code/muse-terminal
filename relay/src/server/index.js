import crypto from "node:crypto";
import http from "node:http";
import express from "express";
import { WebSocketServer } from "ws";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadEnv, need, num } from "../shared/env.js";
import { parse, send } from "../shared/protocol.js";
import { Hub } from "./hub.js";
import { Inbox } from "./inbox.js";
import { buildMcpServer } from "./tools.js";

loadEnv();

const PORT = num("PORT", 8787);
const HOST = process.env.HOST || "127.0.0.1";

// Each token can be given as plaintext (MCP_TOKEN) or as a SHA-256 hex digest
// (MCP_TOKEN_SHA256). With the digest, the server never holds the secret itself:
// anyone reading .env on this machine cannot recover a working token.
const sha256 = (value) => crypto.createHash("sha256").update(String(value)).digest();
function tokenDigest(name) {
  const hex = process.env[`${name}_SHA256`];
  if (hex) {
    if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error(`${name}_SHA256 must be 64 hex characters`);
    return Buffer.from(hex, "hex");
  }
  return sha256(need(name));
}
const MCP_DIGEST = tokenDigest("MCP_TOKEN");
const WORKER_DIGEST = tokenDigest("WORKER_TOKEN");
const tokenMatches = (given, digest) =>
  typeof given === "string" && crypto.timingSafeEqual(sha256(given), digest);

const hub = new Hub({
  logLimit: num("TASK_LOG_LIMIT", 4000),
  taskTtlSeconds: num("TASK_TTL_SECONDS", 3600),
});

const inbox = new Inbox();

const app = express();
app.use(express.json({ limit: "8mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, workers: hub.listWorkers(), tasks: hub.tasks.size, inbox: inbox.pending().length });
});

function authorized(req) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : req.headers["x-api-key"];
  return tokenMatches(token, MCP_DIGEST);
}

// Stateless MCP: one server and transport per request, so any number of remote
// clients (Muse, Claude Code, opencode) can talk to the relay at once.
app.post("/mcp", async (req, res) => {
  if (!authorized(req)) {
    return res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized" },
      id: null,
    });
  }
  const server = buildMcpServer(hub, { inbox });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[mcp] request failed:", err);
    if (!res.headersSent) res.status(500).json({ error: "internal error" });
  }
});

// Stateless mode has no server initiated stream and no session to delete.
const notAllowed = (_req, res) =>
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed" },
    id: null,
  });
app.get("/mcp", notAllowed);
app.delete("/mcp", notAllowed);

const httpServer = http.createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: "/agent" });

wss.on("connection", (ws) => {
  let worker = null;
  ws.isAlive = true;

  ws.on("message", (raw) => {
    const msg = parse(raw);
    if (!msg) return;

    if (msg.t === "hello") {
      if (!tokenMatches(msg.token, WORKER_DIGEST)) {
        send(ws, { t: "deny", reason: "bad worker token" });
        return ws.close(4001, "unauthorized");
      }
      if (!msg.name) {
        send(ws, { t: "deny", reason: "missing worker name" });
        return ws.close(4002, "missing name");
      }
      worker = hub.addWorker({
        ws,
        name: msg.name,
        roots: msg.roots,
        engine: msg.engine,
        allowShell: msg.allowShell,
      });
      send(ws, { t: "welcome", workerId: worker.id });
      console.log(`[hub] worker online: ${worker.name} (${worker.engine})`);
      return;
    }

    if (!worker) return ws.close(4003, "hello first");
    worker.lastSeen = Date.now();

    switch (msg.t) {
      case "log":
        hub.appendLog(msg.id, msg.stream === "stderr" ? "stderr" : "stdout", msg.data);
        break;
      case "done":
        hub.finishTask(msg.id, {
          ok: Boolean(msg.ok),
          exitCode: msg.exitCode ?? null,
          output: msg.output ?? "",
          error: msg.error ?? null,
          session: msg.session ?? null,
          continued: msg.continued ?? undefined,
          cost: msg.cost ?? null,
          tokens: msg.tokens ?? null,
        });
        break;
      case "pong":
        ws.isAlive = true;
        break;
      default:
        break;
    }
  });

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("close", () => {
    if (worker) {
      hub.removeWorker(worker.id);
      console.log(`[hub] worker offline: ${worker.name}`);
    }
  });

  ws.on("error", (err) => console.error("[hub] worker socket error:", err.message));
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);
heartbeat.unref?.();

httpServer.listen(PORT, HOST, () => {
  console.log(`[relay] MCP endpoint  http://${HOST}:${PORT}/mcp`);
  console.log(`[relay] worker socket ws://${HOST}:${PORT}/agent`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`[relay] ${signal}, shutting down`);
    httpServer.close(() => process.exit(0));
  });
}
