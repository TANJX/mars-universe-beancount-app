# macOS background services

Runs Fava and the web viewer as launchd user agents on the laptop, with a SwiftBar
menu bar item for status and one-click actions. Replaces keeping `just fava` and
`just web` open in two terminals.

| Agent                    | Runs                                                         | Port (localhost only) |
| ------------------------ | ------------------------------------------------------------ | --------------------- |
| `com.mars-universe.fava` | `.venv/bin/fava $LEDGER_DIR/journal/journal.beancount`       | 5000                  |
| `com.mars-universe.web`  | `node ~/Library/Application Support/mars-universe/web/current/apps/web/server.js` | 8888 |

Both start at login and restart on crash (`KeepAlive`). Logs go to
`~/Library/Logs/mars-universe/{fava,web,release}.log`.

## Install

```sh
brew install --cask swiftbar      # once
just install-agents               # renders plists from .env, loads both agents,
                                  # builds the first web release, links the plugin
```

Then tick "Launch at Login" in SwiftBar's preferences. Ports default to 5000/8888;
override with `FAVA_PORT=… WEB_PORT=… just install-agents`.

Nothing machine-specific is committed: `install.sh` reads `LEDGER_DIR` and
`FAVA_LEDGER_SLUG` from the repo's gitignored `.env`, writes the resolved values
to `~/Library/Application Support/mars-universe/env`, and every script and the
plugin read that file.

## Updating

- **Ledger edits** (`.bean`, `config/*.yaml`): nothing to do, Fava reloads on change.
- **Web app code** (frequent): `just release-web`, or "Release web" in the menu.
  Builds in the repo, copies the standalone bundle to a fresh
  `releases/<timestamp>-<sha>[-dirty]/`, flips the `current` symlink and
  kickstarts the agent (about a one-second blip). The last 3 releases are kept.
  The menu shows the running SHA next to HEAD and flags when they differ.
- **Fava** (rare): `just restart-fava`, or "Restart Fava" in the menu. Runs
  `uv sync --frozen` then restarts. For a fork bump, edit the SHA in
  `pyproject.toml` and `uv lock` first; for extension edits under `packages/`,
  the restart alone is what matters.

Rollback a bad web release:

```sh
ls ~/Library/Application\ Support/mars-universe/web/releases/
ln -sfn ~/Library/Application\ Support/mars-universe/web/releases/<older> \
        ~/Library/Application\ Support/mars-universe/web/current
just svc restart web
```

## Day-to-day commands

```sh
just svc status                   # pids + which release is live
just svc restart fava|web|all
just svc stop all                 # unloads; `just svc start all` reloads
just uninstall-agents             # unload + remove plists and plugin link (keeps releases/logs)
```

`just web-dev` still works for development on :3000 and proxies to the service's
Fava, so no second terminal is needed for Fava while hacking on the web app.
`just fava` by hand will collide with the agent on :5000; stop the agent first.

## Gotchas

- macOS AirPlay Receiver listens on `*:5000` and answers 403. Fava's
  `127.0.0.1:5000` bind wins for localhost, but the plugin checks for a real
  `200` from `/<slug>/` rather than "something answered".
- launchd doesn't source your shell profile. The plists use absolute paths and
  set `PATH` themselves; `common.sh` does the same for scripts SwiftBar launches.
- `next.config.mjs` bakes `FAVA_INTERNAL_URL` and `FAVA_LEDGER_SLUG` into the
  proxy rewrites at build time, so `release-web.sh` exports them before `next build`.
- `apps/web/.env.local` is read by `next build` like any other build; whatever
  `NEXT_PUBLIC_*` values it holds ship in the release.
