# AGENTS.md

Guidance for coding agents working in `mars-universe-beancount`.

## Project Context

- Python 3.13 monorepo managed with `uv` workspaces; JS side uses `pnpm` workspaces.
- Beancount tooling for extraction, stock prices, and forecast generation.
- Primary code: `packages/beancount-tooling/src/beancount_tooling/` (`extract.py`, `update_stock_price.py`, `generate_forecast.py`).
- Forecast internals: `packages/beancount-tooling/src/beancount_tooling/forecast/`; importers: `packages/beancount-tooling/src/beancount_tooling/importer/`.
- Ledger data: `data/journal/`. Bank CSV exports (input): `data/statements/`.
- Plans live under `docs/plans/` (ISO-date prefixed); reference notes under `docs/notes/`.

## Environment Setup

- Install dependencies: `uv sync`
- Optional editable install for entry points: `uv pip install -e .`
- Verify Python version: `uv run python --version`

## Run Commands (Build/Execution)

**Always prefer `just <recipe>` over the underlying tool (npm/pnpm/webpack/uv/ruff/etc.).** The `Justfile` is the canonical entry point — recipes encode the correct workspace filter, env, and package list. Going around them risks running the wrong target or skipping setup. Before reaching for `npm run build` / `pnpm <script>` / `webpack` / `uv run …`, `grep -n` the `Justfile` for a matching recipe and use it. Only fall back to the underlying tool if no recipe exists.

- Extraction flow: `just extract`
- Stock price updater: `just prices`
- Forecast generation:
  - `just forecast`
  - Dry run: `uv run generate-forecast --dry-run` (no just recipe)
  - One month: `uv run generate-forecast --month 2026-03` (no just recipe)
  - Verbose: `uv run generate-forecast -v` (no just recipe)
- Fava (local viewer): `just fava`
- Web dev server: `just web-dev`
- Web build: `just web-build`
- Chrome extension build: `just build-extension` (output: `packages/card-balance-browser-extension/build/`)

## Lint/Format Commands

Use the `just` recipes — they cover the Python packages (`packages/beancount-tooling`, `packages/ledger-data-api`) and the JS/TS side (`apps/web`, `packages/card-balance-browser-extension`, linted/formatted by Biome via the root `biome.json`). Run from the repo root.

- Lint everything: `just lint` (= `just lint-py` + `just lint-js`)
- Format everything: `just fmt` (= `just fmt-py` + `just fmt-js`)
- Python only:
  - `just lint-py` → `uvx ruff check packages/beancount-tooling packages/ledger-data-api`
  - `just fmt-py`  → `uvx ruff format packages/beancount-tooling packages/ledger-data-api`
- JS/TS only (Biome):
  - `just lint-js` → `pnpm lint` (= `biome check .` from the repo root)
  - `just fmt-js`  → `pnpm format` (= `biome format --write .`)
  - Auto-fix safe Biome lint issues: `just lint-js-fix` (= `biome check --write .`)
- Auto-fix Python lint issues when safe: `uvx ruff check packages/beancount-tooling packages/ledger-data-api --fix`

After non-trivial edits, run the relevant subset (`lint-py`/`lint-js`) before reporting work as done. Don't invoke `ruff` or `biome` directly with a different scope — keep the scope aligned with the `Justfile` so cached results stay consistent.

## Test Commands

At the moment, there is no committed `tests/` suite or pytest config in this repo.
When adding tests, use `pytest` via `uv run` and follow commands below.

- Run all tests:
  - `uv run pytest`
- Run a test file:
  - `uv run pytest tests/test_forecast.py`
- Run a single test (important):
  - `uv run pytest tests/test_forecast.py::test_resolve_date_weekday`
- Run a single unittest-style test (if using stdlib unittest):
  - `uv run python -m unittest tests.test_forecast.TestResolveDate.test_weekday`
- Useful flags:
  - Quiet: `-q`
  - Stop on first failure: `-x`
  - Filter by keyword: `-k "resolve_date and weekday"`

## Smoke Checks (When No Formal Tests Exist)

- Forecast no-write check:
  - `uv run generate-forecast --dry-run --month 2026-03`
- Python syntax/import sanity:
  - `uv run python -m compileall script`

## Cursor/Copilot Rules

- `.cursorrules`: not present.
- `.cursor/rules/`: not present.
- `.github/copilot-instructions.md`: not present.

If any of these files are added later, treat them as higher-priority agent instructions and update this file.

## Code Style Guidelines

### Imports

- Order imports in three groups with blank lines: stdlib, third-party, local package imports.
- Prefer explicit imports over wildcard imports.
- Keep one import per line for clarity when practical.
- In new code, avoid runtime `sys.path` manipulation unless absolutely required for entrypoint compatibility.

### Formatting

- Use 4-space indentation; no tabs.
- Keep lines readable (target ~88-100 chars unless context needs longer).
- Prefer trailing commas in multiline literals/calls for cleaner diffs.
- Use double quotes consistently in new/edited code.
- Keep functions focused and small; extract helpers when logic branches repeatedly.

### Types

- Add type hints to new or significantly modified functions.
- Prefer built-in generics (`list[str]`, `dict[str, int]`) on Python 3.13.
- Use `Optional[T]` or `T | None` consistently within a file.
- For structured records, prefer `@dataclass` (as used in `packages/beancount-tooling/src/beancount_tooling/forecast/models.py`).
- Keep public function return types explicit.

### Naming Conventions

- `snake_case`: functions, variables, module-level constants that are not true constants.
- `UPPER_SNAKE_CASE`: true constants (config keys, fixed sets, patterns).
- `PascalCase`: classes (`*Importer`, dataclasses).
- Use descriptive names tied to finance/accounting semantics (`payment_account`, `merchant_map`, etc.).

### Error Handling

- Fail fast at CLI boundaries with clear messages and non-zero exit codes.
- In library/helper modules, prefer raising specific exceptions over bare `Exception`.
- Catch broad exceptions only at top-level command boundaries where user-facing logging is needed.
- Preserve traceback in verbose/debug paths; keep concise messages in normal mode.
- Validate external inputs early (YAML shape, date/month formats, API responses).

### File and I/O Practices

- Prefer `pathlib.Path` for new path logic.
- Use context managers (`with open(...)`) for file reads/writes.
- Ensure parent directories exist before writes (`mkdir(parents=True, exist_ok=True)`).
- Avoid destructive rewrites of ledger sections unless the flow explicitly preserves actual transactions.

### Beancount/Domain Conventions

- Preserve transaction metadata conventions (`ref`, `tid`) used by import/forecast flows.
- Keep forecast transaction ordering deterministic (sort by date before writing).
- Treat cleared transactions as authoritative during forecast merge.
- Keep account names as full Beancount paths (`Assets:...`, `Expenses:...`).

### Importer-Specific Conventions

- New importers should subclass `GeneralImporter` and implement `identify`, date/ref parsing, and transaction handling.
- Reuse merchant mapping and account selection flows where possible.
- Keep duplicate detection stable via deterministic reference generation.
- Avoid mutable default arguments in new code (`None` + in-function initialization instead).

### Config and Templates

- Keep `packages/beancount-tooling/src/beancount_tooling/config.yaml` and `.../templates.yaml` backward compatible.
- Validate required fields before processing.
- When adding template features, document expected keys and fallback behavior.

## Change Management for Agents

- Make minimal, targeted edits.
- Do not reformat unrelated files.
- Preserve existing behavior unless task explicitly requires behavior change.
- If introducing a new tool (lint/test), document command usage in this file.
- When adding tests, include at least one single-test invocation example in docs/PR notes.
