#!/usr/bin/env bash
# Cross-build all three images for linux/amd64 on the laptop and stream them
# straight into `docker load` on the NAS over SSH. Avoids burning RAM/CPU on
# the Synology for the Next.js + Fava builds.
#
# Usage:
#   NAS_USER=admin NAS_HOST=172.30.40.192 deploy/scripts/ship.sh
#
# Prereqs on NAS: Container Manager installed (provides `docker compose` v2)
#                 and the SSH user has sudo without prompting (or run via
#                 `ssh -t` and type the password when asked).

set -euo pipefail

: "${NAS_USER:?set NAS_USER (Synology SSH username)}"
: "${NAS_HOST:?set NAS_HOST (Synology IP / hostname)}"

cd "$(dirname "$0")/.."

echo "==> Building images for linux/amd64 (cross-arch from laptop)…"
DOCKER_DEFAULT_PLATFORM=linux/amd64 docker compose build

IMAGES=(
  mars-universe-beancount-fava:latest
  mars-universe-beancount-web:latest
  mars-universe-beancount-gitsync:latest
)

echo "==> Streaming $(printf '%s\n' "${IMAGES[@]}" | wc -l | tr -d ' ') images to ${NAS_USER}@${NAS_HOST}…"
docker save "${IMAGES[@]}" \
  | gzip \
  | ssh "${NAS_USER}@${NAS_HOST}" 'gunzip | sudo docker load'

echo "==> Done. SSH to the NAS and run: cd /volume1/docker/mars-universe-beancount-app/deploy && sudo docker-compose up -d"
