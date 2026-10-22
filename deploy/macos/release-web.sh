#!/bin/bash
# Build the Next.js viewer and promote it to the running service:
#   next build -> copy the standalone bundle into a fresh release dir -> flip
#   `current` -> kickstart the launchd agent -> keep the last few releases.
# The service never runs from the repo's .next/, so dev work can't break it, and
# rolling back is `ln -sfn <older release> current` + `just svc restart web`.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
. "$HERE/common.sh"
mu_load_env

KEEP=3
mkdir -p "$MU_RELEASES_DIR" "$MU_LOG_DIR"
exec > >(tee -a "$MU_LOG_DIR/release.log") 2>&1

# One release at a time; the marker is also what the menu bar reads to show "building".
if ! mkdir "$MU_RELEASING_MARKER" 2>/dev/null; then
  mu_log "a release is already in progress ($MU_RELEASING_MARKER exists); aborting"
  exit 1
fi
trap 'rmdir "$MU_RELEASING_MARKER" 2>/dev/null || true' EXIT

cd "$APP_DIR"
# Root .env carries FAVA_LEDGER_SLUG; next.config.mjs bakes it and
# FAVA_INTERNAL_URL into the proxy rewrites at build time, not at startup.
if [ -f .env ]; then set -a; . ./.env; set +a; fi
export FAVA_INTERNAL_URL="http://127.0.0.1:$FAVA_PORT"

sha=$(git rev-parse --short HEAD)
dirty=""; [ -z "$(git status --porcelain --untracked-files=no)" ] || dirty="-dirty"
rel="$MU_RELEASES_DIR/$(date '+%Y%m%d-%H%M%S')-$sha$dirty"
mu_log "building web @ $sha$dirty -> $rel"

pnpm install --frozen-lockfile --prefer-offline
pnpm --filter web build

# Same layout deploy/web/Dockerfile ships: standalone bundle + static assets + public/.
mkdir -p "$rel/apps/web/.next"
cp -R apps/web/.next/standalone/. "$rel/"
cp -R apps/web/.next/static "$rel/apps/web/.next/static"
cp -R apps/web/public "$rel/apps/web/public"
cat > "$rel/RELEASE" <<EOF
sha=$sha
dirty=${dirty:+1}
built_at=$(date '+%Y-%m-%d %H:%M')
subject=$(git log -1 --pretty=%s | tr -d '\n')
EOF

ln -sfn "$rel" "$MU_CURRENT_LINK"
mu_restart "$MU_WEB_LABEL"
if mu_wait_http "http://127.0.0.1:$WEB_PORT/" 30; then
  mu_log "web up on :$WEB_PORT running $sha$dirty"
else
  mu_log "web did not answer on :$WEB_PORT within 30s; see $MU_LOG_DIR/web.log"
  exit 1
fi

# Prune everything but the newest $KEEP, never the release `current` points at.
current_real=$(readlink "$MU_CURRENT_LINK")
ls -1dt "$MU_RELEASES_DIR"/*/ | tail -n +$((KEEP + 1)) | while read -r old; do
  old=${old%/}
  [ "$old" = "$current_real" ] && continue
  mu_log "pruning $old"
  rm -rf "$old"
done
