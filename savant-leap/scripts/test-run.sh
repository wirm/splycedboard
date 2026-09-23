#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Savant Lutron LEAP Bridge — Test Runner
# Runs the bridge directly in the terminal with verbose output.
# Does NOT install or touch launchd. Ctrl-C to stop.
#
# Usage (from any machine with Bun, or on the Pro Host):
#   bash scripts/test-run.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ── Checks ────────────────────────────────────────────────────────────────────
[ -x "$HOME/.bun/bin/bun" ] && export PATH="$HOME/.bun/bin:$PATH"
command -v bun >/dev/null 2>&1 || { echo "✗ Bun not found. Install it first:  curl -fsSL https://bun.sh/install | bash  then open a new terminal."; exit 1; }

if [ ! -d "$ROOT/node_modules" ]; then
  echo "── Installing dependencies ──"
  cd "$ROOT" && bun install
fi

# ── Banner ────────────────────────────────────────────────────────────────────
echo ""
echo "┌─────────────────────────────────────────────────────┐"
echo "│       Savant · Lutron LEAP Bridge  (test mode)      │"
echo "├─────────────────────────────────────────────────────┤"
echo "│  Web UI      →  http://localhost:47200              │"
echo "│  Savant port →  127.0.0.1:8023                      │"
echo "│  Ctrl-C to stop                                     │"
echo "└─────────────────────────────────────────────────────┘"
echo ""

# ── Run ───────────────────────────────────────────────────────────────────────
cd "$ROOT"
exec bun src/index.js
