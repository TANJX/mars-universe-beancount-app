# Mars Universe — Beancount Monorepo

Polyglot monorepo for personal-finance beancount tooling, a Fava extension, a spreadsheet UI, and a Chrome extension. Managed with `uv` (Python) and `pnpm` (JS) workspaces, with `just` as the cross-language task runner.

## Layout

```
apps/
  web/                            # Next.js viewer (the primary planner UI)

packages/
  beancount-tooling/              # Python CLI: extract / update-stock-price / generate-forecast
  ledger-data-api/                # Fava extension — HTTP endpoints consumed by apps/web + the Chrome extension
  card-balance-browser-extension/ # Chrome MV3 extension — overlays card balances on bank sites

deploy/                           # Docker Compose stack (gitsync + fava + web)

docs/
  notes/   # living reference (accounts, reports, reconciliation, known bugs)
```

Ledger data lives **outside this repo**, in a separate (private) working copy pointed at by `LEDGER_DIR`. Expected layout inside it:

```
journal/      # the beancount ledger (journal.beancount is the entry point)
config/       # extract.yaml, forecast.yaml, ui.yaml
statements/   # bank CSV exports (input to `just extract`)
```

Templates for the three config files ship next to the code that reads them: `packages/beancount-tooling/src/beancount_tooling/{extract,forecast}.example.yaml` and `apps/web/lib/config/ui.example.yaml`.

## Quickstart

```bash
cp .env.example .env   # then set LEDGER_DIR + FAVA_LEDGER_SLUG
just install           # uv sync && pnpm install
just fava              # run Fava on $LEDGER_DIR/journal/journal.beancount
just web-dev           # Next.js viewer on http://localhost:3000
```

Requires `uv`, `pnpm`, and `just` on your PATH (`brew install just uv pnpm`). Python 3.13 is pinned via `.python-version`.

## Environment

The root `.env` (gitignored, see `.env.example`) is loaded by the Justfile via `set dotenv-load` and exported into every recipe, so cross-workspace values live there:

| Var | Used by | Default |
|---|---|---|
| `LEDGER_DIR` | `Justfile`, `beancount_tooling.paths` | `<repo>/data` (absent in a fresh clone — set this) |
| `FAVA_LEDGER_SLUG` | `apps/web/next.config.mjs`, extension `build.js` | `acme-demo` |
| `FAVA_INTERNAL_URL` | `apps/web/next.config.mjs` | `http://127.0.0.1:5000` |

`apps/web` also reads its own `apps/web/.env` for client-side values (`NEXT_PUBLIC_LOGO_DEV_TOKEN`, `NEXT_PUBLIC_DEMO_MODE`, `NEXT_PUBLIC_APP_TITLE`) — see `apps/web/README.md`. Docker deploys configure everything through `deploy/.env`; see `deploy/README.md`.

Two things to know about `FAVA_LEDGER_SLUG`, because getting it wrong is the most common source of 404s:

- It must equal Fava's slugification of your journal's `option "title"`. Find the real value with `curl -sI http://127.0.0.1:5000/ | grep -i location` while `just fava` runs.
- Both consumers bake it in at build time. Changing it requires restarting `next dev`, plus a `just web-build` and `just build-extension` for the built artifacts. A stale value shows up as a 404 served by *Fava* (`Server: Cheroot`), not by Next.

Only `just` loads the root `.env`. Invoking the underlying tool directly (`pnpm --filter web dev`) skips it and silently falls back to the `acme-demo` defaults, so prefer the recipes.

## Just Recipes

```bash
just                 # list all recipes
just install         # uv sync + pnpm install

just fava            # Fava viewer on $LEDGER_DIR/journal/journal.beancount
just extract         # import bank CSVs → beancount transactions (then re-aligns)
just prices          # update stock/crypto prices
just forecast        # generate forecasted transactions (flags pass through, e.g. --dry-run --month 2026-03)
just format          # re-align all .bean files in $LEDGER_DIR (prefix width 45)
just regen-demo      # regenerate the demo ledger's transactions/ tree

just web-dev         # Next.js viewer in dev mode (apps/web)
just web-build       # production build of apps/web
just web             # serve the production build
just build-extension # build the Chrome extension (output: packages/card-balance-browser-extension/build/)

just fmt             # fmt-py + fmt-js  (ruff format + biome format)
just lint            # lint-py + lint-js (ruff check + biome check)
just lint-js-fix     # apply Biome's safe autofixes
```

`fmt-py` / `lint-py` cover `packages/beancount-tooling` and `packages/ledger-data-api` via `uvx ruff`; `fmt-js` / `lint-js` cover `apps/web` and the browser extension via Biome (root `biome.json`).

Prefer the recipes over the underlying tool: they encode the correct workspace filter and, via `set dotenv-load`, the root `.env`. A few flows have no recipe and are run directly — `uv run generate-forecast --dry-run`, `uv run generate-forecast --month 2026-03`, `uv run pytest`.

## Fava Fork

This project uses a local CORS-patched Fava checked out at `../fava`, pinned via `[tool.uv.sources]` in the root `pyproject.toml`. The patch also imports `flask_cors`, which the fork doesn't declare — we pull `flask-cors` in as a root dep.

## References

- https://sylvaindurand.org/personal-finance-with-beancount/
