"""normalize-payees: header-only rewrite of historical payees (synthetic ledger)."""

from pathlib import Path

import pytest
from beancount import loader
from beancount.core import data
from beancount_tooling import merchants
from beancount_tooling import normalize_payees as np

FIXTURE = Path(__file__).parent / "fixtures" / "merchants.yaml"

SCOPE = """
scope:
  accounts: ["Expenses", "Assets:Receivable:Employer"]
  gift_cards: ["Assets:Gift-Card"]
  exclude_files: ["**/transit-card.bean"]
"""

ACCOUNTS = """\
2020-01-01 open Assets:Checking:Demo
2020-01-01 open Liabilities:Credit:Demo
2020-01-01 open Assets:Receivable:Employer:Expenses
2020-01-01 open Assets:Gift-Card:Demo
2020-01-01 open Expenses:Groceries
2020-01-01 open Expenses:Restaurants
2020-01-01 open Expenses:Transport
2020-01-01 open Expenses:Rent
2020-01-01 open Income:Rebate
2020-01-01 open Income:Salary
"""

CARD = """\
2026-03-01 ! "Demo Landlord" "2026-03 Rent"
  Expenses:Rent                                 100.00 USD
    tid: "rent:2026-03"
  Assets:Checking:Demo

2026-03-02 * "Demo Mart 0042 Springfield" "" #trip ^receipt-1
  Liabilities:Credit:Demo                       -11.53 USD
    ref: "100"
  Expenses:Groceries

2026-03-03 * "Costco Gas #1214 Springfield" "Fill-up before the trip"
  Liabilities:Credit:Demo                       -40.00 USD
    ref: "101"
  Expenses:Transport

2026-03-04 * "Zelle Payment to A Friend" ""
  Assets:Checking:Demo                          -20.00 USD
  Expenses:Restaurants

2026-03-05 * "Demo Mart #12" ""
  Liabilities:Credit:Demo                         5.00 USD
    ref: "102"
  Income:Rebate

2026-03-06 * "Apple" ""
  Liabilities:Credit:Demo                        -9.99 USD
  Expenses:Groceries

2026-03-07 * "Some Unknown Shop" ""
  Liabilities:Credit:Demo                        -3.00 USD
  Expenses:Groceries

2026-03-08 * "Only a narration"
  Liabilities:Credit:Demo                        -1.00 USD
  Expenses:Groceries

2026-03-09 * "Costco" "Springfield"
  Liabilities:Credit:Demo                       -50.00 USD
  Expenses:Groceries

2026-03-10 * "Uber   *eats Pending" ""
  Liabilities:Credit:Demo                       -25.00 USD
  Assets:Receivable:Employer:Expenses

2026-03-11 * "Demo Auto Inc Supercharger" ""
  Liabilities:Credit:Demo                       -14.20 USD
  Assets:Gift-Card:Demo

2026-04-01 * "Dd *Doordash Pizza \\"Place\\"" ""
  pending: "card"
  Liabilities:Credit:Demo                       -18.00 USD
    ref: "103"
  Expenses:Restaurants
"""

TRANSIT_CARD = """\
2026-03-12 * "Uber   *eats Pending" ""
  Liabilities:Credit:Demo                        -2.00 USD
  Expenses:Transport
"""


@pytest.fixture
def config(tmp_path):
    path = tmp_path / "merchants.yaml"
    path.write_text(FIXTURE.read_text(encoding="utf-8") + SCOPE, encoding="utf-8")
    return path


@pytest.fixture
def ledger(tmp_path):
    root = tmp_path / "ledger"
    journal = root / "journal"
    (journal / "tx").mkdir(parents=True)
    (journal / "journal.beancount").write_text(
        'include "accounts.bean"\ninclude "tx/*.bean"\n'
        'option "operating_currency" "USD"\n',
        encoding="utf-8",
    )
    (journal / "accounts.bean").write_text(ACCOUNTS, encoding="utf-8")
    (journal / "tx" / "card.bean").write_text(CARD, encoding="utf-8")
    (journal / "tx" / "transit-card.bean").write_text(TRANSIT_CARD, encoding="utf-8")
    return journal


def run(ledger, config, *args):
    return np.main(
        ["--journal", str(ledger / "journal.beancount"), "--config", str(config), *args]
    )


def load(ledger):
    entries, errors, _ = loader.load_file(str(ledger / "journal.beancount"))
    assert errors == []
    return [e for e in entries if isinstance(e, data.Transaction)]


def by_date(entries):
    return {e.date.isoformat(): e for e in entries}


def test_rewrites_headers_and_adds_desc(ledger, config):
    assert run(ledger, config) == 0
    tx = by_date(load(ledger))

    alias = tx["2026-03-02"]
    assert (alias.payee, alias.narration) == ("Demo Mart", "Springfield")
    assert alias.meta["raw"] == "Demo Mart 0042 Springfield"
    assert alias.tags == {"trip"} and alias.links == {"receipt-1"}

    rule = tx["2026-03-03"]
    assert rule.payee == "Costco Gas"
    assert rule.narration == "Fill-up before the trip"  # non-empty narration kept
    assert rule.meta["raw"] == "Costco Gas #1214 Springfield"

    receivable = tx["2026-03-10"]
    assert receivable.payee == "Uber Eats"

    gift_card = tx["2026-03-11"]
    assert gift_card.payee == "Demo Auto Supercharger"

    quoted = tx["2026-04-01"]
    assert quoted.payee == "DoorDash"
    assert quoted.narration == 'Pizza "Place"'
    assert quoted.meta["raw"] == 'Dd *Doordash Pizza "Place"'
    assert quoted.meta["pending"] == "card"


def test_text_edits_are_header_and_desc_only(ledger, config):
    before = (ledger / "tx" / "card.bean").read_text(encoding="utf-8")
    run(ledger, config)
    after = (ledger / "tx" / "card.bean").read_text(encoding="utf-8")

    old, new = before.splitlines(), after.splitlines()
    removed = [line for line in old if line not in new]
    added = [line for line in new if line not in old]
    assert all(line[:10].count("-") == 2 for line in removed)  # headers only
    assert len([line for line in added if line.startswith("  raw: ")]) == 5
    assert len(added) == len(removed) + 5
    assert '2026-03-02 * "Demo Mart" "Springfield" #trip ^receipt-1' in new
    assert new[
        new.index('2026-03-02 * "Demo Mart" "Springfield" #trip ^receipt-1') + 1
    ] == ('  raw: "Demo Mart 0042 Springfield"')
    for marker in (
        'tid: "rent:2026-03"',
        'ref: "100"',
        'ref: "103"',
        'pending: "card"',
    ):
        assert before.count(marker) == after.count(marker) == 1


def test_postings_and_balances_unchanged(ledger, config):
    def postings(entries):
        return sorted(
            (e.date, p.account, p.units, e.flag) for e in entries for p in e.postings
        )

    before = postings(load(ledger))
    run(ledger, config)
    assert postings(load(ledger)) == before


def test_skips(ledger, config):
    run(ledger, config)
    tx = by_date(load(ledger))
    assert tx["2026-03-01"].payee == "Demo Landlord"  # forecast (tid:)
    assert tx["2026-03-04"].payee == "Zelle Payment to A Friend"  # guard
    assert tx["2026-03-05"].payee == "Demo Mart #12"  # out of scope (rebate)
    assert tx["2026-03-06"].payee == "Apple"  # ambiguous
    assert tx["2026-03-07"].payee == "Some Unknown Shop"  # unmapped
    assert tx["2026-03-08"].payee is None  # narration only
    assert tx["2026-03-09"].meta.get("raw") is None  # already canonical
    assert tx["2026-03-12"].payee == "Uber   *eats Pending"  # transit-card.bean
    changed = {"2026-03-02", "2026-03-03", "2026-03-10", "2026-03-11", "2026-04-01"}
    for day, entry in tx.items():
        assert ("raw" in entry.meta) == (day in changed)


def test_summary_counts(ledger, config, capsys):
    entries, _, _ = loader.load_file(str(ledger / "journal.beancount"))
    cfg = merchants.load_config(config)
    plan = np.plan_changes(entries, cfg, journal_dir=ledger)
    result = np.execute(plan, root=ledger.parent, write=False)
    summary = np.summarize(plan, result)
    assert summary["headers_changed"] == 5
    assert summary["desc_added"] == 5
    assert summary["per_scope"] == {
        "Expenses": 3,
        "Assets:Receivable:Employer": 1,
        "gift-card": 1,
    }
    assert summary["skipped"] == {
        "excluded-file": 1,
        "forecast": 1,
        "no-payee": 1,
        "out-of-scope": 1,
        "non-merchant": 1,
        "ambiguous": 1,
        "unmapped": 1,
        "already-canonical": 1,
    }
    assert summary["unresolved"]["ambiguous"] == {"Apple": 1}
    assert summary["unresolved"]["unmapped"] == {"Some Unknown Shop": 1}


def test_dry_run_writes_nothing(ledger, config, capsys):
    before = (ledger / "tx" / "card.bean").read_text(encoding="utf-8")
    assert run(ledger, config, "--dry-run") == 0
    assert (ledger / "tx" / "card.bean").read_text(encoding="utf-8") == before
    out = capsys.readouterr()
    assert out.out.startswith(
        "--- a/journal/tx/card.bean\n+++ b/journal/tx/card.bean\n"
    )
    assert '+2026-03-02 * "Demo Mart" "Springfield" #trip ^receipt-1' in out.out
    assert "would change 5 headers" in out.err
    removed = [
        line
        for line in out.out.splitlines()
        if line.startswith("-") and not line.startswith("---")
    ]
    assert len(removed) == 5 and all(line.startswith("-2026-") for line in removed)


def test_idempotent(ledger, config, capsys):
    run(ledger, config)
    once = (ledger / "tx" / "card.bean").read_text(encoding="utf-8")
    capsys.readouterr()
    assert run(ledger, config, "--dry-run") == 0
    assert capsys.readouterr().out == ""
    run(ledger, config)
    assert (ledger / "tx" / "card.bean").read_text(encoding="utf-8") == once


def test_existing_desc_is_kept(tmp_path, config):
    text = (
        '2026-03-02 * "Demo Mart #12" ""\n'
        '  raw: "DEMO MART #12 SPRINGFIELD IL"\n'
        "  Liabilities:Credit:Demo  -1.00 USD\n"
        "  Expenses:Groceries\n"
    )
    ledger = tmp_path / "j"
    ledger.mkdir()
    (ledger / "journal.beancount").write_text(
        'include "accounts.bean"\ninclude "a.bean"\n', encoding="utf-8"
    )
    (ledger / "accounts.bean").write_text(ACCOUNTS, encoding="utf-8")
    (ledger / "a.bean").write_text(text, encoding="utf-8")
    run(ledger, config)
    after = (ledger / "a.bean").read_text(encoding="utf-8")
    # The raw descriptor in raw: feeds the empty narration, as on import.
    assert after.splitlines()[0] == '2026-03-02 * "Demo Mart" "Springfield"'
    assert after.count("raw:") == 1


def test_month_and_file_filters(ledger, config):
    run(ledger, config, "--month", "2026-04")
    tx = by_date(load(ledger))
    assert tx["2026-04-01"].payee == "DoorDash"
    assert tx["2026-03-02"].payee == "Demo Mart 0042 Springfield"

    run(ledger, config, "--file", str(ledger / "tx" / "transit-card.bean"))
    assert by_date(load(ledger))["2026-03-02"].payee == "Demo Mart 0042 Springfield"

    run(ledger, config, "--file", str(ledger / "tx" / "card.bean"))
    assert by_date(load(ledger))["2026-03-02"].payee == "Demo Mart"


def test_header_mismatch_is_not_written(ledger, config):
    entries, _, _ = loader.load_file(str(ledger / "journal.beancount"))
    plan = np.plan_changes(entries, merchants.load_config(config), journal_dir=ledger)
    path = ledger / "tx" / "card.bean"
    path.write_text("\n" + path.read_text(encoding="utf-8"), encoding="utf-8")
    result = np.execute(plan, root=ledger.parent, write=True)
    assert result.applied == [] and len(result.failed) == 5
    assert "Demo Mart 0042 Springfield" in path.read_text(encoding="utf-8")


def test_crlf_preserved(tmp_path):
    change = np.Change(
        path=tmp_path / "x.bean",
        lineno=1,
        date="2026-03-02",
        old_payee="Demo Mart #12",
        new_payee="Demo Mart",
        old_narration="",
        new_narration="",
        add_desc=True,
        source="alias",
        scope="Expenses",
    )
    text = '2026-03-02 * "Demo Mart #12" ""\r\n  Expenses:Groceries  1 USD\r\n'
    out, failed = np.apply_to_text(text, [change])
    assert failed == []
    assert out == (
        '2026-03-02 * "Demo Mart" ""\r\n'
        '  raw: "Demo Mart #12"\r\n'
        "  Expenses:Groceries  1 USD\r\n"
    )


def test_scope_defaults_and_validation():
    assert merchants.parse_config({"merchants": {"A": {}}}).scope_accounts == (
        "Expenses",
    )
    with pytest.raises(merchants.MerchantConfigError, match="unknown key"):
        merchants.parse_config({"merchants": {}, "scope": {"acounts": ["Expenses"]}})
