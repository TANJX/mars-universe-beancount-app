"""Resolve user-data paths from the LEDGER_DIR env var.

LEDGER_DIR points to the root of a ledger working copy. Layout inside:
    journal/        beancount files (entry point: journal.beancount)
    statements/     raw CSV bank statement exports
    config/         user config (extract.yaml, forecast.yaml)

Until the repo split is complete, LEDGER_DIR defaults to <repo_root>/data so
existing local-dev workflows keep working. After the split, callers are
expected to set LEDGER_DIR explicitly.
"""

import os
from pathlib import Path


_PACKAGE_REPO_ROOT = Path(__file__).resolve().parents[4]
_DEFAULT_LEDGER_DIR = _PACKAGE_REPO_ROOT / "data"


def get_ledger_dir() -> Path:
    env = os.environ.get("LEDGER_DIR")
    return Path(env).expanduser().resolve() if env else _DEFAULT_LEDGER_DIR


def get_config_dir() -> Path:
    return get_ledger_dir() / "config"


def get_journal_dir() -> Path:
    return get_ledger_dir() / "journal"


def get_journal_file() -> Path:
    return get_journal_dir() / "journal.beancount"


def get_statements_dir() -> Path:
    return get_ledger_dir() / "statements"


def get_transactions_dir() -> Path:
    return get_journal_dir() / "transactions"
