set dotenv-load

default: help

help:
    @just --list

# Install all deps (JS + Python)
install:
    uv sync
    pnpm install

# Collides with the background agent on :5000 if `just install-agents` is in use; `just svc stop fava` first.
# Run Fava on the ledger in the foreground. Set LEDGER_DIR to override the default ./data location.
fava:
    uv run fava ${LEDGER_DIR:-./data}/journal/journal.beancount

# Extraction flow
extract:
    uv run extract
    just format

# Download bank statement CSVs into statements/ (config: $LEDGER_DIR/config/fetch.yaml)
fetch *args:
    uv run fetch {{args}}

# Re-align all .bean files in LEDGER_DIR (matches .vscode beancountFormatter prefixWidth=45).
# Excludes auto-generated directories (tickers/ written by update-stock-price).
format:
    @find "${LEDGER_DIR:-./data}" -type d -name tickers -prune -o -name '*.bean' -print | xargs uv run bean-format-compat -i -w 45

# Rewrite merchant payees to the canonical names in $LEDGER_DIR/config/merchants.yaml
# (header strings + a raw: line only). Flags: --dry-run, --month YYYY-MM, --file PATH.
normalize-payees *args:
    uv run normalize-payees {{args}}

# Stock price updater
prices:
    uv run update-stock-price

# Backfill historical prices so every held commodity has one price per ISO week
backfill-prices *args:
    uv run backfill-prices {{args}}

# Forecast generation
forecast *args:
    uv run generate-forecast {{args}}
    just format

# Regenerate the demo ledger's transactions/ tree (deterministic).
# Default points at a sibling checkout of mars-universe-beancount-demo.
regen-demo *args:
    uv run python scripts/generate-demo-ledger.py --out ../mars-universe-beancount-demo {{args}}

# Build the Chrome browser extension (output: packages/card-balance-browser-extension/build/)
build-extension:
    pnpm --filter card-balance-browser-extension build

# Run the Next.js viewer (apps/web) in production mode — http://localhost:3000
web *args:
    pnpm --filter web exec next start {{args}}

web-dev *args:
    pnpm --filter web dev {{args}}

web-build:
    pnpm --filter web build

# --- macOS background services (launchd agents + SwiftBar menu). See deploy/macos/README.md ---

# Render + load the Fava and web agents from .env, link the SwiftBar plugin. Builds a web release if none exists.
install-agents:
    deploy/macos/install.sh

uninstall-agents:
    deploy/macos/install.sh --uninstall

# Build the web viewer and promote it to the running service (about a one-second blip)
release-web:
    deploy/macos/release-web.sh

# uv sync + restart the Fava service (after a fork bump or extension change)
restart-fava:
    deploy/macos/restart-fava.sh

# start|stop|restart|status [fava|web|all]
svc *args:
    deploy/macos/ctl.sh {{args}}

# Python tests for beancount-tooling (args go to pytest, e.g. `just test -k merchant`).
# LEDGER_DIR comes from .env; the suite installs synthetic configs and never reads it.
test *args:
    cd packages/beancount-tooling && uv run pytest -q {{args}}

# Lint / format everything (Python + JS/TS)
lint: lint-py lint-js
fmt: fmt-py fmt-js

# Python (ruff fetched on-demand via uvx)
fmt-py:
    uvx ruff format packages/beancount-tooling packages/ledger-data-api

lint-py:
    uvx ruff check packages/beancount-tooling packages/ledger-data-api

# JS/TS via Biome (apps/web + browser extension), configured in biome.json
fmt-js:
    pnpm format

lint-js:
    pnpm lint

# Auto-fix Biome lint issues when safe
lint-js-fix:
    pnpm lint:fix
