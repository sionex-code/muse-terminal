# Relay

A relay that lets a remote agent (Muse, or any MCP client) work on files and code
on your own machines, through your VPS.

```
Muse  ──remote MCP over HTTPS──▶  VPS relay  ──persistent websocket──▶  worker on your PC
                                (translator)                            opencode / claude
                                                                        runs in your folders
```

The VPS is the translator. It speaks MCP to whoever connects, and a small task
protocol to every machine that registers as a worker. Your PC dials out to the
VPS, so it needs no open port, no static IP and no port forwarding.

Your own machine can also connect to the same `/mcp` endpoint from Claude Code or
opencode, so you can drive another registered worker the same way Muse does.

## Parts

| Path | Runs on | What it does |
| --- | --- | --- |
| `src/server/index.js` | VPS | HTTP MCP endpoint at `/mcp`, worker socket at `/agent` |
| `src/server/tools.js` | VPS | The six MCP tools exposed to remote agents |
| `src/server/hub.js` | VPS | Worker registry, task queue, log buffers |
| `src/worker/index.js` | your PC | Dials the relay, receives tasks, reports back |
| `src/worker/runner.js` | your PC | Runs processes, enforces the allowed roots |
| `src/worker/engines.js` | your PC | Turns a prompt into an opencode or claude command |

## Tools the remote agent sees

- `muse_list_workers` - which machines are online, their engine and allowed folders
- `muse_run_agent` - send a prompt to the coding agent on a machine, in a folder
- `muse_run_shell` - run one shell command (only if that worker enabled it)
- `muse_files` - list, read or write a single file
- `muse_task_status` - poll a long running task
- `muse_cancel_task` - stop a running task
- `muse_inbox` - collect messages you sent from your own machine
- `muse_reply` - answer one of those messages
- `relay_send` / `relay_thread` - your side of that conversation

Long runs do not block the caller. `muse_run_agent` waits up to `wait_seconds`
(120 by default), then hands back a `task_id` to poll.

## opencode has no API, and does not need one

The worker does not call opencode over HTTP. It runs the `opencode` binary as a
child process with `run --format json`, reads the event stream it prints, and
sends the result back up the socket. Muse is operating the same CLI you would
type, one level removed.

That event stream is why the relay can report more than raw text: it carries the
session id, each tool the agent used, the final reply and the cost. So a task
comes back as

```json
{
  "state": "done",
  "output": "A VPS relay that lets a remote MCP agent run coding tasks on your own PC.",
  "session": "tools4",
  "continued_session": false,
  "cost_usd": 0.0065,
  "log": "[read completed] /home/you/projects/muse-mcp/README.md\nA VPS relay that ..."
}
```

### Sessions

`opencode run` is one shot by default: every prompt would start cold. So
`muse_run_agent` takes a `session` name. Reuse the name and the conversation
continues, because the worker remembers which opencode session id that name maps
to, per folder, in `~/.muse-mcp/sessions.json`. It survives a worker restart.

```
muse_run_agent { session: "auth-refactor", prompt: "split the login handler" }
muse_run_agent { session: "auth-refactor", prompt: "now add tests for it" }   <- remembers
```

Different names, or different folders, stay separate conversations.

`AUTO_APPROVE=1` passes `--auto` to opencode, because there is no terminal on the
other end to answer a permission prompt. Set it to `0` on a machine where you
would rather a task fail than have the agent act unattended.

## Talking to Muse from your own machine

Muse is the MCP *client*. It dials in, and nothing on the VPS can ring it. So you
cannot call Muse the way it calls you. What you get instead is an inbox: you drop
a message on the relay, and Muse collects it the next time it checks in.

```bash
npm run cli -- send "review the auth branch and tell me what you would change"
npm run cli -- thread      # your messages, and anything Muse answered
```

On the Muse side, tell it once, in its own system prompt or standing
instructions: *call `muse_inbox` at the start of every turn, and answer anything
you find with `muse_reply`.* Then the loop closes. Without that, the message just
waits.

If you want Muse to act the moment you send something, it has to be the one
polling, so give it a schedule on its side. There is no way around that while it
is the client.

## Operator CLI

The same tools, from a terminal, with no MCP client needed:

```bash
npm run cli                                  # usage
npm run cli -- workers                       # who is online
npm run cli -- run "summarise this repo" --cwd ~/projects/app --session review
npm run cli -- run "now list the risks" --session review    # continues it
npm run cli -- status <task_id>
npm run cli -- cancel <task_id>
npm run cli -- send "..."  /  thread         # the Muse inbox
```

Set `RELAY_MCP_URL` to the VPS URL to drive it remotely instead of locally.

## Install on the VPS

```bash
sudo adduser --system --group --home /opt/muse-mcp muse
sudo git clone <this repo> /opt/muse-mcp   # or rsync the folder up
cd /opt/muse-mcp && sudo -u muse npm install
sudo -u muse cp .env.example .env
sudo -u muse openssl rand -hex 32          # use for MCP_TOKEN
sudo -u muse openssl rand -hex 32          # use for WORKER_TOKEN
sudo -u muse nano .env                     # set both tokens, keep HOST=127.0.0.1
sudo cp deploy/muse-mcp.service /etc/systemd/system/
sudo systemctl enable --now muse-mcp
```

Then put nginx in front of it:

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/muse-mcp
sudo ln -s /etc/nginx/sites-available/muse-mcp /etc/nginx/sites-enabled/
sudo certbot --nginx -d muse.relay.example.com
sudo nginx -t && sudo systemctl reload nginx
curl https://muse.relay.example.com/health
```

`HOST=127.0.0.1` matters: the relay should only ever be reachable through nginx,
so the token always travels over TLS.

## Install the worker on your PC

```bash
cd ~/muse-terminal/relay
npm install
cp .env.example .env
```

Set in `.env`:

```
RELAY_URL=wss://muse.relay.example.com/agent
WORKER_TOKEN=<the same WORKER_TOKEN as the VPS>
WORKER_NAME=my-pc
ENGINE=opencode
WORKER_ROOTS=/home/you/projects
WORKER_DEFAULT_CWD=/home/you/projects
ALLOW_SHELL=1
```

Run it:

```bash
npm run worker
```

To keep it running across reboots:

```bash
mkdir -p ~/.config/systemd/user
sed "s|__ROOT__|$PWD|; s|__RELAY_HOST__|relay.example.com|" deploy/muse-worker.service > ~/.config/systemd/user/muse-worker.service
systemctl --user enable --now muse-worker
sudo loginctl enable-linger $USER   # so it survives logout
journalctl --user -u muse-worker -f
```

## Point Muse at the relay

Add it as a remote MCP server:

- URL: `https://muse.relay.example.com/mcp`
- Transport: streamable HTTP
- Header: `Authorization: Bearer <MCP_TOKEN>`

## Point your own tools at it

Claude Code:

```bash
claude mcp add --transport http muse \
  https://muse.relay.example.com/mcp \
  --header "Authorization: Bearer <MCP_TOKEN>"
```

opencode, in `opencode.json`:

```json
{
  "mcp": {
    "muse": {
      "type": "remote",
      "url": "https://muse.relay.example.com/mcp",
      "headers": { "Authorization": "Bearer <MCP_TOKEN>" },
      "enabled": true
    }
  }
}
```

## Choosing the engine on a worker

`ENGINE=opencode` runs `opencode run "<prompt>"` in the target folder.
`ENGINE=claude` runs `claude -p "<prompt>" --permission-mode acceptEdits`.
`ENGINE=custom` runs `CUSTOM_AGENT_CMD` with `{{PROMPT}}` replaced by the prompt.

Whatever you pick has to be installed and already logged in on that machine. The
worker inherits its own environment, so test the command by hand first:

```bash
cd /home/you/projects/content-hub && opencode run "list the files you can see"
```

## What keeps this safe

- Two separate tokens: one for MCP callers, one for worker machines. Rotate either alone.
- `WORKER_ROOTS` is enforced on the worker, not on the VPS. Every `cwd` and every
  file path is resolved and must sit inside a root, so a compromised relay still
  cannot reach outside those folders.
- `ALLOW_SHELL=0` turns off `muse_run_shell` for a machine and leaves the agent tool.
- Tasks are killed after `TASK_TIMEOUT` seconds.
- The relay keeps task logs in memory only, and drops them after `TASK_TTL_SECONDS`.

Remember what this is: an agent on someone else's machine gets to run a coding
agent that edits files on yours. Keep the roots narrow, keep the tokens secret,
and prefer `ALLOW_SHELL=0` on any machine holding something you care about.

## Testing locally, without a VPS

Two terminals:

```bash
# terminal 1 - relay, with HOST=127.0.0.1 PORT=8787
npm run server

# terminal 2 - worker, with RELAY_URL=ws://127.0.0.1:8787/agent
npm run worker
```

Then act as the remote agent:

```bash
curl -s http://127.0.0.1:8787/health | head

curl -s http://127.0.0.1:8787/mcp \
  -H "Authorization: Bearer $MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"muse_list_workers","arguments":{}}}'
```
