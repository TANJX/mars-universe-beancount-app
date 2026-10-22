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

# System green / red / orange, light and dark variants.
GREEN="#34C759,#30D158"
RED="#FF3B30,#FF453A"
ORANGE="#FF9500,#FF9F0A"
GREY="#8E8E93,#98989D"

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

# Menu bar glyph: one SF Symbol, monochrome like the system items around it.
if [ $releasing = 1 ]; then icon="arrow.triangle.2.circlepath"
elif [ $fava_up = 1 ] && [ $web_up = 1 ]; then icon="checkmark.circle"
elif [ $fava_up = 0 ] && [ $web_up = 0 ]; then icon="xmark.circle"
else icon="exclamationmark.triangle"
fi
echo "| sfimage=$icon"
echo "---"

dot() { [ "$1" = 1 ] && printf '●' || printf '○'; }
col() { [ "$1" = 1 ] && printf '%s' "$GREEN" || printf '%s' "$RED"; }

pid_desc() { [ -n "$1" ] && printf 'pid %s' "$1" || printf 'stopped'; }

echo "$(dot $fava_up) Fava  :$FAVA_PORT  $(pid_desc "$fava_pid") | color=$(col $fava_up) font=Menlo"

if [ $releasing = 1 ]; then
  echo "⟳ Web   :$WEB_PORT  building… | color=$ORANGE font=Menlo"
else
  web_desc="$(pid_desc "$web_pid")"
  [ -n "$rel_sha" ] && web_desc="$web_desc · $rel_sha${rel_dirty:+-dirty} · built $rel_built"
  echo "$(dot $web_up) Web   :$WEB_PORT  $web_desc | color=$(col $web_up) font=Menlo"
  if [ -n "$rel_sha" ] && [ "$rel_sha" != "$head_sha" ]; then
    echo "  ↑ HEAD is $head_sha${head_dirty:+ (tree dirty)}: release to update | color=$ORANGE font=Menlo"
  elif [ -n "$head_dirty" ]; then
    echo "  tree has uncommitted changes | color=$GREY font=Menlo"
  fi
fi

echo "---"
echo "Open web | href=http://localhost:$WEB_PORT"
echo "Open Fava | href=http://localhost:$FAVA_PORT/$FAVA_LEDGER_SLUG/"
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
