#!/usr/bin/env node
// Operator CLI. Talks to the relay as a plain MCP client, so you can drive it
// from a terminal without wiring up Claude Code or opencode first.
import { loadEnv, need } from "./shared/env.js";

loadEnv();

const URL = process.env.RELAY_MCP_URL || `http://127.0.0.1:${process.env.PORT || 8787}/mcp`;
const TOKEN = need("MCP_TOKEN");

let id = 0;

async function call(name, args = {}) {
  const res = await fetch(URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++id,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${URL}`);
  const body = await res.text();
  // The endpoint answers as JSON, or as an SSE stream that also carries
  // ": keepalive" comment lines while a slow call is still running.
  const dataLines = body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6));
  const payload = dataLines.length ? dataLines[dataLines.length - 1] : body;
  const json = JSON.parse(payload);
  if (json.error) throw new Error(json.error.message);
  return json.result.content.map((c) => c.text).join("\n");
}

const [command, ...rest] = process.argv.slice(2);
const joined = rest.join(" ");

const usage = `muse-mcp operator cli

  workers                       list the machines connected to the relay
  send <text>                   queue a message for the remote agent
  thread                        show your messages and the agent's replies
  run <prompt>                  run a prompt on a worker yourself
  status <task_id>              check a running task
  cancel <task_id>              stop a running task

  Options for run:  --worker <name>  --cwd <path>  --session <name>
  Endpoint: ${URL}`;

try {
  switch (command) {
    case "workers":
      console.log(await call("muse_list_workers"));
      break;
    case "send":
      if (!joined) throw new Error("send needs a message");
      console.log(await call("relay_send", { text: joined, from: process.env.USER || "operator" }));
      break;
    case "thread":
      console.log(await call("relay_thread", {}));
      break;
    case "run": {
      const args = {};
      const words = [];
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === "--worker") args.worker = rest[++i];
        else if (rest[i] === "--cwd") args.cwd = rest[++i];
        else if (rest[i] === "--session") args.session = rest[++i];
        else words.push(rest[i]);
      }
      if (!words.length) throw new Error("run needs a prompt");
      args.prompt = words.join(" ");
      console.log(await call("muse_run_agent", args));
      break;
    }
    case "status":
      console.log(await call("muse_task_status", { task_id: joined }));
      break;
    case "cancel":
      console.log(await call("muse_cancel_task", { task_id: joined }));
      break;
    default:
      console.log(usage);
  }
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(1);
}
