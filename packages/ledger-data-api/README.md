# ledger-data-api

Fava extension that exposes HTTP endpoints for account balances, planner data (plans, transfers, CC payments + projections), and bank-panel settings. Consumed by:

- [`apps/web`](../../apps/web/) — Next.js viewer (the primary planner UI)
- [`card-balance-browser-extension`](../card-balance-browser-extension/) — Chrome MV3 extension that overlays card balances on bank sites (uses `get_balance` only)

Loaded by Fava via `custom "fava-extension" "ledger_data_api"` in `data/journal/journal.beancount`. Endpoints-only — no Fava report page (the SPA that previously rendered inline was retired; see `docs/plans/2026-04-27-cash-planner.md`).
