// opencode --format json prints one JSON event per line. This turns that stream
// into readable progress lines, and pulls out the session id, the final reply
// and the cost.
export class OpencodeStream {
  constructor() {
    this.buffer = "";
    this.sessionId = null;
    this.textParts = [];
    this.cost = 0;
    this.tokens = null;
    this.error = null;
  }

  // Returns the human readable lines to forward as logs.
  push(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    const out = [];
    for (const line of lines) {
      const rendered = this.consume(line);
      if (rendered) out.push(rendered);
    }
    return out.join("\n") + (out.length ? "\n" : "");
  }

  flush() {
    if (!this.buffer.trim()) return "";
    const rendered = this.consume(this.buffer);
    this.buffer = "";
    return rendered ? rendered + "\n" : "";
  }

  consume(line) {
    const trimmed = line.trim();
    if (!trimmed) return "";
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return trimmed; // not JSON, pass it through rather than swallow it
    }
    if (event.sessionID && !this.sessionId) this.sessionId = event.sessionID;
    const part = event.part ?? {};

    switch (event.type) {
      case "text":
        if (part.text) {
          this.textParts.push(part.text);
          return part.text;
        }
        return "";
      case "reasoning":
        return part.text ? `[thinking] ${part.text.slice(0, 200)}` : "";
      case "tool_use":
      case "tool": {
        const name = part.tool ?? part.name ?? "tool";
        const status = part.state?.status ?? "";
        const title = part.state?.title ?? "";
        return `[${name}${status ? " " + status : ""}]${title ? " " + title : ""}`;
      }
      case "step_finish":
        if (part.cost) this.cost += part.cost;
        if (part.tokens) this.tokens = part.tokens;
        return "";
      case "error":
        this.error = part.message ?? event.message ?? "opencode reported an error";
        return `[error] ${this.error}`;
      case "step_start":
        return "";
      default:
        return "";
    }
  }

  // The assistant's reply, which is what the remote agent actually wants back.
  finalText() {
    return this.textParts.join("").trim();
  }
}
