#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Savant Lutron LEAP Bridge — Live log tail
# ─────────────────────────────────────────────────────────────────────────────
LOG_DIR="$HOME/savant-leap/logs"

if [ "${1:-}" = "error" ]; then
  echo "── Error log ────────────────────────────────────────"
  tail -f "$LOG_DIR/bridge-error.log"
else
  echo "── Bridge log (Ctrl-C to stop) ──────────────────────"
  tail -f "$LOG_DIR/bridge.log"
fi
