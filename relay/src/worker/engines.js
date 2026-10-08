// How a prompt becomes a process. Each engine runs headless and prints to stdout.
// mode "opencode-json" means the output is an event stream to be parsed, not plain text.
export function agentCommand(prompt, { session, model, agent, cwd } = {}) {
  const engine = (process.env.ENGINE || "opencode").toLowerCase();
  const autoApprove = process.env.AUTO_APPROVE !== "0";

  if (engine === "opencode") {
    const args = ["run", "--format", "json"];
    // opencode picks its own project root and ignores the process cwd, so the
    // folder has to be named explicitly or the agent works in the wrong place.
    if (cwd) args.push("--dir", cwd);
    if (autoApprove) args.push("--auto"); // there is no TTY to answer a permission prompt
    if (session) args.push("--session", session);
    if (model || process.env.AGENT_MODEL) args.push("--model", model || process.env.AGENT_MODEL);
    if (agent || process.env.AGENT_PROFILE) args.push("--agent", agent || process.env.AGENT_PROFILE);
    args.push(prompt);
    return { file: "opencode", args, mode: "opencode-json" };
  }

  if (engine === "claude") {
    const args = ["-p", prompt, "--output-format", "text"];
    args.push("--permission-mode", autoApprove ? "acceptEdits" : "default");
    if (session) args.push("--resume", session);
    if (model || process.env.AGENT_MODEL) args.push("--model", model || process.env.AGENT_MODEL);
    return { file: "claude", args, mode: "text" };
  }

  if (engine === "custom") {
    const template = process.env.CUSTOM_AGENT_CMD;
    if (!template) throw new Error("ENGINE=custom needs CUSTOM_AGENT_CMD in .env");
    // The prompt is passed through argv, never spliced into a shell string.
    const parts = template.split(/\s+/).filter(Boolean);
    const [file, ...args] = parts.map((part) => (part === "{{PROMPT}}" ? prompt : part));
    if (!args.includes(prompt) && file !== prompt) args.push(prompt);
    return { file, args, mode: "text" };
  }

  throw new Error(`Unknown ENGINE "${engine}". Use opencode, claude or custom.`);
}
