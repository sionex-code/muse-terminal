#!/usr/bin/env bash
# Bring the muse-mcp worker up so the remote agent can reach this PC.
# One command: npm run up   (or: ./scripts/up.sh)
#
# What it does:
#   1. Sanity check the repo and .env (creates .env from .env.example if missing).
#   2. Install the systemd --user unit from deploy/muse-worker.service if missing.
#   3. Enable user lingering so the worker survives logout (idempotent).
#   4. Restart muse-worker and wait for it to register on the relay.
#   5. Poll the relay /health until this worker shows up, or fail with a hint.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

RELAY_URL="${RELAY_URL:-$(grep -E '^RELAY_URL=' .env 2>/dev/null | cut -d= -f2-)}"
WORKER_NAME="${WORKER_NAME:-$(grep -E '^WORKER_NAME=' .env 2>/dev/null | cut -d= -f2-)}"

c_red=$'\033[31m'; c_grn=$'\033[32m'; c_yel=$'\033[33m'; c_dim=$'\033[2m'; c_off=$'\033[0m'

ok()   { printf '%sok%s   %s\n' "$c_grn" "$c_off" "$*"; }
warn() { printf '%swarn%s %s\n' "$c_yel" "$c_off" "$*"; }
fail() { printf '%sfail%s %s\n' "$c_red" "$c_off" "$*"; exit 1; }

[ -f package.json ] || fail "run this from the muse-mcp repo"

if [ ! -f .env ]; then
  cp .env.example .env
  warn ".env was missing — copied .env.example. Fill in MCP_TOKEN and WORKER_TOKEN before the agent can talk to you."
fi

RELAY_URL="$(grep -E '^RELAY_URL=' .env | cut -d= -f2-)"
WORKER_NAME="$(grep -E '^WORKER_NAME=' .env | cut -d= -f2-)"
[ -n "$RELAY_URL" ]   || fail "RELAY_URL is empty in .env"
[ -n "$WORKER_NAME" ] || fail "WORKER_NAME is empty in .env"

HEALTH_URL="${RELAY_URL%/agent}/health"
case "$HEALTH_URL" in
  wss://*) HEALTH_URL="https://${HEALTH_URL#wss://}";;
  ws://*)  HEALTH_URL="http://${HEALTH_URL#ws://}";;
esac

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_FILE="$UNIT_DIR/muse-worker.service"
mkdir -p "$UNIT_DIR"

RELAY_HOST="${HEALTH_URL#*://}"; RELAY_HOST="${RELAY_HOST%%[:/]*}"
RENDERED="$(sed "s|__ROOT__|$ROOT|; s|__RELAY_HOST__|$RELAY_HOST|" deploy/muse-worker.service)"
if [ ! -f "$UNIT_FILE" ] || [ "$RENDERED" != "$(cat "$UNIT_FILE")" ]; then
  printf '%s\n' "$RENDERED" > "$UNIT_FILE"
  ok "installed systemd --user unit"
  RELOAD_NEEDED=1
fi

if loginctl show-user "$USER" -p Linger 2>/dev/null | grep -q '^Linger=yes'; then
  :
else
  if sudo -n loginctl enable-linger "$USER" 2>/dev/null; then
    ok "enabled user lingering"
  else
    warn "could not enable lingering without sudo — worker will stop when you log out"
  fi
fi

systemctl --user daemon-reload 2>/dev/null || true

if systemctl --user is-active --quiet muse-worker; then
  systemctl --user restart muse-worker
  ok "restarted muse-worker"
else
  systemctl --user enable --now muse-worker
  ok "started muse-worker"
fi

printf '%swait%s  asking the relay whether %s is online…\n' "$c_dim" "$c_off" "$WORKER_NAME"

DEADLINE=$((SECONDS + 30))
LAST=""
while [ $SECONDS -lt $DEADLINE ]; do
  BODY="$(curl -sS --max-time 5 "$HEALTH_URL" 2>/dev/null || true)"
  if [ -n "$BODY" ] && printf '%s' "$BODY" | grep -q "\"name\":\"$WORKER_NAME\""; then
    printf '\n'
    ok "agent can reach this PC — $WORKER_NAME is online"
    printf '%s%s%s\n' "$c_dim" "$BODY" "$c_off"
    exit 0
  fi
  LAST="$BODY"
  printf '.'
  sleep 1
done

printf '\n'
cat <<EOF
the relay still does not see $WORKER_NAME after 30s

last /health:
$LAST

debug:
  journalctl --user -u muse-worker -n 30 --no-pager
  systemctl --user status muse-worker --no-pager
  curl -s $HEALTH_URL
EOF
[ -t 1 ] || read -r _ </dev/tty 2>/dev/null || true
exit 1