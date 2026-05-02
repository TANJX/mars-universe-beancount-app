#!/bin/sh
# Clone (if absent) and periodically sync a git repo into /repo.
# `fava` reads /repo/$LEDGER_FILE_REL via a read-only bind; `auto-reload` picks
# up the file mtime change on each `git reset --hard`.
set -eu

: "${GIT_REPO_URL:?GIT_REPO_URL is required}"
: "${GIT_BRANCH:=main}"
: "${GIT_PULL_INTERVAL:=300}"

# Build authenticated remote URL if a PAT is provided. Done in a variable
# rather than written to disk so the token doesn't end up in `git config`.
remote="$GIT_REPO_URL"
if [ -n "${GIT_PAT:-}" ]; then
  case "$GIT_REPO_URL" in
    https://*)
      remote=$(printf '%s' "$GIT_REPO_URL" | sed "s#https://#https://x-access-token:${GIT_PAT}@#")
      ;;
    *)
      echo "[gitsync] GIT_PAT set but GIT_REPO_URL is not https; ignoring PAT"
      ;;
  esac
fi

if [ ! -d /repo/.git ]; then
  echo "[gitsync] cloning $GIT_REPO_URL (branch: $GIT_BRANCH)"
  git clone --branch "$GIT_BRANCH" --single-branch --depth 50 "$remote" /repo
else
  echo "[gitsync] using existing checkout at /repo"
fi

# Always reset the remote URL so a rotated PAT takes effect on container restart.
git -C /repo remote set-url origin "$remote"
# Avoid "dubious ownership" errors on bind-mounted volumes.
git config --global --add safe.directory /repo

while true; do
  if git -C /repo fetch --quiet --depth 50 origin "$GIT_BRANCH"; then
    if ! git -C /repo diff --quiet "HEAD" "origin/$GIT_BRANCH"; then
      echo "[gitsync] new commits on $GIT_BRANCH; resetting"
      git -C /repo reset --hard "origin/$GIT_BRANCH"
    fi
  else
    echo "[gitsync] fetch failed; will retry in ${GIT_PULL_INTERVAL}s"
  fi
  sleep "$GIT_PULL_INTERVAL"
done
