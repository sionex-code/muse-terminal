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

The relay lets Muse work on your PC. You have two ways to host it.

### A. On your own PC with Cloudflare, no VPS (recommended)

One command, Windows or Linux. It installs everything, creates a **permanent** HTTPS address through a Cloudflare tunnel, starts at login and prints what to paste into Muse.

| | Windows | Linux |
| --- | --- | --- |
| One click | double-click `install.cmd` | `./install.sh` |
| From the web | `irm https://raw.githubusercontent.com/sionex-code/muse-terminal/master/install.ps1 \| iex` | `curl -fsSL https://raw.githubusercontent.com/sionex-code/muse-terminal/master/install.sh \| bash` |

What you need: Node 20+ (the Windows installer gets it with winget if missing), and a free Cloudflare account with one domain on it. The installer then:

1. Downloads `cloudflared` for you.
2. Opens a browser once so you log in to Cloudflare and pick the domain.
3. Asks for the address you want, for example `muse.yourdomain.com`, creates the tunnel and points that address at it.
4. Generates both tokens, writes `relay/.env`, and installs autostart (systemd on Linux, Task Scheduler on Windows).
5. Prints the **MCP URL** and the **Bearer token**. Add them in Muse as a remote MCP server (streamable HTTP, header `Authorization: Bearer <token>`).

No domain? Press Enter at the hostname question, or pass `--quick`, and you get a temporary `trycloudflare.com` address with no account. It changes every restart.

For scripts and agents, nothing has to be asked:

```bash
./install.sh --hostname muse.yourdomain.com --roots "$HOME/projects"
./install.sh --quick --no-service
```

Flags: `--hostname`, `--quick`, `--roots`, `--shell` (allow raw shell commands, off by default), `--no-service`.

Day to day (run in `relay/`):

```bash
npm run tunnel -- status      # URL, token, who is online
npm run tunnel -- run         # run in the foreground instead of as a service
npm run tunnel -- unservice   # remove autostart
```

The tunnel and the relay both run only on your PC, so the address works while your PC is on and online.

### B. On a VPS

Full guide in [relay/README.md](relay/README.md). Use this if you want the relay up when your PC is off or want it separate from your machine.

```bash
sudo adduser --system --group --home /opt/muse-mcp muse
sudo git clone <this repo> /tmp/mt && sudo cp -r /tmp/mt/relay/. /opt/muse-mcp/ && sudo chown -R muse: /opt/muse-mcp
cd /opt/muse-mcp && sudo -u muse npm install
sudo -u muse cp .env.example .env
openssl rand -hex 32     # run twice: MCP_TOKEN and WORKER_TOKEN
sudo -u muse nano .env   # set both tokens, keep HOST=127.0.0.1
sudo cp deploy/muse-mcp.service /etc/systemd/system/ && sudo systemctl enable --now muse-mcp
```

Edit `deploy/nginx.conf` (replace `relay.example.com`), install it, get a cert with certbot, reload nginx. Then on your PC: `cd relay && npm install && cp .env.example .env`, set `RELAY_URL=wss://<domain>/agent`, the same `WORKER_TOKEN`, `WORKER_ROOTS`, and run `npm run up`.

## Security

- Nothing secret is in this repo. Tokens live only in each machine's `.env` (git-ignored).
- The two tokens are separate. Rotate either alone, and the relay can hold SHA-256 digests instead of plaintext (`MCP_TOKEN_SHA256`).
- `WORKER_ROOTS` is enforced on your PC, so a compromised relay still cannot leave those folders.
- `ALLOW_SHELL=0` disables raw shell commands for a worker.
- Remember what the relay is: a remote agent gets to run a coding agent that edits files on your machine. Keep roots narrow.

Unofficial. Not affiliated with or endorsed by Meta.
