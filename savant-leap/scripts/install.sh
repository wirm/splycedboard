#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Savant Lutron LEAP Bridge — Installer
# Installs to ~/savant-leap on the Savant Pro Host Mac Mini
#
# Usage (run on the Pro Host):
#   bash install.sh
#
# What it does:
#   1. Copies bridge files to ~/savant-leap
#   2. Installs dependencies with Bun
#   3. Installs and loads the launchd agent (auto-start on login/reboot)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

INSTALL_DIR="$HOME/savant-leap"
PLIST_NAME="com.savant.lutron-bridge"
PLIST_DEST="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"
LOG_DIR="$INSTALL_DIR/logs"

# ── Helpers ───────────────────────────────────────────────────────────────────
info()    { echo "  ✓  $*"; }
section() { echo; echo "── $* ──"; }
die()     { echo "  ✗  ERROR: $*" >&2; exit 1; }

# ── Checks ────────────────────────────────────────────────────────────────────
section "Checking requirements"

[ -x "$HOME/.bun/bin/bun" ] && export PATH="$HOME/.bun/bin:$PATH"
command -v bun >/dev/null 2>&1 || die "Bun not found. Install it first:  curl -fsSL https://bun.sh/install | bash  then open a new terminal."
info "Bun $(bun --version)"

# Determine source directory (parent of scripts/)
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
info "Source: $SRC_DIR"

# ── Stop existing service ─────────────────────────────────────────────────────
section "Stopping existing service (if running)"

if launchctl list "$PLIST_NAME" &>/dev/null; then
  launchctl unload "$PLIST_DEST" 2>/dev/null || true
  info "Stopped existing service"
else
  info "Service not running"
fi

# ── Copy files ────────────────────────────────────────────────────────────────
section "Installing files to $INSTALL_DIR"

mkdir -p "$INSTALL_DIR"
mkdir -p "$LOG_DIR"
mkdir -p "$INSTALL_DIR/config/certs"

# Copy source files (preserve existing config/certs)
rsync -a --exclude='node_modules' --exclude='bun.lockb' --exclude='config' --exclude='logs' \
  "$SRC_DIR/" "$INSTALL_DIR/"

info "Files copied"

# ── bun install ───────────────────────────────────────────────────────────────
section "Installing dependencies"

cd "$INSTALL_DIR"
bun install --production
info "Dependencies installed"

# ── launchd plist ─────────────────────────────────────────────────────────────
section "Installing launchd service"

mkdir -p "$HOME/Library/LaunchAgents"

BUN_BIN="$(command -v bun)"

# Write plist with correct paths resolved at install time
cat > "$PLIST_DEST" << PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.savant.lutron-bridge</string>

    <key>ProgramArguments</key>
    <array>
        <string>$BUN_BIN</string>
        <string>$INSTALL_DIR/src/index.js</string>
    </array>

    <key>WorkingDirectory</key>
    <string>$INSTALL_DIR</string>

    <!-- Auto-start when the user logs in -->
    <key>RunAtLoad</key>
    <true/>

    <!-- Restart automatically if it crashes -->
    <key>KeepAlive</key>
    <dict>
        <key>Crashed</key>
        <true/>
    </dict>

    <!-- Wait 5s before restarting after a crash -->
    <key>ThrottleInterval</key>
    <integer>5</integer>

    <key>StandardOutPath</key>
    <string>$LOG_DIR/bridge.log</string>

    <key>StandardErrorPath</key>
    <string>$LOG_DIR/bridge-error.log</string>

    <!-- Environment -->
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$(dirname "$BUN_BIN"):/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>$HOME</string>
    </dict>
</dict>
</plist>
PLIST_EOF

info "Plist written to $PLIST_DEST"

# ── Load service ──────────────────────────────────────────────────────────────
launchctl load "$PLIST_DEST"
info "Service loaded"

# Give it a moment to start
sleep 2

if launchctl list "$PLIST_NAME" &>/dev/null; then
  info "Service is running"
else
  echo "  ⚠  Service may not have started — check logs:"
  echo "     tail -f $LOG_DIR/bridge.log"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
section "Done"
echo
echo "  Web UI:        http://localhost:47200"
echo "  Savant port:   8023 (set in Blueprint as host 127.0.0.1)"
echo "  Logs:          $LOG_DIR/bridge.log"
echo
echo "  Next: open http://localhost:47200 to pair with your Lutron processor"
echo "  Then copy profile/lutron_leap_bridge.xml to your Blueprint profiles folder"
echo
