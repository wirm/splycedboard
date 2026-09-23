#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Savant Lutron LEAP Bridge — Updater
# Re-syncs source files and restarts the service. Config/certs are preserved.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

INSTALL_DIR="$HOME/savant-leap"
PLIST_NAME="com.savant.lutron-bridge"
PLIST_DEST="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"

info()    { echo "  ✓  $*"; }
section() { echo; echo "── $* ──"; }
die()     { echo "  ✗  ERROR: $*" >&2; exit 1; }

[ -d "$INSTALL_DIR" ] || die "Bridge not installed at $INSTALL_DIR. Run install.sh first."

[ -x "$HOME/.bun/bin/bun" ] && export PATH="$HOME/.bun/bin:$PATH"
command -v bun >/dev/null 2>&1 || die "Bun not found. Install it first:  curl -fsSL https://bun.sh/install | bash"

SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"

section "Stopping service"
launchctl unload "$PLIST_DEST" 2>/dev/null || true
info "Stopped"

section "Syncing files"
rsync -a --exclude='node_modules' --exclude='bun.lockb' --exclude='config' --exclude='logs' \
  "$SRC_DIR/" "$INSTALL_DIR/"
info "Files updated"

section "Updating dependencies"
cd "$INSTALL_DIR"
bun install --production
info "Dependencies up to date"

section "Restarting service"
launchctl load "$PLIST_DEST"
sleep 2

if launchctl list "$PLIST_NAME" &>/dev/null; then
  info "Service restarted"
else
  echo "  ⚠  Service may not have started — check logs:"
  echo "     tail -f $INSTALL_DIR/logs/bridge.log"
fi

echo
echo "  Update complete. Web UI: http://localhost:47200"
echo
