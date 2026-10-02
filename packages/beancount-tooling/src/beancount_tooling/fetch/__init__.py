"""Statement fetcher: download bank CSV exports into $LEDGER_DIR/statements/.

Entry point: `just fetch` (beancount_tooling.fetch.cli). Bank-specific site
logic lives in banks/<bank>.py; everything else here is shared.
"""
