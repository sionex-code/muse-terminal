import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const text = (value) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

const fail = (message) => ({ ...text(message), isError: true });

function renderLogs(task, limit = 200) {
  const lines = task.logs.slice(-limit).map((l) => (l.stream === "stderr" ? `! ${l.line}` : l.line));
  const head = task.truncated ? [`... ${task.truncated} earlier lines dropped ...`] : [];
  return [...head, ...lines].join("\n");
}

function taskView(task, { withLogs = true, logLimit = 200 } = {}) {
  const view = {
    task_id: task.id,
    worker: task.workerName,
    kind: task.kind,
    state: task.state,
    cwd: task.cwd,
    started_at: new Date(task.startedAt).toISOString(),
    seconds: Math.round(((task.endedAt ?? Date.now()) - task.startedAt) / 1000),
  };
  if (task.result) {
    view.ok = task.result.ok;
    view.exit_code = task.result.exitCode ?? null;
    if (task.result.error) view.error = task.result.error;
    if (task.result.output) view.output = task.result.output;
    if (task.result.session) view.session = task.result.session;
    if (task.result.continued !== undefined) view.continued_session = task.result.continued;
    if (task.result.cost) view.cost_usd = Number(task.result.cost.toFixed(4));
  }
  if (withLogs) view.log = renderLogs(task, logLimit);
  return view;
}

// Resolve which machine a call is for, and say clearly what to do when it is ambiguous.
function resolveWorker(hub, name) {
  const worker = hub.pickWorker(name);
  if (worker) return { worker };
  const online = hub.listWorkers().filter((w) => w.online);
  if (online.length === 0) {
    return { error: "No worker machine is connected to the relay right now." };
  }
  if (!name) {
    return {
      error: `Several workers are online, name one: ${online.map((w) => w.name).join(", ")}`,
    };
  }
  return { error: `No online worker named "${name}". Online: ${online.map((w) => w.name).join(", ")}` };
}

export function buildMcpServer(hub, { inbox, defaultWaitSeconds = 120 } = {}) {
  const server = new McpServer(
    { name: "muse-mcp-relay", version: "0.1.0" },
    {
      instructions: [
        "This server is a relay to the user's own machines. Each connected worker runs a coding agent",
        "(opencode or claude) inside real project folders.",
        "Call muse_list_workers first to learn which machines are online and which directories they allow.",
        "Use muse_run_agent for anything that needs reasoning over a codebase: give a complete, self contained",
        "instruction, because the worker agent does not see this conversation.",
        "Use muse_run_shell only for short, exact commands.",
        "Pass the same session name on follow up calls so the coding agent keeps the earlier turns in context.",
        "Long tasks return a task_id, then poll muse_task_status until the state is done or failed.",
        "Call muse_inbox at the start of a turn to collect anything the operator sent you, and answer with muse_reply.",
      ].join(" "),
    }
  );

  server.registerTool(
    "muse_list_workers",
    {
      title: "List worker machines",
      description: "List the machines connected to this relay, with their engine and allowed directories.",
      inputSchema: {},
    },
    async () => {
      const workers = hub.listWorkers();
      if (workers.length === 0) return text("No worker machines are connected.");
      return text({ workers });
    }
  );

  server.registerTool(
    "muse_run_agent",
    {
      title: "Run a coding agent on a machine",
      description:
        "Send a prompt to the coding agent on a worker machine. It runs in a real folder and can read and change files. Returns the agent output, or a task_id if it is still running when the wait expires.",
      inputSchema: {
        prompt: z.string().min(1).describe("Complete, self contained instruction for the coding agent."),
        worker: z.string().optional().describe("Worker name. Optional when only one machine is online."),
        cwd: z.string().optional().describe("Absolute path of the folder to work in. Must be inside the worker roots."),
        wait_seconds: z.number().int().min(0).max(600).optional().describe("How long to wait before returning a task_id instead."),
        session: z
          .string()
          .optional()
          .describe(
            "Name a thread, for example 'refactor-auth', to continue the same conversation on later calls. Reuse the same name and the agent remembers the earlier turns."
          ),
        model: z.string().optional().describe("Override the model, as provider/model."),
        agent: z.string().optional().describe("Override the agent profile on the worker."),
      },
    },
    async ({ prompt, worker: name, cwd, wait_seconds, session, model, agent }) => {
      const { worker, error } = resolveWorker(hub, name);
      if (error) return fail(error);
      const task = hub.startTask(worker, { kind: "agent", prompt, cwd, session, model, agent });
      const waited = await hub.waitForTask(task.id, (wait_seconds ?? defaultWaitSeconds) * 1000);
      if (waited.state === "running") {
        return text({
          ...taskView(waited, { logLimit: 60 }),
          note: "Still running. Poll muse_task_status with this task_id.",
        });
      }
      return text(taskView(waited, { logLimit: 400 }));
    }
  );

  server.registerTool(
    "muse_run_shell",
    {
      title: "Run a shell command on a machine",
      description: "Run one shell command on a worker machine and return its output. Blocked unless that worker enabled shell access.",
      inputSchema: {
        command: z.string().min(1),
        worker: z.string().optional(),
        cwd: z.string().optional(),
        wait_seconds: z.number().int().min(0).max(600).optional(),
      },
    },
    async ({ command, worker: name, cwd, wait_seconds }) => {
      const { worker, error } = resolveWorker(hub, name);
      if (error) return fail(error);
      if (!worker.allowShell) return fail(`Worker "${worker.name}" has shell access turned off.`);
      const task = hub.startTask(worker, { kind: "shell", command, cwd });
      const waited = await hub.waitForTask(task.id, (wait_seconds ?? 60) * 1000);
      return text(taskView(waited, { logLimit: 400 }));
    }
  );

  server.registerTool(
    "muse_files",
    {
      title: "Read, write or list files on a machine",
      description: "Direct file access on a worker machine, for when a full agent run is not needed.",
      inputSchema: {
        op: z.enum(["list", "read", "write"]),
        path: z.string().min(1).describe("Absolute path inside one of the worker roots."),
        content: z.string().optional().describe("Required for op=write."),
        worker: z.string().optional(),
      },
    },
    async ({ op, path: target, content, worker: name }) => {
      const { worker, error } = resolveWorker(hub, name);
      if (error) return fail(error);
      if (op === "write" && typeof content !== "string") return fail("op=write needs content.");
      const task = hub.startTask(worker, { kind: "fs", op, path: target, content });
      const waited = await hub.waitForTask(task.id, 30_000);
      if (waited.state === "running") return fail("File operation timed out.");
      if (!waited.result?.ok) return fail(waited.result?.error ?? "File operation failed.");
      return text(waited.result.output ?? "ok");
    }
  );

  server.registerTool(
    "muse_task_status",
    {
      title: "Check a task",
      description: "Get the state, output and recent log of a task started earlier.",
      inputSchema: {
        task_id: z.string().min(1),
        log_lines: z.number().int().min(0).max(2000).optional(),
      },
    },
    async ({ task_id, log_lines }) => {
      const task = hub.tasks.get(task_id);
      if (!task) return fail("Unknown task_id. It may have expired.");
      return text(taskView(task, { logLimit: log_lines ?? 200 }));
    }
  );

  server.registerTool(
    "muse_cancel_task",
    {
      title: "Cancel a task",
      description: "Stop a running task on the worker machine.",
      inputSchema: { task_id: z.string().min(1) },
    },
    async ({ task_id }) => {
      const result = hub.cancelTask(task_id);
      return result.ok ? text("Cancel signal sent.") : fail(result.error);
    }
  );

  if (inbox) {
    server.registerTool(
      "muse_inbox",
      {
        title: "Collect messages from the operator",
        description:
          "Pick up messages the machine owner sent you. Call this at the start of a turn. Each message is handed over once, so answer it with muse_reply.",
        inputSchema: {
          peek: z.boolean().optional().describe("Read without marking the messages as collected."),
        },
      },
      async ({ peek }) => {
        const pending = inbox.pending();
        if (pending.length === 0) return text("No new messages.");
        if (!peek) inbox.markDelivered(pending.map((m) => m.id));
        return text({
          messages: pending.map((m) => ({
            message_id: m.id,
            from: m.from,
            sent_at: new Date(m.createdAt).toISOString(),
            text: m.text,
          })),
        });
      }
    );

    server.registerTool(
      "muse_reply",
      {
        title: "Reply to the operator",
        description: "Send an answer back to the machine owner for a message you collected from the inbox.",
        inputSchema: {
          message_id: z.string().min(1),
          text: z.string().min(1),
        },
      },
      async ({ message_id, text: body }) => {
        const message = inbox.reply(message_id, body);
        return message ? text("Reply delivered.") : fail("Unknown message_id.");
      }
    );

    server.registerTool(
      "relay_send",
      {
        title: "Send a message to the remote agent",
        description:
          "Operator side. Queue a message for the remote agent to collect on its next turn. Nothing can wake it, so it arrives when the agent next checks in.",
        inputSchema: {
          text: z.string().min(1),
          from: z.string().optional(),
        },
      },
      async ({ text: body, from }) => {
        const message = inbox.post({ from, text: body });
        return text({
          message_id: message.id,
          queued_at: new Date(message.createdAt).toISOString(),
          note: "Waiting for the remote agent to call muse_inbox.",
        });
      }
    );

    server.registerTool(
      "relay_thread",
      {
        title: "Read the operator thread",
        description: "Operator side. Show messages you sent to the remote agent and any replies it left.",
        inputSchema: {
          since_iso: z.string().optional().describe("Only show activity after this ISO timestamp."),
        },
      },
      async ({ since_iso }) => {
        const cutoff = since_iso ? Date.parse(since_iso) : 0;
        const thread = inbox.since(Number.isFinite(cutoff) ? cutoff : 0);
        if (thread.length === 0) return text("The thread is empty.");
        return text({ thread });
      }
    );
  }

  return server;
}
