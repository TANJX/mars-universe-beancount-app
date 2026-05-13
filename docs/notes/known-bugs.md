# Known Bugs

Pragmatic list of bugs we've noticed but haven't fixed yet. Add new entries on top; strike through or delete when resolved.

---

## ~~Journal Σ USD column ignores narrowing filters in opening seed~~ — **fixed 2026-05-13**

**File:** `apps/web/app/(ledger)/journal/page.tsx` (seed override now applied at the cumulative useMemo).
**Fix:** Option 1 from below — collapse the opening seed to 0 whenever `parsed.links | tags | payees | text | excludeAccounts` is non-empty, or `parsed.accounts.length > 1`. Matches Fava: its `filter=` is applied to the synthesized opening `Balance` entry too, and that entry carries no link/tag/payee, so it gets filtered out at the period boundary.

Keeping the matrix below as reference — useful next time someone touches `use-opening-balance.ts` or the cumulative column.

**Fava's full behavior matrix:**

| Account root | No narrowing filter | Narrowing filter present |
|---|---|---|
| Assets / Liabilities / Equity | Opening = balance-sheet snapshot at period start (carries history). | Opening collapses to **0** (synthesized opening entry is filtered out). |
| Income / Expenses | Opening = 0 (swept into retained earnings at fiscal-year boundary). | Opening = 0 (unchanged). |

Time-range alone doesn't change the matrix beyond what the period-open snapshot already encodes.

---

## `AppleImporter.handle_transaction` — bad kwarg to `prompt_user_select`

**File:** `packages/beancount-tooling/src/beancount_tooling/importer/apple.py:70`
**Noticed:** 2026-04-23 (surfaced after monorepo reorg R1 when dedup was briefly broken and every Apple CSV row entered the interactive-prompt branch).

**What breaks:**
```python
account_name = prompt_user_select(
    trans_merchant,
    info=[row['Transaction Date'], trans_merchant, trans_amt],
    categories=self.expense_categories,   # <-- unknown kwarg
    all_accounts=self.all_accounts,
)
```

`helper.py:26` signature is `prompt_user_select(trans_desc: str, info: list, all_accounts: list = []) -> str` — there is no `categories` parameter. The helper's docstring even mentions `categories` "for backward compatibility" but the actual signature dropped it.

**Trigger:** Only fires when an Apple card CSV contains a merchant not yet in `merchant_map`, so it stayed hidden while every Apple merchant happened to be pre-categorized. Other importers (`amex.py`, `bofa.py`, `bilt.py`, `chase.py`, `discover.py`, `robinhood.py`) call `prompt_user_select` correctly — only `apple.py` passes `categories`.

**Possible fixes:**
1. Drop the `categories=self.expense_categories` line from the call in `apple.py`. Simplest.
2. Accept and ignore `categories` in `helper.prompt_user_select` via `**_ignored` — keeps the docstring honest; protects against any other importer drifting the same way.

Option 1 is cleaner. Option 2 is more defensive.
