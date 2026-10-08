import crypto from "node:crypto";
import { send } from "../shared/protocol.js";

// The hub is the translator's memory: which worker machines are online,
// which tasks are in flight, and what each task has printed so far.
export class Hub {
  constructor({ logLimit = 4000, taskTtlSeconds = 3600 } = {}) {
    this.logLimit = logLimit;
    this.taskTtlSeconds = taskTtlSeconds;
    this.workers = new Map(); // workerId -> worker
    this.tasks = new Map(); // taskId -> task
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref?.();
  }

  addWorker({ ws, name, roots, engine, allowShell }) {
    // A reconnecting machine keeps its name, so Muse can address it the same way.
    for (const [id, existing] of this.workers) {
      if (existing.name === name) {
        try { existing.ws.close(4000, "replaced by a new connection"); } catch {}
        this.workers.delete(id);
      }
    }
    const worker = {
      id: crypto.randomUUID(),
      name,
      roots: roots ?? [],
      engine: engine ?? "unknown",
      allowShell: Boolean(allowShell),
      connectedAt: Date.now(),
      lastSeen: Date.now(),
      ws,
    };
    this.workers.set(worker.id, worker);
    return worker;
  }

  removeWorker(workerId) {
    this.workers.delete(workerId);
    for (const task of this.tasks.values()) {
      if (task.workerId === workerId && task.state === "running") {
        this.finishTask(task.id, {
          ok: false,
          error: "worker disconnected before the task finished",
        });
      }
    }
  }

  listWorkers() {
    return [...this.workers.values()].map((w) => ({
      name: w.name,
      engine: w.engine,
      roots: w.roots,
      allowShell: w.allowShell,
      online: w.ws.readyState === 1,
      connectedAt: new Date(w.connectedAt).toISOString(),
    }));
  }

  pickWorker(name) {
    const online = [...this.workers.values()].filter((w) => w.ws.readyState === 1);
    if (name) return online.find((w) => w.name === name) ?? null;
    if (online.length === 1) return online[0];
    return null;
  }

  startTask(worker, payload) {
    const task = {
      id: crypto.randomUUID(),
      workerId: worker.id,
      workerName: worker.name,
      kind: payload.kind,
      summary: payload.prompt ?? payload.command ?? payload.op ?? payload.kind,
      cwd: payload.cwd ?? null,
      state: "running",
      startedAt: Date.now(),
      endedAt: null,
      logs: [],
      truncated: 0,
      result: null,
      waiters: new Set(),
    };
    this.tasks.set(task.id, task);
    send(worker.ws, { t: "task", id: task.id, ...payload });
    return task;
  }

  appendLog(taskId, stream, data) {
    const task = this.tasks.get(taskId);
    if (!task) return;
    for (const line of String(data).split("\n")) {
      if (!line) continue;
      task.logs.push({ at: Date.now(), stream, line });
    }
    if (task.logs.length > this.logLimit) {
      const drop = task.logs.length - this.logLimit;
      task.logs.splice(0, drop);
      task.truncated += drop;
    }
  }

  finishTask(taskId, result) {
    const task = this.tasks.get(taskId);
    if (!task || task.state !== "running") return;
    task.state = result.ok ? "done" : "failed";
    task.endedAt = Date.now();
    task.result = result;
    for (const resolve of task.waiters) resolve(task);
    task.waiters.clear();
  }

  // Resolves when the task ends, or after ms, whichever comes first.
  waitForTask(taskId, ms) {
    const task = this.tasks.get(taskId);
    if (!task) return Promise.resolve(null);
    if (task.state !== "running") return Promise.resolve(task);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        task.waiters.delete(done);
        resolve(task);
      };
      const timer = setTimeout(() => {
        task.waiters.delete(done);
        resolve(task);
      }, ms);
      timer.unref?.();
      task.waiters.add(done);
    });
  }

  cancelTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return { ok: false, error: "unknown task id" };
    if (task.state !== "running") return { ok: false, error: `task is already ${task.state}` };
    const worker = this.workers.get(task.workerId);
    if (worker) send(worker.ws, { t: "cancel", id: taskId });
    return { ok: true };
  }

  sweep() {
    const cutoff = Date.now() - this.taskTtlSeconds * 1000;
    for (const [id, task] of this.tasks) {
      if (task.state !== "running" && task.endedAt && task.endedAt < cutoff) {
        this.tasks.delete(id);
      }
    }
  }
}
