import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const STORE = path.resolve(here, "..", "..", "data", "inbox.json");

// Muse dials in; nothing on the VPS can ring it. So messages you send from your
// own machine wait here, and Muse collects them when it next calls muse_inbox.
export class Inbox {
  constructor({ limit = 500 } = {}) {
    this.limit = limit;
    this.messages = this.load();
  }

  // The inbox outlives a relay restart, so a message you send while the remote
  // agent is away is still waiting when it next checks in.
  load() {
    try {
      return JSON.parse(fs.readFileSync(STORE, "utf8"));
    } catch {
      return [];
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(STORE), { recursive: true });
      fs.writeFileSync(STORE, JSON.stringify(this.messages));
    } catch (err) {
      console.error("[inbox] could not persist:", err.message);
    }
  }

  post({ from, text }) {
    const message = {
      id: crypto.randomUUID().slice(0, 8),
      from: from || "operator",
      text,
      createdAt: Date.now(),
      deliveredAt: null,
      replies: [],
    };
    this.messages.push(message);
    if (this.messages.length > this.limit) this.messages.shift();
    this.save();
    return message;
  }

  pending() {
    return this.messages.filter((m) => !m.deliveredAt);
  }

  markDelivered(ids) {
    const at = Date.now();
    for (const message of this.messages) {
      if (ids.includes(message.id)) message.deliveredAt = at;
    }
    this.save();
  }

  reply(messageId, text) {
    const message = this.messages.find((m) => m.id === messageId);
    if (!message) return null;
    const reply = { at: Date.now(), text };
    message.replies.push(reply);
    this.save();
    return message;
  }

  since(timestamp = 0) {
    return this.messages
      .filter((m) => m.createdAt > timestamp || m.replies.some((r) => r.at > timestamp))
      .map((m) => ({
        id: m.id,
        from: m.from,
        text: m.text,
        sent_at: new Date(m.createdAt).toISOString(),
        picked_up: m.deliveredAt ? new Date(m.deliveredAt).toISOString() : null,
        replies: m.replies.map((r) => ({ at: new Date(r.at).toISOString(), text: r.text })),
      }));
  }
}
