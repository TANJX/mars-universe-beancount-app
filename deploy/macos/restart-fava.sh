#!/bin/bash
# Sync the Python env and restart the Fava agent. Covers both kinds of Fava
# change: a fork bump (edit the SHA in pyproject.toml, `uv lock`, then run this)
# and edits to the extension under packages/ (editable install, so the restart
# alone is what matters; the sync is a no-op when the lock hasn't changed).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$HERE/common.sh"
mu_load_env

mkdir -p "$MU_LOG_DIR"
exec > >(tee -a "$MU_LOG_DIR/release.log") 2>&1

cd "$APP_DIR"
mu_log "uv sync --frozen"
uv sync --frozen
mu_restart "$MU_FAVA_LABEL"
# Fava parses the whole ledger before it answers; give it a while.
if mu_wait_http "http://127.0.0.1:$FAVA_PORT/$FAVA_LEDGER_SLUG/" 90; then
  mu_log "fava up on :$FAVA_PORT"
else
  mu_log "fava did not answer on :$FAVA_PORT within 90s; see $MU_LOG_DIR/fava.log"
  exit 1
fi
