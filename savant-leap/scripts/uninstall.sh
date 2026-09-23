#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Savant Lutron LEAP Bridge — Uninstaller
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

INSTALL_DIR="$HOME/savant-leap"
PLIST_NAME="com.savant.lutron-bridge"
PLIST_DEST="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"

info()    { echo "  ✓  $*"; }
section() { echo; echo "── $* ──"; }

section "Stopping service"

if launchctl list "$PLIST_NAME" &>/dev/null; then
  launchctl unload "$PLIST_DEST" 2>/dev/null || true
  info "Service stopped"
else
  info "Service was not running"
fi

section "Removing launchd plist"

if [ -f "$PLIST_DEST" ]; then
  rm "$PLIST_DEST"
  info "Removed $PLIST_DEST"
fi

section "Removing install directory"

read -rp "  Remove $INSTALL_DIR and all config/certs? [y/N] " confirm
if [[ "$confirm" =~ ^[Yy]$ ]]; then
  rm -rf "$INSTALL_DIR"
  info "Removed $INSTALL_DIR"
else
  info "Kept $INSTALL_DIR (config and certs preserved)"
fi

echo
echo "  Uninstall complete."
echo
