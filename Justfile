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

# Stock price updater
prices:
    uv run update-stock-price

# Forecast generation
forecast *args:
    uv run generate-forecast {{args}}

# Regenerate the demo ledger's transactions/ tree (deterministic).
# Default points at a sibling checkout of mars-universe-beancount-demo.
regen-demo *args:
    uv run python scripts/generate-demo-ledger.py --out ../mars-universe-beancount-demo {{args}}

# Build the Chrome browser extension (output: packages/card-balance-browser-extension/build/)
build-extension:
    pnpm --filter card-balance-browser-extension build

# Run the Next.js viewer (apps/web) in production mode — http://localhost:3000
web:
    pnpm --filter web exec next start -H 0.0.0.0 -p 3000

web-dev:
    pnpm --filter web dev

web-build:
    pnpm --filter web build

# Lint / format everything (Python + web)
lint: lint-py lint-web
fmt: fmt-py fmt-web

# Python (ruff fetched on-demand via uvx)
fmt-py:
    uvx ruff format packages/beancount-tooling packages/ledger-data-api

lint-py:
    uvx ruff check packages/beancount-tooling packages/ledger-data-api

# Next.js web app (apps/web)
fmt-web:
    pnpm --filter web format

lint-web:
    pnpm --filter web lint
