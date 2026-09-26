#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Shared by ./install and scripts/*. Source it — don't run it.
# ─────────────────────────────────────────────────────────────────────────────

APP_NAME="SplycedBoard"
LABEL="com.splycedboard.hub"
LEGACY_LABEL="com.savant.lutron-bridge"          # the standalone Lutron bridge this replaces
WEB_PORT="${SPLYCEDBOARD_WEB_PORT:-47200}"

INSTALL_DIR="${SPLYCEDBOARD_HOME:-$HOME/Library/Application Support/SplycedBoard}"
DATA_DIR="$INSTALL_DIR/data"
LOG_DIR="$INSTALL_DIR/logs"
DESKTOP_LINK="${SPLYCEDBOARD_DESKTOP_LINK:-$HOME/Desktop/SplycedBoard}"
LAUNCH_AGENTS="${SPLYCEDBOARD_LAUNCH_AGENTS:-$HOME/Library/LaunchAgents}"
PLIST="$LAUNCH_AGENTS/$LABEL.plist"
LEGACY_PLIST="$LAUNCH_AGENTS/$LEGACY_LABEL.plist"
GUI_DOMAIN="gui/$(id -u)"

# ── Terminal output ──────────────────────────────────────────────────────────

if [ -t 1 ]; then
  BOLD=$'\033[1m' DIM=$'\033[2m' GREEN=$'\033[32m' YELLOW=$'\033[33m' RED=$'\033[31m' RESET=$'\033[0m'
else
  BOLD='' DIM='' GREEN='' YELLOW='' RED='' RESET=''
fi

CURRENT_STEP=""
step() { CURRENT_STEP="$*"; printf '\n%s── %s ──%s\n' "$BOLD" "$*" "$RESET"; }
ok()   { printf '  %s✓%s  %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '  %s!%s  %s\n' "$YELLOW" "$RESET" "$*"; }
fail() { printf '  %s✗%s  %s\n' "$RED" "$RESET" "$*" >&2; }
die()  { fail "$*"; alert "$*"; REPORTED=1; exit 1; }

# ── Dialogs: native macOS windows when possible, terminal prompts otherwise ──
#
# SB_HEADLESS=1    ask in the terminal instead (automatic over SSH)
# SB_ASSUME_YES=1  never ask; take the default answer

USE_GUI=0
detect_gui() {  # always succeeds — callers run under set -e
  [ "${SB_HEADLESS:-0}" = 1 ] && return 0
  [ -n "${SSH_CONNECTION:-}${SSH_TTY:-}" ] && return 0
  command -v osascript >/dev/null 2>&1 || return 0
  launchctl managername 2>/dev/null | grep -q Aqua || return 0
  USE_GUI=1
}

# ask_yes MESSAGE [YES_BUTTON] — returns 0 for yes
ask_yes() {
  local msg="$1" yes="${2:-Continue}" reply
  [ "${SB_ASSUME_YES:-0}" = 1 ] && return 0
  if [ "$USE_GUI" = 1 ]; then
    osascript - "$msg" "$yes" "$APP_NAME" >/dev/null 2>&1 <<'OSA'
on run argv
  activate
  display dialog (item 1 of argv) with title (item 3 of argv) buttons {"Cancel", item 2 of argv} default button 2 cancel button 1 with icon note
end run
OSA
    return $?
  fi
  printf '\n%s\n' "$msg"
  read -r -p "  $yes? [Y/n] " reply </dev/tty || return 1
  [[ ! "$reply" =~ ^[Nn] ]]
}

# ask_button MESSAGE BUTTON... — prints the chosen button (the last one is the default)
ask_button() {
  local msg="$1"; shift
  if [ "${SB_ASSUME_YES:-0}" = 1 ]; then printf '%s\n' "${!#}"; return; fi
  if [ "$USE_GUI" = 1 ]; then
    osascript - "$msg" "$APP_NAME" "$@" 2>/dev/null <<'OSA'
on run argv
  set theButtons to items 3 thru -1 of argv
  activate
  set r to display dialog (item 1 of argv) with title (item 2 of argv) buttons theButtons default button (count of theButtons) with icon note
  return button returned of r
end run
OSA
    return
  fi
  # Menus go to stderr: stdout carries only the answer (callers capture it).
  printf '\n%s\n' "$msg" >&2
  local i=1 b reply
  for b in "$@"; do printf '  %d) %s\n' "$i" "$b" >&2; i=$((i + 1)); done
  read -r -p "  Choose [${#}]: " reply </dev/tty || reply=""
  [[ "$reply" =~ ^[0-9]+$ ]] && [ "$reply" -ge 1 ] && [ "$reply" -le $# ] || reply=$#
  printf '%s\n' "${!reply}"
}

# alert MESSAGE — an error the user must see
alert() {
  if [ "$USE_GUI" = 1 ]; then
    osascript - "$1" "$APP_NAME" >/dev/null 2>&1 <<'OSA' || true
on run argv
  activate
  display dialog (item 1 of argv) with title (item 2 of argv) buttons {"OK"} default button 1 with icon stop
end run
OSA
  fi
}

# ask_secret MESSAGE SKIP_BUTTON OK_BUTTON — prints what was typed (hidden); nothing if skipped
ask_secret() {
  local msg="$1" skip="$2" okb="$3" out reply
  if [ "$USE_GUI" = 1 ]; then
    out="$(osascript - "$msg" "$APP_NAME" "$skip" "$okb" 2>/dev/null <<'OSA'
on run argv
  activate
  set r to display dialog (item 1 of argv) with title (item 2 of argv) default answer "" with hidden answer buttons {item 3 of argv, item 4 of argv} default button 2 with icon note
  if button returned of r is (item 3 of argv) then return ""
  return "=" & (text returned of r)
end run
OSA
)" || out=""
    printf '%s' "${out#=}"
    return 0
  fi
  printf '\n%s\n' "$msg" >&2
  read -r -s -p "  Password (Enter alone: ${skip}): " reply </dev/tty || reply=""
  printf '\n' >&2
  printf '%s' "$reply"
}

# new_password MESSAGE [SKIP_BUTTON] — asks twice until the two match and it's long enough.
# Prints the password, or nothing when skipped. Never put it on a command line: pipe it.
new_password() {
  local msg="$1" skip="${2:-Skip}" pw again
  while :; do
    pw="$(ask_secret "$msg

At least 6 characters." "$skip" "Next")"
    [ -z "$pw" ] && return 0
    if [ "${#pw}" -lt 6 ]; then
      # stderr: this function's stdout is the password
      [ "$USE_GUI" = 1 ] && alert "That's shorter than 6 characters. Try again." || warn "That's shorter than 6 characters. Try again." >&2
      continue
    fi
    again="$(ask_secret "Type the same password again." "$skip" "Set Password")"
    [ -z "$again" ] && return 0
    if [ "$pw" = "$again" ]; then
      printf '%s' "$pw"
      return 0
    fi
    [ "$USE_GUI" = 1 ] && alert "The two passwords weren't the same. Try again." || warn "The two passwords weren't the same. Try again." >&2
  done
}

notify() {
  [ "$USE_GUI" = 1 ] || return 0
  osascript -e "display notification \"$1\" with title \"$APP_NAME\"" >/dev/null 2>&1 || true
}

# ── JavaScript runtime: Bun preferred (what existing hosts run), Node 18+ works too ──

RUNTIME="" RUNTIME_KIND=""
find_runtime() {
  local c
  for c in "$HOME/.bun/bin/bun" "$(command -v bun 2>/dev/null || true)"; do
    if [ -n "$c" ] && [ -x "$c" ]; then RUNTIME="$c"; RUNTIME_KIND=bun; return 0; fi
  done
  for c in "$(command -v node 2>/dev/null || true)" /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -n "$c" ] && [ -x "$c" ] && "$c" -e 'process.exit(parseInt(process.versions.node, 10) >= 18 ? 0 : 1)' 2>/dev/null; then
      RUNTIME="$c"; RUNTIME_KIND=node; return 0
    fi
  done
  return 1
}

# ── launchd ──────────────────────────────────────────────────────────────────

svc_loaded() { launchctl print "$GUI_DOMAIN/$1" >/dev/null 2>&1; }

svc_pid() { launchctl print "$GUI_DOMAIN/$LABEL" 2>/dev/null | awk '$1 == "pid" { print $3; exit }'; }

# svc_stop LABEL PLIST — unload and wait until launchd has let go of it
svc_stop() {
  local label="$1" plist="$2" _
  svc_loaded "$label" || return 0
  launchctl bootout "$GUI_DOMAIN/$label" 2>/dev/null || launchctl unload "$plist" 2>/dev/null || true
  for _ in $(seq 1 40); do
    svc_loaded "$label" || return 0
    sleep 0.25
  done
  return 1
}

svc_start() {
  launchctl enable "$GUI_DOMAIN/$LABEL" 2>/dev/null || true
  launchctl bootstrap "$GUI_DOMAIN" "$PLIST" 2>/dev/null || launchctl load -w "$PLIST"
}

# Ask the running service who it is; succeeds once the launchd-managed copy answers.
wait_healthy() {
  local _
  for _ in $(seq 1 "${1:-30}"); do
    if curl -fsS --max-time 2 "http://127.0.0.1:$WEB_PORT/api/hub" 2>/dev/null | grep -q '"managed":true'; then
      return 0
    fi
    sleep 1
  done
  return 1
}

xml_escape() {
  local s="$1"
  s="${s//&/&amp;}"; s="${s//</&lt;}"; s="${s//>/&gt;}"
  printf '%s' "$s"
}

lan_ip() {
  local ip iface
  for iface in en0 en1 en2 en3; do
    ip=$(ipconfig getifaddr "$iface" 2>/dev/null) && [ -n "$ip" ] && { printf '%s' "$ip"; return; }
  done
  printf 'localhost'
}
