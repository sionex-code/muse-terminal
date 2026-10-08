#!/usr/bin/env bash
# One-click install of the Muse relay on Linux (no VPS, permanent Cloudflare URL).
#   ./install.sh                      from a clone
#   curl -fsSL https://raw.githubusercontent.com/sionex-code/muse-terminal/master/install.sh | bash
# Extra flags go to setup, e.g.  ./install.sh --hostname muse.example.com   or   --quick
set -euo pipefail

command -v node >/dev/null || { echo "Node 20+ is required. Install it from https://nodejs.org (or your package manager) and run this again."; exit 1; }
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || { echo "Node 20+ is required, found $(node -v)."; exit 1; }

DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [ ! -f "$DIR/relay/package.json" ]; then
  DIR="$HOME/muse-terminal"
  if [ ! -d "$DIR" ]; then
    echo "Downloading muse-terminal to $DIR"
    mkdir -p "$DIR"
    curl -fsSL https://github.com/sionex-code/muse-terminal/archive/refs/heads/master.tar.gz | tar -xz --strip-components=1 -C "$DIR"
  fi
fi

cd "$DIR/relay"
npm install --omit=dev --no-audit --no-fund
node scripts/tunnel.mjs setup "$@"
