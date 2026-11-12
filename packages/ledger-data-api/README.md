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
- `people`: fully resolved people (job, `contributions` streams into the 401k, IRA and HSA,
  per-year `limits`, `hsaCoverage`, spending, one-offs, cash rules, returns, scenarios with
  `stay` first, starting balances per sleeve, and an `inherited` list of fields filled from
  `config/fire.yaml`). The older `k401` (limits, elections) and `ira` keys are still passed
  through; the page converts them to streams.
- `roster`: every configured person with `status` `ok` | `locked` | `missing` | `error`, so a
  person whose file is git-crypt encrypted still shows up
- `errors` / `warnings`: `{personId, path, message}`. Errors drop a person; warnings keep it.

A person entry may `include:` a `.yaml` file relative to the ledger folder (one level deep).
Absolute paths, `..` and symlinks that leave the folder are rejected; a file starting with the
git-crypt header is reported as `locked`. `starting.source: ledger` maps ledger positions at
`asof` to sleeves with ordered regex rules (first match wins). Balances are never logged.
Logic lives in `runway.py`; tests in `packages/beancount-tooling/tests/test_runway_api.py`.

## Card statements (planner)

A card statement is a durable record identified by `(account, closing date)`. Facts and
intent are stored apart:

- **Facts** (closed statements): `<LEDGER_DIR>/statements/billing/credit/<CardName>.jsonl`,
  append-only, written only by the fetch command in `beancount-tooling`. This package reads
  them with `billing.py` (a small copy of the tooling reader; the two packages do not depend
  on each other and share `tests/fixtures/billing_vectors.json`). Last line per id wins, a
  malformed line is ignored, `"void": true` removes an id.
- **Intent** (`<LEDGER_DIR>/journal/plan/`, written only here): per-card config in
  `cc-cards.json`, at most one **expected** statement per card in `cc-expected.json` (so a
  payment can be planned before the statement closes), and override plans in `plans.jsonl`
  tagged with `ccStatementId`. `cc-expected.json` also keeps, under the reserved key
  `_promoted`, the last promotion per card (`from` expected id, `to` closed id), so a save
  that still names a promoted expected id lands on the closed statement that claimed it.

A card with at least one closed statement is in **statement mode**: the active statement is
the newest one whose due date plus 3 days has not passed, the cycle runs from its closing
date to its due date, and the locked amount is the override plans if any, else the statement
minimum for a `minimumPaymentOnly` card, else the statement balance minus payments since
close. The expected statement drives the forecast row (override plans, else
`estimatedBalance`, else the computed forecast). After a due date has passed and before the
next statement closes nothing is locked; `statementExpectedSince` is set once the predicted
close is more than 3 days old and the card owes something. A card with no closed statement
is in **legacy mode** and works exactly as before from `cc-cards.json`
(`statementBalance`, `paymentDueDay`, `lastClosedDate`, `ccCycleMonth` tags).

**Promotion**: when a closed statement newer than the expected statement's `afterId`
appears, it claims the expected statement however far apart the dates are. Loading
statement data (`cc_statements.load_statement_data`, run by every endpoint below)
re-points the override plans to the closed id and deletes the expected record, once,
under a lock. On a read-only mount the same mapping is applied in memory on every read.

Endpoints (validation errors return HTTP 400 with `{"status": "error", "message": ...}`):

- `GET plan_grid`, `GET cc_cards`: each `ccCards` item adds `hasStatements`,
  `activeStatement`, `expectedStatement`, `statements` (newest first, at most 12),
  `nextCloseDate`, `nextDueDate`, `statementExpectedSince`, and in `plan_grid` only
  `lockedAmount`, `lockedSource`, `overrideTotal`, `computedForecast`. In statement mode the
  older keys (`statementBalance`, `lastClosedDate`, `remaining`, cycle dates) are filled
  from the facts. Grid entries add `ccStatementId` and `ccStatementKind`
  (`closed` | `expected` | `legacy` | `orphan`).
- `GET cc_statements?account=`: every closed statement of one card plus its expected one.
- `POST cc_expected_save` `{accountPath, id?, dueDate?, estimatedBalance?, expectId?}`:
  create (dates predicted when missing) or update; refused for a legacy-mode card. An
  estimate must be greater than 0. With `expectId`, the request is refused when the card's
  expected statement is no longer that one (it closed meanwhile).
- `POST cc_expected_delete` `{accountPath, onlyIfEmpty?}`: refused while override plans
  point at it. With `onlyIfEmpty`, a record carrying plans or an estimate is kept silently.
- `POST cc_card_save`: in statement mode, changing a day hint predicts the expected
  statement's dates again, unless override plans already sit on it.
- `POST cc_override_save` `{cardAccountPath, statementId | cycleMonth, plans}`:
  `statementId` is a strict foreign key (a closed or the expected statement of that card);
  `cycleMonth` is accepted only for a legacy-mode card.
- `POST plan_save`: a card tag whose key is absent from the body keeps its stored value.
- `POST cc_card_save`: in statement mode the typed `statementBalance` / `lastClosedDate`
  are ignored.

Logic lives in `cc_statements.py` (state, promotion, validation), `cc_projection.py` and
`merge.py`; tests in `tests/` (`just test-api`, synthetic ledgers in temp dirs only).
