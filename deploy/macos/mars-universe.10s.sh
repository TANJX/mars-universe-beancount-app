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

# System green / red / orange / grey, for SF Symbol tints.
GREEN="#34C759"
RED="#FF3B30"
ORANGE="#FF9500"
GREY="#8E8E93"

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

# Text stays the default label color for contrast; state rides on a colored SF Symbol.
# Every status row gets a click action: macOS disables action-less items, which greys
# the text and drops the symbol tint.
log_action() { printf 'bash=/usr/bin/open param1=-a param2=Console param3=%s/%s.log terminal=false' "$MU_LOG_DIR" "$1"; }
term_action() { printf 'bash=/usr/bin/open param1=-a param2=Terminal param3="%s" terminal=false' "$1"; }
state_icon() {  # up -> sfimage/sfcolor params
  [ "$1" = 1 ] && printf 'sfimage=circle.fill sfcolor=%s' "$GREEN" || printf 'sfimage=circle.fill sfcolor=%s' "$RED"
}

pid_desc() { [ -n "$1" ] && printf 'pid %s' "$1" || printf 'stopped'; }

echo "Fava  :$FAVA_PORT · $(pid_desc "$fava_pid") | $(state_icon $fava_up) $(log_action fava)"

if [ $releasing = 1 ]; then
  echo "Web  :$WEB_PORT · building… | sfimage=arrow.triangle.2.circlepath sfcolor=$ORANGE $(log_action release)"
else
  web_desc="$(pid_desc "$web_pid")"
  [ -n "$rel_sha" ] && web_desc="$web_desc · $rel_sha${rel_dirty:+-dirty} · built $rel_built"
  echo "Web  :$WEB_PORT · $web_desc | $(state_icon $web_up) $(log_action web)"
  if [ -n "$rel_sha" ] && [ "$rel_sha" != "$head_sha" ]; then
    echo "HEAD is $head_sha${head_dirty:+ (tree dirty)}: release to update | sfimage=arrow.up.circle.fill sfcolor=$ORANGE size=12 bash=$HERE/release-web.sh terminal=false refresh=true"
  elif [ -n "$head_dirty" ]; then
    echo "App tree has uncommitted changes | sfimage=pencil.circle sfcolor=$GREY size=12 $(term_action "$APP_DIR")"
  fi
fi

echo "---"
if [ "$bank_count" -gt 0 ]; then
  [ "$bank_count" = 1 ] && noun=change || noun=changes
  echo "Bank: $bank_count uncommitted $noun | sfimage=exclamationmark.triangle.fill sfcolor=$ORANGE"
  # `|` would end the SwiftBar title, so swap it out of any path.
  printf '%s\n' "$bank_status" | head -n 15 | tr '|' '/' | sed 's/^/--/; s/$/ | font=Menlo size=12/'
  [ "$bank_count" -gt 15 ] && echo "--… $((bank_count - 15)) more | size=12"
  echo "-----"
  echo "--Open in Terminal | $(term_action "$LEDGER_DIR")"
else
  echo "Bank: clean | sfimage=checkmark.circle.fill sfcolor=$GREEN $(term_action "$LEDGER_DIR")"
fi
echo "---"
# No href when the service is down: an item without an action renders disabled.
echo "Open web |$([ $web_up = 1 ] && printf ' href=http://localhost:%s' "$WEB_PORT")"
echo "Open Fava |$([ $fava_up = 1 ] && printf ' href=http://localhost:%s/%s/' "$FAVA_PORT" "$FAVA_LEDGER_SLUG")"
echo "---"
echo "Release web (build + restart) | bash=$HERE/release-web.sh terminal=false refresh=true"
echo "Restart web | bash=$HERE/ctl.sh param1=restart param2=web terminal=false refresh=true"
echo "Restart Fava (uv sync + restart) | bash=$HERE/restart-fava.sh terminal=false refresh=true"
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
