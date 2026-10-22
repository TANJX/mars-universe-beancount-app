#!/bin/bash
# ctl.sh start|stop|restart|status [fava|web|all]
# Thin wrapper over launchctl for the two agents, used by `just svc` and the menu bar.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$HERE/common.sh"
mu_load_env 2>/dev/null || true

cmd=${1:-status}
target=${2:-all}

labels() {
  case $target in
    fava) echo "$MU_FAVA_LABEL" ;;
    web) echo "$MU_WEB_LABEL" ;;
    all) echo "$MU_FAVA_LABEL $MU_WEB_LABEL" ;;
    *) echo "unknown target '$target' (fava|web|all)" >&2; exit 2 ;;
  esac
}

case $cmd in
  start)   for l in $(labels); do mu_loaded "$l" || mu_bootstrap "$l"; done ;;
  stop)    for l in $(labels); do mu_bootout "$l"; done ;;
  restart) for l in $(labels); do mu_restart "$l"; done ;;
  status)
    for l in $MU_FAVA_LABEL $MU_WEB_LABEL; do
      pid=$(mu_pid "$l")
      if [ -n "$pid" ]; then
        printf '%-24s running   pid %s\n' "$l" "$pid"
      elif mu_loaded "$l"; then
        printf '%-24s loaded, not running\n' "$l"
      else
        printf '%-24s not loaded\n' "$l"
      fi
    done
    if [ -L "$MU_CURRENT_LINK" ]; then
      printf '%-24s %s\n' "web release" "$(basename "$(readlink "$MU_CURRENT_LINK")")"
    fi
    ;;
  *) echo "usage: ctl.sh start|stop|restart|status [fava|web|all]" >&2; exit 2 ;;
esac
