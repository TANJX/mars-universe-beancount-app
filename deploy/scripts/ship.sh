#!/usr/bin/env bash
# Cross-build all three images for linux/amd64 on the laptop and export them
# to a local gzip tarball for manual upload to the NAS. Avoids burning RAM/CPU
# on the Synology for the Next.js + Fava builds.
#
# Usage:
#   deploy/scripts/ship.sh [output_path]
#
# Default output: deploy/dist/mars-universe-beancount-images.tar.gz
#
# After upload, log in to the NAS with ssh and run these one at a time
# (not as a single `ssh -t` command: the sudo prompt fails inside the pipe):
#   cd /volume1/docker
#   sudo -v
#   gunzip < mars-universe-beancount-images.tar.gz | sudo docker load
#   cd mars-universe-beancount-app/deploy
#   sudo docker-compose up -d

set -euo pipefail

cd "$(dirname "$0")/.."

OUTPUT="${1:-dist/mars-universe-beancount-images.tar.gz}"
mkdir -p "$(dirname "$OUTPUT")"

echo "==> Building images for linux/amd64 (cross-arch from laptop)…"
DOCKER_DEFAULT_PLATFORM=linux/amd64 docker compose build

IMAGES=(
  mars-universe-beancount-fava:latest
  mars-universe-beancount-web:latest
  mars-universe-beancount-gitsync:latest
)

echo "==> Exporting $(printf '%s\n' "${IMAGES[@]}" | wc -l | tr -d ' ') images to ${OUTPUT}…"
docker save "${IMAGES[@]}" | gzip > "$OUTPUT"

SIZE=$(du -h "$OUTPUT" | cut -f1)
echo "==> Done. Wrote ${OUTPUT} (${SIZE})."
echo "    Upload:  scp -O deploy/${OUTPUT} <nas-user>@<nas-host>:/volume1/docker/"
echo "    Then ssh in to the NAS and run, one at a time:"
echo "      cd /volume1/docker"
echo "      sudo -v"
echo "      gunzip < $(basename "$OUTPUT") | sudo docker load"
echo "      cd mars-universe-beancount-app/deploy"
echo "      sudo docker-compose up -d"
