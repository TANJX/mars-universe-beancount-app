# ledger-data-api

Fava extension that exposes HTTP endpoints for account balances, planner data (plans, transfers, CC payments + projections), and bank-panel settings. Consumed by:

- [`apps/web`](../../apps/web/) — Next.js viewer (the primary planner UI)
- [`card-balance-browser-extension`](../card-balance-browser-extension/) — Chrome MV3 extension that overlays card balances on bank sites (uses `get_balance` only)

Loaded by Fava via `custom "fava-extension" "ledger_data_api"` in `data/journal/journal.beancount`. Endpoints-only — no Fava report page (the SPA that previously rendered inline was retired; see `docs/plans/2026-04-27-cash-planner.md`).

## Runway endpoint

`GET /api/ext/runway_data` feeds the web app's `/runway` page (a monthly cash and sleeve
simulator per person; the engine runs in the browser). It reads
`<LEDGER_DIR>/config/runway.yaml` (example: `apps/web/lib/runway/runway.example.yaml`) and
returns one camelCase payload:

- `asof`, `fromConfig`, `start` (YYYY-MM), `months`, `firstMonthSpendFraction`,
  `spreadThrough` (`horizon` | `year_end`), `reserveLookahead`, `playCap`, `defaults`
- `people`: fully resolved people (job, 401k limits and elections, spending, IRA, one-offs,
  cash rules, returns, scenarios with `stay` first, starting balances per sleeve, and an
  `inherited` list of fields filled from `config/fire.yaml`)
- `roster`: every configured person with `status` `ok` | `locked` | `missing` | `error`, so a
  person whose file is git-crypt encrypted still shows up
- `errors` / `warnings`: `{personId, path, message}`. Errors drop a person; warnings keep it.

A person entry may `include:` a `.yaml` file relative to the ledger folder (one level deep).
Absolute paths, `..` and symlinks that leave the folder are rejected; a file starting with the
git-crypt header is reported as `locked`. `starting.source: ledger` maps ledger positions at
`asof` to sleeves with ordered regex rules (first match wins). Balances are never logged.
Logic lives in `runway.py`; tests in `packages/beancount-tooling/tests/test_runway_api.py`.
