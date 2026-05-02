# Known Bugs

Pragmatic list of bugs we've noticed but haven't fixed yet. Add new entries on top; strike through or delete when resolved.

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
