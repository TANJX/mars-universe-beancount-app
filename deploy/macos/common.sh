#!/bin/bash
# Shared by deploy/macos/*.sh and the SwiftBar plugin. Sourced, not executed.
# launchd and SwiftBar start scripts with a bare PATH, so set one up front.

export PATH="/opt/homebrew/bin:$HOME/Library/pnpm:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

MU_STATE_DIR="$HOME/Library/Application Support/mars-universe"
MU_LOG_DIR="$HOME/Library/Logs/mars-universe"
MU_ENV_FILE="$MU_STATE_DIR/env"
MU_AGENTS_DIR="$HOME/Library/LaunchAgents"
MU_DOMAIN="gui/$(id -u)"
MU_FAVA_LABEL="com.mars-universe.fava"
MU_WEB_LABEL="com.mars-universe.web"
MU_RELEASES_DIR="$MU_STATE_DIR/web/releases"
MU_CURRENT_LINK="$MU_STATE_DIR/web/current"
MU_RELEASING_MARKER="$MU_STATE_DIR/web/releasing"

# Rendered by install.sh: APP_DIR, LEDGER_DIR, FAVA_PORT, WEB_PORT, FAVA_LEDGER_SLUG, NODE.
mu_load_env() {
  if [ ! -f "$MU_ENV_FILE" ]; then
    echo "mars-universe: $MU_ENV_FILE missing; run 'just install-agents' first" >&2
    return 1
  fi
  # shellcheck disable=SC1090
  set -a; . "$MU_ENV_FILE"; set +a
}

mu_log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

# launchd helpers. `launchctl print` is the only reliable way to ask "is it
# loaded, what pid" on modern macOS; the legacy `launchctl list` lies about state.
mu_pid() {  # label -> pid, or empty when not running
  launchctl print "$MU_DOMAIN/$1" 2>/dev/null | awk '/^[[:space:]]*pid = /{print $3; exit}'
}
mu_loaded() { launchctl print "$MU_DOMAIN/$1" >/dev/null 2>&1; }

mu_bootstrap() {  # label
  launchctl enable "$MU_DOMAIN/$1" 2>/dev/null || true
  launchctl bootstrap "$MU_DOMAIN" "$MU_AGENTS_DIR/$1.plist"
}
mu_bootout() { launchctl bootout "$MU_DOMAIN/$1" 2>/dev/null || true; }
mu_restart() {  # label: kill + relaunch when loaded, plain load otherwise
  if mu_loaded "$1"; then launchctl kickstart -k "$MU_DOMAIN/$1"; else mu_bootstrap "$1"; fi
}

mu_http_code() { curl -s -m 2 -o /dev/null -w '%{http_code}' "$1" 2>/dev/null || echo 000; }

mu_wait_http() {  # url seconds -> 0 once a 2xx/3xx arrives in time
  local url=$1 secs=${2:-30} code i
  for ((i = 0; i < secs; i++)); do
    code=$(mu_http_code "$url")
    case $code in 2*|3*) return 0 ;; esac
    sleep 1
  done
  return 1
}
