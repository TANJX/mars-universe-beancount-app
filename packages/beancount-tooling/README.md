# Mars Universe Beancount Scripts

This directory contains automation scripts for managing beancount ledger entries.

## Scripts

### extract.py - Bank Transaction Importer

Imports actual transactions from bank CSV exports into beancount format.

**Usage:**
```bash
uv run extract
```

**How it works:**
1. Scans `data/statements/` directory for CSV files from banks
2. Uses beangulp importers to parse transactions
3. Deduplicates against existing entries using transaction references
4. Writes to `data/journal/transactions/YYYY-MM/{checking|credit|saving|investment}/`
5. Marks transactions with `*` flag (cleared/actual)

### generate_forecast.py - Forecasted Transaction Generator

Generates forecasted transactions for future months based on templates.

**Usage:**
```bash
# Generate all configured months
uv run generate-forecast

# Preview without writing (dry-run)
uv run generate-forecast --dry-run

# Generate specific month only
uv run generate-forecast --month 2026-03

# Verbose output
uv run generate-forecast -v
```

**How it works:**
1. Reads configuration from `packages/beancount-tooling/src/beancount_tooling/templates.yaml`
2. Generates forecasted transactions (salary, loans, etc.)
3. Writes to `data/journal/transactions/YYYY-MM/{checking|investment}/`
4. Marks transactions with `!` flag (pending/forecasted)
5. **Smart skip logic**: Never overwrites files containing actual (`*`) transactions

**Key Features:**
- **Idempotent**: Safe to run multiple times
- **Non-destructive**: Automatically skips files with actual transactions
- **Flexible**: Month-specific overrides for varying amounts
- **Account-aware**: Different payees/narrations per account

### update_stock_price.py - Stock Price Updater

Fetches current stock and cryptocurrency prices.

**Usage:**
```bash
uv run update-stock-price
```

---

## Configuration Files

### templates.yaml - Forecast Configuration

**Source of truth** for all forecasted transactions. Edit this file to update future month forecasts.

#### Quick Start

To add a new month:

1. **Add month to forecast list:**
   ```yaml
   forecast:
     months:
       - "2026-02"
       - "2026-03"
       - "2026-04"
       - "2026-05"  # <-- Add new month
   ```

2. **Add month-specific overrides (optional):**

   If the new month uses default amounts, you only need to specify the Tesla loan:
   ```yaml
   months:
     "2026-05":
       tesla_loan:
         principal: 779.90  # Increases monthly as loan is paid down
   ```

   If paycheck amounts change, override specific payments:
   ```yaml
   months:
     "2026-05":
       salary:
         overrides:
           main_paycheck_1:  # Override first paycheck
             distribution:
               TD: 3000.00    # Only override what changes
           main_paycheck_2:  # Override second paycheck
             distribution:
               TD: 2900.00
       tesla_loan:
         principal: 779.90
   ```

3. **Generate forecasts:**
   ```bash
   uv run generate-forecast
   ```

#### Structure

**Top-level sections:**
- `forecast`: Which months to generate and transaction flags
- `accounts`: Mapping of short names to beancount accounts and file paths
- `defaults`: Default values for all transaction templates
- `months`: Month-specific overrides
- `custom_templates`: Custom recurring transactions (e.g., rent, taxes)

**Template String Support:**

Both narrations and file paths support template variables:
- `{year}`: Year (e.g., "2026")
- `{month}`: Month zero-padded (e.g., "03")
- `{day}`: Day zero-padded (e.g., "15")
- `{month_name}`: Full month name (e.g., "March")
- `{month_abbr}`: Abbreviated month name (e.g., "Mar")

Examples:
- Narration: `"Rent for {month_name} {year}"` → "Rent for March 2026"
- File path: `"{year}-{month}/checking/TD.bean"` → "2026-03/checking/TD.bean"
- File path: `"checking/TD.bean"` → Standard location: month/checking/TD.bean
- File path: `"rent.bean"` → File at root of month directory

**Salary configuration (payment-based):**

The salary configuration is now a **list of distinct payments**, each with its own:
- `id`: Unique identifier for matching overrides (e.g., `main_paycheck_1`, `commuter_benefit`, `hsa_contribution`)
- `date`: Day of month (15, -1 for last day, etc.)
- `payee`: Who the payment is from (e.g., "Acme Inc", "HSA Custodian", "HSA Contribution")
- `narration`: Transaction description
- `income_account`: Which income account to credit
- `distribution`: Dict of {account: amount} for this specific payment

**Why payment-based?**
- **Clarity**: Commuter benefit and HSA are separate payments with different payees
- **Flexibility**: Each payment can have different dates, amounts, and metadata
- **Explicit**: No complex date_overrides or account_overrides logic

**Available payment IDs (in defaults):**
- `main_paycheck_1`: First paycheck to checking accounts (15th)
- `commuter_benefit`: Pre-tax commuter benefit to Optum checking (15th)
- `main_paycheck_2`: Second paycheck to checking accounts (last day)
- `hsa_contribution`: HSA contribution to Optum investment (last day)

**Month-specific overrides:**

Use `salary.overrides` to modify specific payments by ID. Only specify what changes:
```yaml
salary:
  overrides:
    main_paycheck_1:  # Match by ID
      distribution:
        TD: 3000.00    # Only override TD, other accounts use defaults
```

**Tesla loan configuration:**
- `date`: Day of month for payment (16th)
- `total_payment`: Fixed payment amount
- `principal`: Varies month-to-month (increases as interest decreases)

#### Example Monthly Update Workflow

**Scenario 1: Default amounts (most months)**

```bash
# 1. Edit templates.yaml - just add the month and Tesla principal
vim packages/beancount-tooling/src/beancount_tooling/templates.yaml

# Add to forecast.months: - "2026-05"
# Add to months section:
#   "2026-05":
#     tesla_loan:
#       principal: 779.90

# 2. Generate forecasts
uv run generate-forecast

# 3. Commit
git add packages/beancount-tooling/src/beancount_tooling/templates.yaml data/journal/transactions/
git commit -m "Add forecasts for 2026-05"
```

**Time required:** ~1 minute per month

**Scenario 2: Paycheck amounts change**

```bash
# 1. Edit templates.yaml
vim packages/beancount-tooling/src/beancount_tooling/templates.yaml

# Add month with salary overrides:
#   "2026-05":
#     salary:
#       overrides:
#         main_paycheck_1:
#           distribution:
#             TD: 3000.00  # New amount
#     tesla_loan:
#       principal: 779.90

# 2. Preview and generate
uv run generate-forecast --dry-run
uv run generate-forecast

# 3. Review and commit
git diff data/journal/transactions/
git add packages/beancount-tooling/src/beancount_tooling/templates.yaml data/journal/transactions/
git commit -m "Update forecasts for 2026-05 with salary increase"
```

**Time required:** ~2 minutes per month

---

## Workflow Integration

### Monthly Workflow

**Start of Month:**
1. Edit `packages/beancount-tooling/src/beancount_tooling/templates.yaml` to add next month's forecasts
2. Run `generate_forecast.py` to create forecast files
3. Commit changes

**Throughout Month:**
1. Export bank statements to `data/statements/` directory
2. Run `extract.py` to import actual transactions
3. Actual transactions marked with `*` flag
4. `generate_forecast.py` automatically skips files with actuals

**End of Month:**
1. Run `update_stock_price.py` to update investment prices
2. Review balances in Fava

### File Ownership

**Clear separation between forecasted and actual:**

| Script | Flag | Status | File Ownership |
|--------|------|--------|----------------|
| `generate_forecast.py` | `!` | Pending/Forecasted | Writes until actuals appear |
| `extract.py` | `*` | Cleared/Actual | Takes over when bank data arrives |

**Once `extract.py` writes actual transactions to a file, `generate_forecast.py` will never touch it again.**

---

## Troubleshooting

### Issue: "No module named 'yaml'"

**Solution:** Always run scripts with `uv run`:
```bash
uv run generate-forecast
```

### Issue: Forecasts not generating for a month

**Check:**
1. Is the month in `forecast.months` list?
2. Does the file already contain actual (`*`) transactions?
3. Run with `-v` for verbose output

### Issue: Wrong amounts in generated forecasts

**Check:**
1. Is there a month-specific override in `months` section?
2. Is there an account-specific override in `account_overrides`?
3. Check `second_paycheck` section for second-paycheck overrides

### Issue: Want to regenerate forecasts after editing template

**Solution:** Just re-run the script:
```bash
uv run generate-forecast
```

The script will overwrite existing forecast files (those without `*` transactions).

---

## Advanced Usage

### Adding Custom Templates (Rent, Utilities, etc.)

For recurring transactions that aren't salary-related:

**1. Add account definition:**
```yaml
accounts:
  Rent:
    beancount_account: "Expenses:Rent"
    file: "rent.bean"  # File at month root, or "expenses/rent.bean" for subdirectory
```

**2. Add custom template:**
```yaml
custom_templates:
  # Monthly rent
  - months: ["2026-02", "2026-03", "2026-04"]  # List of months
    account: Rent  # Which account file to write to
    date: 1  # 1st of month
    payee: "Landlord"
    narration: "Rent for {month_name} {year}"  # Template string!
    postings:
      - account: "Assets:Checking:TD"
        amount: -2500.00
      - account: "Expenses:Rent"
        amount: null  # null = residual posting (auto-calculated)
```

**Key features:**
- `months`: List of months where this template applies
- `account`: References account in `accounts` section to determine file path
- `enabled`: Optional, defaults to true (can disable like quarterly bonuses)
- `postings`: List of account postings, `amount: null` for residual
- Template strings work in `narration` field

### Adding New Accounts

1. **Add to `accounts` section:**
   ```yaml
   accounts:
     NewAccount:
       beancount_account: "Assets:Checking:NewAccount"
       file: "checking/NewAccount.bean"  # Template string format
   ```

2. **Add to a payment's distribution:**
   ```yaml
   defaults:
     salary:
       payments:
         - id: main_paycheck_1
           date: 15
           payee: "Acme Inc"
           narration: ""
           income_account: "Income:Salary:Acme"
           distribution:
             TD: 2875.75
             BofA: 250.00
             NewAccount: 100.00  # <-- Add here
   ```

### Adding New Payment Types

To add a recurring payment that only happens in certain months (e.g., quarterly bonus):

**1. Add to defaults with `enabled: false`:**

```yaml
defaults:
  salary:
    payments:
      # ... existing payments ...

      # Quarterly bonus (disabled by default)
      - id: quarterly_bonus
        enabled: false  # Only enable in quarter-end months
        date: -1  # Last day of quarter
        payee: "Acme Inc"
        narration: "Quarterly Performance Bonus"
        income_account: "Income:Bonus:Acme"
        distribution:
          TD: 5000.00
```

**2. Enable for specific months:**

```yaml
months:
  "2026-03":  # Q1 end
    salary:
      overrides:
        quarterly_bonus:
          enabled: true  # Enable for this month
          distribution:
            TD: 6000.00  # Optionally override amount

  "2026-06":  # Q2 end
    salary:
      overrides:
        quarterly_bonus:
          enabled: true  # Use default $5000 amount

  "2026-09":  # Q3 end
    salary:
      overrides:
        quarterly_bonus:
          enabled: true

  "2026-12":  # Q4 end
    salary:
      overrides:
        quarterly_bonus:
          enabled: true
```

**How it works:**
- By default (`enabled: false`), the payment is skipped for all months
- Override `enabled: true` in specific months to generate the payment
- This prevents the quarterly bonus from appearing in every month

---

## File Locations

```
packages/beancount-tooling/
  ├── README.md                    # This file
  ├── pyproject.toml
  └── src/beancount_tooling/
      ├── templates.yaml           # Forecast configuration (edit this!)
      ├── config.yaml              # Import configuration
      ├── generate_forecast.py     # Forecast generator
      ├── extract.py               # Transaction importer
      ├── update_stock_price.py    # Price updater
      ├── forecast/                # Forecast engine modules
      └── importer/                # Bank-specific importers

data/journal/
  ├── journal.beancount            # Main ledger entry point
  ├── accounts.bean                # Account definitions
  └── transactions/
      └── YYYY-MM/                 # Monthly transactions
          ├── checking/            # Checking account files
          │   ├── TD.bean
          │   ├── BofA.bean
          │   └── ...
          ├── investment/          # Investment account files
          │   └── Optum.bean
          ├── credit/              # Credit card files
          └── saving/              # Savings account files

data/statements/                   # CSV exports from banks (input)
```

---

## Design Philosophy

### Simplicity
- Copy-paste previous month → tweak 2-3 numbers → done
- No complex formulas or calculations in config
- What you see is what you get

### Safety
- Never overwrites actual bank data
- Idempotent operations
- Clear visual separation (`!` vs `*` flags)

### Maintainability
- Single source of truth (`templates.yaml`)
- All amounts explicit in config
- Easy to audit and update

### Flexibility
- Month-specific overrides for varying amounts
- Account-specific payees and narrations
- Extensible for custom transaction types
