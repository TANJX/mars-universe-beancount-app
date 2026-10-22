#!/bin/bash
# Install (or --uninstall) the launchd agents + SwiftBar plugin that run Fava and
# the web viewer as background services on this Mac. See deploy/macos/README.md.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$HERE/common.sh"
APP_DIR="$(cd "$HERE/../.." && pwd)"
PLUGIN_NAME="mars-universe.10s.sh"
SWIFTBAR_DEFAULT_PLUGIN_DIR="$HOME/Library/Application Support/SwiftBar/Plugins"

swiftbar_plugin_dir() {
  defaults read com.ameba.SwiftBar PluginDirectory 2>/dev/null || true
}

uninstall() {
  mu_bootout "$MU_WEB_LABEL"; mu_bootout "$MU_FAVA_LABEL"
  rm -f "$MU_AGENTS_DIR/$MU_WEB_LABEL.plist" "$MU_AGENTS_DIR/$MU_FAVA_LABEL.plist"
  local pdir; pdir=$(swiftbar_plugin_dir)
  [ -n "$pdir" ] && rm -f "$pdir/$PLUGIN_NAME"
  mu_log "agents unloaded, plists and plugin link removed."
  mu_log "kept $MU_STATE_DIR and $MU_LOG_DIR; delete them by hand to purge releases and logs."
}

if [ "${1:-}" = "--uninstall" ]; then uninstall; exit 0; fi

# Root .env supplies LEDGER_DIR + FAVA_LEDGER_SLUG. just's dotenv-load does the
# same, but this script must also work when invoked directly.
if [ -f "$APP_DIR/.env" ]; then set -a; . "$APP_DIR/.env"; set +a; fi
: "${LEDGER_DIR:?set LEDGER_DIR in $APP_DIR/.env}"
LEDGER_DIR="$(cd "$LEDGER_DIR" && pwd)"
FAVA_PORT="${FAVA_PORT:-5000}"
WEB_PORT="${WEB_PORT:-8888}"
FAVA_LEDGER_SLUG="${FAVA_LEDGER_SLUG:-ledger}"
NODE="$(command -v node)"
[ -x "$APP_DIR/.venv/bin/fava" ] || { echo "no $APP_DIR/.venv/bin/fava; run 'just install' first" >&2; exit 1; }

mkdir -p "$MU_RELEASES_DIR" "$MU_LOG_DIR" "$MU_AGENTS_DIR"
cat > "$MU_ENV_FILE" <<EOF
# Rendered by deploy/macos/install.sh on $(date '+%Y-%m-%d %H:%M'). Re-run 'just install-agents' to change.
APP_DIR=$APP_DIR
LEDGER_DIR=$LEDGER_DIR
FAVA_PORT=$FAVA_PORT
WEB_PORT=$WEB_PORT
FAVA_LEDGER_SLUG=$FAVA_LEDGER_SLUG
NODE=$NODE
EOF
mu_log "wrote $MU_ENV_FILE"

render() {  # template -> stdout, {{KEY}} substituted
  sed -e "s|{{APP_DIR}}|$APP_DIR|g" \
      -e "s|{{LEDGER_DIR}}|$LEDGER_DIR|g" \
      -e "s|{{STATE_DIR}}|$MU_STATE_DIR|g" \
      -e "s|{{LOG_DIR}}|$MU_LOG_DIR|g" \
      -e "s|{{FAVA_PORT}}|$FAVA_PORT|g" \
      -e "s|{{WEB_PORT}}|$WEB_PORT|g" \
      -e "s|{{NODE}}|$NODE|g" \
      -e "s|{{HOME}}|$HOME|g" \
      "$1"
}
render "$HERE/plist/$MU_FAVA_LABEL.plist.tmpl" > "$MU_AGENTS_DIR/$MU_FAVA_LABEL.plist"
render "$HERE/plist/$MU_WEB_LABEL.plist.tmpl" > "$MU_AGENTS_DIR/$MU_WEB_LABEL.plist"
plutil -lint "$MU_AGENTS_DIR/$MU_FAVA_LABEL.plist" "$MU_AGENTS_DIR/$MU_WEB_LABEL.plist" >/dev/null
mu_log "rendered plists into $MU_AGENTS_DIR"

# Fava: (re)load now. Web: launchd needs a release to point at before it may start.
mu_bootout "$MU_FAVA_LABEL"; mu_bootstrap "$MU_FAVA_LABEL"
if [ -e "$MU_CURRENT_LINK" ]; then
  mu_bootout "$MU_WEB_LABEL"; mu_bootstrap "$MU_WEB_LABEL"
else
  mu_log "no web release yet; building one (takes about a minute)"
  "$HERE/release-web.sh"
fi

# SwiftBar plugin: symlink into whatever folder SwiftBar is pointed at. If
# SwiftBar has never been launched, preset its plugin folder so first launch
# doesn't prompt for one.
pdir=$(swiftbar_plugin_dir)
if [ -z "$pdir" ]; then
  pdir="$SWIFTBAR_DEFAULT_PLUGIN_DIR"
  mkdir -p "$pdir"
  defaults write com.ameba.SwiftBar PluginDirectory -string "$pdir"
fi
mkdir -p "$pdir"
ln -sfn "$HERE/$PLUGIN_NAME" "$pdir/$PLUGIN_NAME"
mu_log "linked SwiftBar plugin into $pdir"
if [ -d /Applications/SwiftBar.app ]; then
  open -g -a SwiftBar
else
  mu_log "SwiftBar not installed: brew install --cask swiftbar, then open it once"
fi

"$HERE/ctl.sh" status
