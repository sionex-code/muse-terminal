# muse-terminal

Use [Muse](https://muse.ai) from your terminal, and let Muse work on your own machines.

Two parts that work together or on their own:

| Part | Path | What it does |
| --- | --- | --- |
| **CLI** | `cli/`, `main.js`, `muse` | `muse` opens a chat UI in the terminal, `muse -p "..."` prints one reply for scripts. Runs on a Linux desktop. |
| **Relay** | `relay/` | A small MCP server on a VPS plus a worker on your PC. Muse (or Claude Code, opencode) calls the relay, the relay hands the task to your PC, and a coding agent runs in your folders. |

```
Muse  ──MCP over HTTPS──▶  relay (VPS)  ──websocket──▶  worker (your PC)  ──▶  opencode / claude
```

The CLI and the relay are independent. The CLI needs only a Muse login. The relay needs a VPS and a coding agent (opencode or Claude Code) on your PC.

## 1. Set up the CLI

Requirements: Linux with a desktop session, Node 20 or newer.

```bash
git clone <this repo> muse-terminal && cd muse-terminal
npm install
./muse              # first run: opens the Muse window, log in once, then close it
```

The login is kept in `~/.config/muse-linux`. After that, from any folder:

```bash
ln -s "$PWD/cli/muse.mjs" ~/.local/bin/muse && chmod +x cli/muse.mjs   # optional, puts `muse` on PATH
muse                     # chat UI in a new thread
muse -c                  # continue the last thread in this folder
muse -p "explain this repo"
muse threads
muse usage
```

How it works: `muse` starts the Electron app hidden, finds it over its local debug port (9333) and drives the same calls the web UI makes. Nothing is sent anywhere except to Muse itself. Set `MUSE_CDP_PORT` to use another port.

Set `MUSE_WORKER` to the name of your relay worker (default: your hostname). The CLI tells Muse that your current folder lives on that worker, so Muse uses the relay to read and edit it.

## 2. Set up the relay (optional)

Full guide in [relay/README.md](relay/README.md). Short version:

**On the VPS** (needs Node 20+, nginx, a domain with a TLS cert):

```bash
sudo adduser --system --group --home /opt/muse-mcp muse
sudo git clone <this repo> /tmp/mt && sudo cp -r /tmp/mt/relay/. /opt/muse-mcp/ && sudo chown -R muse: /opt/muse-mcp
cd /opt/muse-mcp && sudo -u muse npm install
sudo -u muse cp .env.example .env
openssl rand -hex 32     # run twice: MCP_TOKEN and WORKER_TOKEN
sudo -u muse nano .env   # set both tokens, keep HOST=127.0.0.1
sudo cp deploy/muse-mcp.service /etc/systemd/system/ && sudo systemctl enable --now muse-mcp
```

Edit `deploy/nginx.conf` (replace `relay.example.com` with your domain), install it, get a cert with certbot, reload nginx. `curl https://<domain>/health` should answer.

**On your PC:**

```bash
cd relay && npm install
cp .env.example .env     # set RELAY_URL=wss://<domain>/agent, WORKER_TOKEN (same as VPS),
                         # WORKER_NAME, WORKER_ROOTS (folders the agent may touch)
npm run up               # installs and starts the systemd user service, waits until the relay sees you
```

**Connect Muse** as a remote MCP server: URL `https://<domain>/mcp`, streamable HTTP, header `Authorization: Bearer <MCP_TOKEN>`. Claude Code and opencode snippets are in the relay README.

## Security

- Nothing secret is in this repo. Tokens live only in each machine's `.env` (git-ignored).
- The two tokens are separate. Rotate either alone, and the relay can hold SHA-256 digests instead of plaintext (`MCP_TOKEN_SHA256`).
- `WORKER_ROOTS` is enforced on your PC, so a compromised relay still cannot leave those folders.
- `ALLOW_SHELL=0` disables raw shell commands for a worker.
- Remember what the relay is: a remote agent gets to run a coding agent that edits files on your machine. Keep roots narrow.

Unofficial. Not affiliated with or endorsed by Meta.
