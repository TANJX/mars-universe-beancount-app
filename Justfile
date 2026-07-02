set dotenv-load

default: help

help:
    @just --list

# Install all deps (JS + Python)
install:
    uv sync
    pnpm install

# Run Fava on the ledger. Set LEDGER_DIR to override the default ./data location.
fava:
    uv run fava ${LEDGER_DIR:-./data}/journal/journal.beancount
    <!-- uv run fava ${LEDGER_DIR:-./data}/journal/journal.beancount -H 0.0.0.0 --port 5000 -->

# Extraction flow
extract:
    uv run extract
    just format

# Re-align all .bean files in LEDGER_DIR (matches .vscode beancountFormatter prefixWidth=45).
# Excludes auto-generated directories (tickers/ written by update-stock-price).
format:
    @find "${LEDGER_DIR:-./data}" -type d -name tickers -prune -o -name '*.bean' -print | xargs uv run bean-format-compat -i -w 45

# Stock price updater
prices:
    uv run update-stock-price

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
