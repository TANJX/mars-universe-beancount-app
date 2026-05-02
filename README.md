# Mars Universe — Beancount Monorepo

Polyglot monorepo for personal-finance beancount tooling, a Fava extension, a spreadsheet UI, and a Chrome extension. Managed with `uv` (Python) and `pnpm` (JS) workspaces, with `just` as the cross-language task runner.

## Layout

```
apps/
  web/                            # Next.js viewer (the primary planner UI)

data/
  journal/       # the beancount ledger
  statements/    # bank CSV exports (input to the extractor)

packages/
  beancount-tooling/              # Python CLI: extract / update-stock-price / generate-forecast
  ledger-data-api/                # Fava extension — HTTP endpoints consumed by apps/web + the Chrome extension
  card-balance-browser-extension/ # Chrome MV3 extension — overlays card balances on bank sites

docs/
  plans/   # time-bound proposals (ISO-date prefix)
  notes/   # living reference (accounts, reports, reconciliation, known bugs)
```

See [`docs/plans/2026-04-19-monorepo-reorg.md`](docs/plans/2026-04-19-monorepo-reorg.md) for the reorg history and tooling rationale.

## Quickstart

```bash
just install       # uv sync && pnpm install
just fava          # run Fava on data/journal/journal.beancount
```

Requires `uv`, `pnpm`, and `just` on your PATH (`brew install just uv pnpm`). Python 3.13 is pinned via `.python-version`.

## Just Recipes

```bash
just                 # list all recipes
just install         # uv sync + pnpm install
just fava            # Fava viewer on the ledger
just extract         # import bank CSVs → beancount transactions
just prices          # update stock/crypto prices
just forecast        # generate forecasted transactions (supports flags, e.g. --dry-run --month 2026-03)
just web             # run the Next.js viewer (apps/web)
just build-extension # build the Chrome extension (output: packages/card-balance-browser-extension/build/)
just fmt             # ruff format across Python packages
just lint            # ruff check across Python packages
```

Any recipe can also be invoked via `uv run <cmd>` or `pnpm --filter <pkg> <script>` directly.

## Fava Fork

This project uses a local CORS-patched Fava checked out at `../fava`, pinned via `[tool.uv.sources]` in the root `pyproject.toml`. The patch also imports `flask_cors`, which the fork doesn't declare — we pull `flask-cors` in as a root dep.

## References

- https://sylvaindurand.org/personal-finance-with-beancount/
