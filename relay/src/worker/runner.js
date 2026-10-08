import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { agentCommand } from "./engines.js";
import { OpencodeStream } from "./opencode.js";
import { getSession, setSession } from "./sessions.js";

// cmd.exe quoting for an argument handed to a .cmd shim.
const winQuote = (arg) => `"${String(arg).replace(/"/g, '\\"').replace(/%/g, "%%")}"`;

const OUTPUT_CAP = 200_000; // characters kept from a task's stdout

export class Runner {
  constructor({ roots, defaultCwd, timeoutSeconds, allowShell, onLog }) {
    this.roots = roots;
    this.defaultCwd = defaultCwd;
    this.timeoutSeconds = timeoutSeconds;
    this.allowShell = allowShell;
    this.onLog = onLog;
    this.running = new Map(); // taskId -> child process
  }

  // Every path a task touches has to sit inside an allowed root.
  resolvePath(candidate, { mustExist = false } = {}) {
    const target = path.resolve(candidate ?? this.defaultCwd);
    const allowed = this.roots.some(
      (root) => target === root || target.startsWith(root + path.sep)
    );
    if (!allowed) {
      throw new Error(`Path "${target}" is outside the allowed roots: ${this.roots.join(", ")}`);
    }
    if (mustExist) return target;
    return target;
  }

  cancel(taskId) {
    const child = this.running.get(taskId);
    if (child) child.kill("SIGTERM");
  }

  async handle(task) {
    switch (task.kind) {
      case "agent": {
        // A named session continues the same conversation on the next prompt.
        const cwd = task.cwd ?? this.defaultCwd;
        const priorSession = task.session ? getSession(task.session, cwd) : null;
        const { file, args, mode } = agentCommand(task.prompt, {
          session: priorSession,
          model: task.model,
          agent: task.agent,
          cwd,
        });
        // On Windows opencode/claude are .cmd shims, which only spawn through a shell.
        const result = await this.spawnTask(task, file, args, { shell: false, mode });
        if (task.session && result.sessionId) setSession(task.session, cwd, result.sessionId);
        if (task.session) {
          result.session = task.session;
          result.continued = Boolean(priorSession);
        }
        return result;
      }
      case "shell": {
        if (!this.allowShell) return { ok: false, error: "shell access is disabled on this worker" };
        return this.spawnTask(task, task.command, [], { shell: true });
      }
      case "fs":
        return this.fileOp(task);
      default:
        return { ok: false, error: `unknown task kind "${task.kind}"` };
    }
  }

  async fileOp(task) {
    try {
      const target = this.resolvePath(task.path);
      if (task.op === "list") {
        const entries = await fs.readdir(target, { withFileTypes: true });
        const listing = entries
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .sort()
          .join("\n");
        return { ok: true, output: listing || "(empty directory)" };
      }
      if (task.op === "read") {
        const content = await fs.readFile(target, "utf8");
        return { ok: true, output: content.slice(0, OUTPUT_CAP) };
      }
      if (task.op === "write") {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, task.content, "utf8");
        return { ok: true, output: `wrote ${Buffer.byteLength(task.content)} bytes to ${target}` };
      }
      return { ok: false, error: `unknown file op "${task.op}"` };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  spawnTask(task, file, args, { shell, mode = "text" }) {
    return new Promise((resolve) => {
      let cwd;
      try {
        cwd = this.resolvePath(task.cwd);
      } catch (err) {
        return resolve({ ok: false, error: err.message });
      }

      let child;
      try {
        const winShim = process.platform === "win32" && !shell;
        child = spawn(file, winShim ? args.map(winQuote) : args, {
          cwd,
          shell: shell || winShim,
          env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        return resolve({ ok: false, error: `failed to start: ${err.message}` });
      }

      this.running.set(task.id, child);
      const events = mode === "opencode-json" ? new OpencodeStream() : null;
      let output = "";
      let settled = false;

      const collect = (stream) => (chunk) => {
        const raw = chunk.toString();
        // stdout of an event stream is parsed; stderr is always plain text.
        const readable = events && stream === "stdout" ? events.push(raw) : raw;
        if (!readable) return;
        if (!events && output.length < OUTPUT_CAP) output += readable;
        this.onLog(task.id, stream, readable);
      };
      child.stdout.on("data", collect("stdout"));
      child.stderr.on("data", collect("stderr"));

      const timer = setTimeout(() => {
        this.onLog(task.id, "stderr", `\n[worker] timeout after ${this.timeoutSeconds}s, killing\n`);
        child.kill("SIGKILL");
      }, this.timeoutSeconds * 1000);
      timer.unref?.();

      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.running.delete(task.id);
        resolve(result);
      };

      child.on("error", (err) => finish({ ok: false, error: err.message, output }));
      child.on("close", (code, signal) => {
        if (events) {
          const tail = events.flush();
          if (tail) this.onLog(task.id, "stdout", tail);
          output = events.finalText();
        }
        finish({
          ok: code === 0 && !events?.error,
          exitCode: code,
          output: output.slice(0, OUTPUT_CAP),
          sessionId: events?.sessionId ?? null,
          cost: events?.cost ?? null,
          tokens: events?.tokens ?? null,
          error:
            events?.error ??
            (code === 0 ? null : `exited with ${signal ? `signal ${signal}` : `code ${code}`}`),
        });
      });
    });
  }
}
