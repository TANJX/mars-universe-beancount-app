"""Synthetic ledger for fetcher tests.

LEDGER_DIR is set at import time, before anything imports
beancount_tooling.extract (which reads config/extract.yaml on import).
"""

import os
import shutil
import tempfile
from pathlib import Path

import pytest

FIXTURES = Path(__file__).parent / "fixtures"

EXTRACT_YAML = """\
accounts:
  - path: checking/DemoChecking
    bank: BofA
    importer: BofACheckingImporter
  - path: credit/DemoCard
    bank: BofA
    importer: BofAImporter
  - path: credit/DemoAmex
    bank: Amex
    importer: AmexImporter
categorization:
  payment_account: Assets:Pending-Transfer
"""

FETCH_YAML = """\
fetch:
  profile_dir: ~/.cache/test-fetcher/profile
  login_timeout_minutes: 2
  banks:
    bofa:
      credentials: { source: dashlane, id: "demo-item-id" }
      accounts:
        - path: checking/DemoChecking
          kind: checking
          last4: "0000"
          rolling: stmt.csv
        - path: credit/DemoCard
          kind: credit
          last4: "1111"
          rolling: current_1111.csv
          archive: "{MonthName}{YYYY}_1111.csv"
    amex:
      credentials: { source: keychain, service: demo-amex }
      accounts:
        - path: credit/DemoAmex
          last5: "TODO"
          rolling: activity.csv
          archive: "{YYYY}-{MM}.csv"
"""

_LEDGER = Path(tempfile.mkdtemp(prefix="fetch-test-ledger-"))
(_LEDGER / "config").mkdir()
(_LEDGER / "config" / "extract.yaml").write_text(EXTRACT_YAML)
(_LEDGER / "config" / "fetch.yaml").write_text(FETCH_YAML)
os.environ["LEDGER_DIR"] = str(_LEDGER)


def pytest_sessionfinish(session, exitstatus):
    shutil.rmtree(_LEDGER, ignore_errors=True)


@pytest.fixture
def ledger_dir() -> Path:
    return _LEDGER


@pytest.fixture
def fixture_text():
    def read(name: str) -> str:
        return (FIXTURES / name).read_text(newline="")

    return read
