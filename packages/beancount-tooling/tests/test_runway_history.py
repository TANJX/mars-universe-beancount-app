"""ledger_data_api.runway_history: actual month-end sleeves and monthly flows.

Synthetic ledger and config only (tests/fixtures/runway/)."""

import datetime
import shutil
from pathlib import Path
from types import SimpleNamespace

import pytest
from beancount import loader
from ledger_data_api import runway_history

FIXTURES = Path(__file__).parent / "fixtures" / "runway"
TODAY = datetime.date(2026, 11, 8)

LEDGER = """
2020-01-01 open Assets:Checking:Acme USD
2020-01-01 open Assets:Checking:Old-Bank USD
2020-01-01 open Assets:Saving:Acme USD
2020-01-01 open Assets:Investment:Broker:VTI VTI
2020-01-01 open Assets:Investment:Broker:USD USD
2020-01-01 open Liabilities:Credit:Card USD
2020-01-01 open Income:Salary USD
2020-01-01 open Income:Trading USD
2020-01-01 open Expenses:Taxes:Federal USD
2020-01-01 open Expenses:Food USD
2020-01-01 open Equity:Opening

2026-01-01 * "opening"
  Assets:Checking:Acme          1000 USD
  Assets:Saving:Acme           10000 USD
  Equity:Opening

2026-08-15 * "Payroll"
  Income:Salary                -5000 USD
  Expenses:Taxes:Federal        1000 USD
  Assets:Checking:Acme          4000 USD

2026-08-20 * "Groceries"
  Expenses:Food                  300 USD
  Liabilities:Credit:Card       -300 USD

2026-09-10 * "Buy VTI"
  Assets:Investment:Broker:VTI    10 VTI {200 USD}
  Assets:Checking:Acme         -2000 USD

2026-10-05 * "Sell VTI at a gain"
  Assets:Investment:Broker:VTI    -5 VTI {200 USD} @ 215 USD
  Assets:Checking:Acme           1075 USD
  Income:Trading                  -75 USD

2026-09-30 price VTI 210 USD
2026-10-31 price VTI 220 USD
"""


@pytest.fixture
def root(tmp_path):
    (tmp_path / "journal").mkdir()
    (tmp_path / "journal" / "journal.beancount").write_text("")
    (tmp_path / "config").mkdir()
    (tmp_path / "partner").mkdir()
    shutil.copy(FIXTURES / "runway.yaml", tmp_path / "config" / "runway.yaml")
    shutil.copy(FIXTURES / "partner.yaml", tmp_path / "partner" / "runway.yaml")
    return tmp_path


def build(root, months=3):
    entries, errors, options = loader.load_string(LEDGER)
    assert not errors
    return runway_history.build_history(
        ledger=SimpleNamespace(options=options),
        entries=entries,
        ledger_file_path=str(root / "journal" / "journal.beancount"),
        today=TODAY,
        months=months,
    )


def test_months_end_before_the_plan_starts(root):
    data = build(root)
    assert data["start"] == "2026-11"
    assert data["months"] == ["2026-08", "2026-09", "2026-10"]
    assert data["errors"] == []


def test_balances_flows_and_dated_prices(root):
    alex = next(p for p in build(root)["people"] if p["id"] == "alex")
    assert alex["available"] is True
    aug, sep, oct_ = alex["rows"]
    assert aug["sleeves"]["checking"] == 5000.0
    assert aug["sleeves"]["ef"] == 10000.0
    assert aug["cards"] == 300.0
    assert aug["netWorth"] == 14700.0
    # Paycheck: deposit into checking counts, withholding is not spending.
    assert aug["takeHome"] == 4000.0
    assert aug["spending"] == 300.0
    assert aug["net"] == 3700.0
    # VTI bought in September, priced at each month's end.
    assert sep["sleeves"]["core"] == 2100.0
    assert oct_["sleeves"]["core"] == 1100.0  # 5 left, at 220
    assert oct_["takeHome"] == 0.0  # the sale's gain is not pay
    assert sep["takeHome"] == 0.0 and sep["spending"] == 0.0
    assert alex["unmappedAccounts"] == []


def test_static_person_has_no_history(root):
    sam = next(p for p in build(root)["people"] if p["id"] == "sam")
    assert sam["available"] is False
    assert "typed into the runway file" in sam["reason"]
    assert sam["rows"] == []


def test_months_are_clamped(root):
    assert len(build(root, months=99)["months"]) == runway_history.MAX_MONTHS
