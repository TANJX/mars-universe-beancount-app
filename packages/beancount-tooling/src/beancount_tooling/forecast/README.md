# Forecast Generation Module

This module generates forecasted beancount transactions from templates defined in `templates.yaml`.

## Overview

The forecast generator creates pending (`!`) transactions for expected recurring transactions like salary, loan payments, and subscriptions. When actual transactions are imported and cleared (`*`), the forecasts are preserved alongside them.

## File Structure

```
script/forecast/
├── __init__.py           # Package exports
├── config.py             # Configuration loading from templates.yaml
├── file_handler.py       # File I/O and transaction merging
├── models.py             # Data models (TemplateTransaction, TemplatePosting)
└── template_generator.py # Template instantiation logic
```

## Transaction ID (tid) System

Each forecasted transaction has a unique `tid` (transaction ID) in its metadata:

```beancount
2026-01-31 ! "Company Inc" ""
  Assets:Checking:Bank    1000.00 USD
    tid: "main_paycheck_2:2026-01"
  Income:Salary:Company
```

The tid format is: `{template_name}:{month}`

When an actual transaction arrives and is cleared, it can keep the same tid to indicate it fulfills that forecast:

```beancount
2026-01-31 * "Company Inc Direct Deposit" ""
  Assets:Checking:Bank    1000.00 USD
    ref: "20260131123456789"
    tid: "main_paycheck_2:2026-01"
  Income:Salary:Company
```

## Generation Logic

When the forecast generator runs, it processes each target file with this logic:

### Step 1: Split File into Sections

The file is split into two sections:
- **Forecasted section** (top): Pending forecasts that can be regenerated
- **Actual section** (bottom): Real transactions that must be preserved

A transaction is considered part of the **actual section** (preserved) if:
- It does NOT have a `tid:` metadata, OR
- It is marked as cleared (`*`)

A transaction is considered part of the **forecasted section** (replaceable) only if:
- It has a `tid:` metadata, AND
- It is marked as pending (`!`)

### Step 2: Identify Cleared tids

From the actual section, extract all `tid` values from cleared (`*`) transactions. These represent forecasts that have been fulfilled by actual transactions.

### Step 3: Filter Templates

Templates are filtered before generating new forecasts. A template is **skipped** if:
1. **Past date**: The template date is on or before today
2. **Already cleared**: A cleared transaction with the same tid exists in the actual section

### Step 4: Generate and Write

1. Generate new forecasted section from filtered templates
2. Combine: new forecasted section + preserved actual section
3. Write to file

## Example Scenarios

### Scenario 1: Normal Operation

File before (2026-01-20):
```beancount
2026-01-15 ! "Company" ""
  Assets:Checking  1000.00 USD
    tid: "paycheck_1:2026-01"
  Income:Salary

2026-01-31 ! "Company" ""
  Assets:Checking  1000.00 USD
    tid: "paycheck_2:2026-01"
  Income:Salary
```

File after running generator:
```beancount
2026-01-31 ! "Company" ""
  Assets:Checking  1000.00 USD
    tid: "paycheck_2:2026-01"
  Income:Salary
```

The 01-15 forecast is removed (past date).

### Scenario 2: Actual Transaction Imported

File before:
```beancount
2026-01-31 ! "Company" ""
  Assets:Checking  1000.00 USD
    tid: "paycheck_2:2026-01"
  Income:Salary

2026-01-15 * "Company Direct Deposit" ""
  Assets:Checking  1000.00 USD
    tid: "paycheck_1:2026-01"
  Income:Salary
```

File after running generator (no change):
```beancount
2026-01-31 ! "Company" ""
  Assets:Checking  1000.00 USD
    tid: "paycheck_2:2026-01"
  Income:Salary

2026-01-15 * "Company Direct Deposit" ""
  Assets:Checking  1000.00 USD
    tid: "paycheck_1:2026-01"
  Income:Salary
```

The cleared 01-15 transaction is preserved in the actual section.

### Scenario 3: Future Forecast Already Cleared

File before:
```beancount
2026-01-31 * "Company Early Deposit" ""
  Assets:Checking  1000.00 USD
    tid: "paycheck_2:2026-01"
  Income:Salary
```

File after running generator (no change):
```beancount
2026-01-31 * "Company Early Deposit" ""
  Assets:Checking  1000.00 USD
    tid: "paycheck_2:2026-01"
  Income:Salary
```

Even though 01-31 is a future date, no forecast is generated because a cleared transaction with that tid already exists.

## Module Components

### `file_handler.py`

- `split_forecasted_and_actual()`: Splits file into replaceable forecasts and preserved actuals
- `extract_cleared_tids()`: Extracts tid values from cleared transactions
- `generate_forecasted_section()`: Formats templates as beancount transactions
- `merge_and_write_file()`: Main entry point for processing a single file

### `template_generator.py`

- `generate_month_templates()`: Instantiates templates for a given month
- Handles date calculation (specific day, last day of month, etc.)

### `models.py`

- `TemplateTransaction`: Data class for a single transaction template
- `TemplatePosting`: Data class for a posting within a transaction
- `get_transaction_tid()`: Extracts tid from a beancount Transaction object

### `config.py`

- `load_config()`: Loads and validates `templates.yaml`
