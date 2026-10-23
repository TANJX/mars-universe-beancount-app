#!/bin/bash
# <swiftbar.title>Mars Universe</swiftbar.title>
# <swiftbar.version>1.0</swiftbar.version>
# <swiftbar.hideAbout>true</swiftbar.hideAbout>
# <swiftbar.hideRunInTerminal>true</swiftbar.hideRunInTerminal>
# <swiftbar.hideLastUpdated>true</swiftbar.hideLastUpdated>
# <swiftbar.hideDisablePlugin>true</swiftbar.hideDisablePlugin>
# <swiftbar.hideSwiftBar>true</swiftbar.hideSwiftBar>
# <swiftbar.refreshOnOpen>true</swiftbar.refreshOnOpen>
#
# Menu bar status for the Fava + web launchd agents. install.sh symlinks this
# file into the SwiftBar plugin folder; it reads its config from the env file
# install.sh wrote, so nothing machine-specific lives in the repo.

SELF="$(readlink -f "${BASH_SOURCE[0]}")"
HERE="$(dirname "$SELF")"
# shellcheck source=common.sh
. "$HERE/common.sh"

if ! mu_load_env 2>/dev/null; then
  echo "| sfimage=exclamationmark.triangle"
  echo "---"
  echo "Not installed: run 'just install-agents' in the app repo"
  exit 0
fi

fava_pid=$(mu_pid "$MU_FAVA_LABEL")
web_pid=$(mu_pid "$MU_WEB_LABEL")
# AirPlay Receiver squats on *:5000 and answers 403, so "any response" isn't "Fava is up".
fava_code=$(mu_http_code "http://127.0.0.1:$FAVA_PORT/$FAVA_LEDGER_SLUG/")
web_code=$(mu_http_code "http://127.0.0.1:$WEB_PORT/")
fava_up=0; case $fava_code in 2*|3*) fava_up=1 ;; esac
web_up=0;  case $web_code  in 2*|3*) web_up=1 ;;  esac
releasing=0; [ -d "$MU_RELEASING_MARKER" ] && releasing=1

rel_sha=""; rel_dirty=""; rel_built=""
if [ -f "$MU_CURRENT_LINK/RELEASE" ]; then
  rel_sha=$(sed -n 's/^sha=//p' "$MU_CURRENT_LINK/RELEASE")
  rel_dirty=$(sed -n 's/^dirty=//p' "$MU_CURRENT_LINK/RELEASE")
  rel_built=$(sed -n 's/^built_at=//p' "$MU_CURRENT_LINK/RELEASE")
fi
head_sha=$(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo "?")
head_dirty=""
[ -n "$(git -C "$APP_DIR" status --porcelain --untracked-files=no 2>/dev/null)" ] && head_dirty=1

# Uncommitted ledger work (untracked included: a new statement CSV or .bean counts).
bank_status=$(git -C "$LEDGER_DIR" status --porcelain 2>/dev/null)
bank_count=$(printf '%s' "$bank_status" | grep -c .)

# Menu bar glyph: the planet as a template image (macOS tints it like the system
# items around it), badged for partial/releasing and faded when everything is down.
if [ $releasing = 1 ]; then icon=busy
elif [ $fava_up = 1 ] && [ $web_up = 1 ]; then icon=ok
elif [ $fava_up = 0 ] && [ $web_up = 0 ]; then icon=down
else icon=warn
fi
glyph="templateImage=$(base64 -i "$HERE/icons/planet-$icon.png")"
# A count next to the glyph is the warning that the ledger has unsaved work.
if [ "$bank_count" -gt 0 ]; then echo "$bank_count | $glyph"; else echo "| $glyph"; fi
echo "---"

# Every status row gets a click action: macOS disables action-less items, which greys
# the text and drops the symbol tint.
log_action() { printf 'bash=/usr/bin/open param1=-a param2=Console param3=%s/%s.log terminal=false' "$MU_LOG_DIR" "$1"; }
term_action() { printf 'bash=/usr/bin/open param1=-a param2=Terminal param3="%s" terminal=false' "$1"; }
# macOS 26 darkens SF Symbol images in menus to near-black whatever the tint,
# so state is shown with emoji, which render as text in full color.
state_dot() { [ "$1" = 1 ] && printf '🟢' || printf '🔴'; }

# "2026-10-23 17:53" -> "17:53" today, "Nd ago" otherwise.
short_built() {
  local day=${1%% *} then now
  [ "$day" = "$(date +%Y-%m-%d)" ] && { printf '%s' "${1##* }"; return; }
  then=$(date -j -f %Y-%m-%d "$day" +%s 2>/dev/null) || { printf '%s' "$1"; return; }
  now=$(date -j -f %Y-%m-%d "$(date +%Y-%m-%d)" +%s)
  printf '%sd ago' $(( (now - then) / 86400 ))
}

pid_desc() { [ -n "$1" ] && printf 'pid %s' "$1" || printf 'stopped'; }

# Top level stays narrow; holding Option swaps in the pid and full build time.
echo "$(state_dot $fava_up) Fava  :$FAVA_PORT | $(log_action fava)"
echo "$(state_dot $fava_up) Fava  :$FAVA_PORT · $(pid_desc "$fava_pid") | alternate=true $(log_action fava)"

if [ $releasing = 1 ]; then
  echo "🟠 Web  :$WEB_PORT · building… | $(log_action release)"
else
  web_short=""; web_long="$(pid_desc "$web_pid")"
  if [ -n "$rel_sha" ]; then
    web_short=" · $rel_sha${rel_dirty:+-dirty} · $(short_built "$rel_built")"
    web_long="$web_long · $rel_sha${rel_dirty:+-dirty} · built $rel_built"
  fi
  echo "$(state_dot $web_up) Web  :$WEB_PORT$web_short | $(log_action web)"
  echo "$(state_dot $web_up) Web  :$WEB_PORT · $web_long | alternate=true $(log_action web)"
  if [ -n "$rel_sha" ] && [ "$rel_sha" != "$head_sha" ]; then
    echo "HEAD is $head_sha${head_dirty:+ (tree dirty)}: release to update | size=12 bash=$HERE/release-web.sh terminal=false refresh=true"
  elif [ -n "$head_dirty" ]; then
    echo "App tree has uncommitted changes | size=12 $(term_action "$APP_DIR")"
  fi
fi

echo "---"
if [ "$bank_count" -gt 0 ]; then
  echo "⚠️ Bank: $bank_count uncommitted | $(term_action "$LEDGER_DIR")"
  # `|` would end the SwiftBar title, so swap it out of any path. Rows need an
  # action too, or macOS greys them out.
  bank_action=$(term_action "$LEDGER_DIR")
  printf '%s\n' "$bank_status" | head -n 15 | tr '|' '/' | while IFS= read -r line; do
    echo "--$line | font=Menlo size=12 $bank_action"
  done
  [ "$bank_count" -gt 15 ] && echo "--… $((bank_count - 15)) more | size=12"
  echo "-----"
  echo "--Open in Terminal | $(term_action "$LEDGER_DIR")"
else
  echo "✅ Bank: clean | $(term_action "$LEDGER_DIR")"
fi
echo "---"
# No href when the service is down: an item without an action renders disabled.
echo "Open web |$([ $web_up = 1 ] && printf ' href=http://localhost:%s' "$WEB_PORT")"
echo "Open Fava |$([ $fava_up = 1 ] && printf ' href=http://localhost:%s/%s/' "$FAVA_PORT" "$FAVA_LEDGER_SLUG")"
echo "---"
echo "Release web | tooltip=\"Build and restart\" bash=$HERE/release-web.sh terminal=false refresh=true"
echo "Restart web | bash=$HERE/ctl.sh param1=restart param2=web terminal=false refresh=true"
echo "Restart Fava | tooltip=\"uv sync and restart\" bash=$HERE/restart-fava.sh terminal=false refresh=true"
echo "---"
if [ -n "$fava_pid" ] || [ -n "$web_pid" ]; then
  echo "Stop all | bash=$HERE/ctl.sh param1=stop param2=all terminal=false refresh=true"
else
  echo "Start all | bash=$HERE/ctl.sh param1=start param2=all terminal=false refresh=true"
fi
echo "Logs"
echo "--Fava log | bash=/usr/bin/open param1=-a param2=Console param3=$MU_LOG_DIR/fava.log terminal=false"
echo "--Web log | bash=/usr/bin/open param1=-a param2=Console param3=$MU_LOG_DIR/web.log terminal=false"
echo "--Release log | bash=/usr/bin/open param1=-a param2=Console param3=$MU_LOG_DIR/release.log terminal=false"
echo "--Log folder | bash=/usr/bin/open param1=$MU_LOG_DIR terminal=false"
echo "--Releases folder | bash=/usr/bin/open param1=\"$MU_RELEASES_DIR\" terminal=false"
