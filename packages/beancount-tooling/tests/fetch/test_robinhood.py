"""Robinhood fetcher: pure helpers only (no browser, no real site). All
records are synthetic, shaped like the History page's API responses."""

from datetime import date

import pytest

from beancount_tooling.fetch.banks import robinhood as rh
from beancount_tooling.fetch.config import parse_config

ACCT = "111"
ROTH = "222"
INST = {
    "ins-a": rh.Instrument("AAA", "Alpha Fund"),
    "ins-b": rh.Instrument("BBB", "Beta Corp"),
}


def order(**over):
    o = {
        "id": "ord-1",
        "account_number_rhs": ACCT,
        "instrument_id": "ins-a",
        "state": "filled",
        "side": "buy",
        "type": "market",
        "cumulative_quantity": "0.24016700",
        "average_price": "100.43000000",
        "fees": "0",
        "sec_fees": "0.00",
        "taf_fees": "0.00",
        "cat_fees": "0.00",
        "executed_notional": {"amount": "24.12", "currency_code": "USD"},
        "executions": [{"timestamp": "2026-09-03T14:08:06.279132Z"}],
        "last_transaction_at": "2026-09-03T14:08:06Z",
        "created_at": "2026-09-03T02:30:41Z",
    }
    o.update(over)
    return o


def test_buy_order_row():
    (row,) = rh.rows_from_orders([order()], ACCT, INST)
    assert row["Type"] == "buy"
    assert (row["Date"], row["Time"]) == ("2026-09-03", "10:08:06")  # New York
    assert row["Symbol"] == "AAA"
    assert row["Quantity"] == "0.240167"
    assert row["Price"] == "100.43"
    assert row["Amount"] == "-24.12"
    assert row["Description"] == "Alpha Fund market buy 0.240167 shares at $100.43"


def test_sell_order_row_nets_fees_and_rounds_half_up():
    o = order(
        side="sell",
        average_price="60.40500000",
        cumulative_quantity="2",
        executed_notional={"amount": "120.81"},
        taf_fees="0.01",
    )
    (row,) = rh.rows_from_orders([o], ACCT, INST)
    assert row["Type"] == "sell"
    assert row["Amount"] == "120.80"
    assert row["Fees"] == "0.01"
    assert row["Description"].endswith("2 shares at $60.41")


def test_orders_skip_unfilled_and_other_accounts():
    rows = rh.rows_from_orders(
        [
            order(id="x1", state="cancelled", cumulative_quantity="0"),
            order(id="x2", account_number_rhs=ROTH),
            order(id="x3", state="cancelled", cumulative_quantity="1"),
        ],
        ACCT,
        INST,
    )
    assert [r["Id"] for r in rows] == ["x3"]  # partly filled, then cancelled


def test_dividends_settled_only_with_early_label():
    divs = [
        {
            "id": "d1",
            "account_number_rhs": ACCT,
            "instrument": "https://api.example/instruments/ins-b/",
            "amount": "0.26",
            "withholding": "0.00",
            "position": "1.5",
            "rate": "0.21",
            "state": "paid",
            "paid_at": "2026-09-09T13:00:00Z",
            "payable_date": "2026-09-15",
            "is_early_dividend": True,
        },
        {"id": "d2", "account_number_rhs": ACCT, "state": "pending", "instrument": ""},
    ]
    (row,) = rh.rows_from_dividends(divs, ACCT, INST)
    assert row["Description"] == "Early Dividends from Beta Corp"
    assert (row["Date"], row["Amount"], row["Symbol"]) == ("2026-09-09", "0.26", "BBB")


def _transfer(**over):
    t = {
        "id": "t1",
        "state": "completed",
        "transfer_type": "originated_ach",
        "originating_account_id": ROTH,
        "originating_account_type": "rhs_roth_ira",
        "originating_transfer_account_info": {"account_name_inline": "Roth IRA"},
        "receiving_account_id": "rel-1",
        "receiving_account_type": "ach_relationship",
        "receiving_transfer_account_info": {"account_name_inline": "ACH"},
        "amount": "160.00",
        "net_amount": "160.00",
        "service_fee": "0.00",
        "completed_at": "2026-09-04T08:09:52-04:00",
        "details": {"direction": "deposit", "enoki_amount": {"amount": "4.8"}},
    }
    t.update(over)
    return t


def test_ira_contribution_from_bank():
    (row,) = rh.rows_from_transfers(
        [_transfer()], ROTH, {"rel-1": "Demo Bank - 0000"}, {"t1": "2026"}
    )
    assert row["Type"] == "transfer_in"
    assert row["Amount"] == "160.00"
    assert row["Match"] == "4.80"
    assert row["Counterparty"] == "Demo Bank - 0000"
    assert row["TaxYear"] == "2026"
    assert row["Description"] == "Contribution to Roth IRA from Demo Bank - 0000"


def test_cashback_and_internal_transfers():
    cashback = _transfer(
        id="t2",
        transfer_type="internal",
        originating_account_id="900",
        originating_account_type="rct_firm_account",
        originating_transfer_account_info={
            "account_name_inline": "Robinhood credit card"
        },
        receiving_account_id=ACCT,
        receiving_account_type="rhs_account",
        receiving_transfer_account_info={"account_name_inline": "individual"},
        amount="14.77",
        net_amount="14.77",
        details={"purpose": "cashback_redemption_cc"},
    )
    internal = _transfer(
        id="t3",
        transfer_type="internal",
        originating_account_id=ACCT,
        originating_account_type="rhs_account",
        originating_transfer_account_info={"account_name_inline": "individual"},
        receiving_account_id=ROTH,
        receiving_account_type="rhs_roth_ira",
        receiving_transfer_account_info={"account_name_inline": "Roth IRA"},
        amount="100.00",
        net_amount="100.00",
        details={"enoki_amount": {"amount": "3"}},
    )
    rows = rh.rows_from_transfers([cashback, internal], ACCT, {}, {})
    assert [(r["Type"], r["Amount"]) for r in rows] == [
        ("cc_rebate", "14.77"),
        ("transfer_out", "-100.00"),
    ]
    assert rows[0]["Description"] == "Transfer to individual from Robinhood credit card"
    assert rows[1]["Counterparty"] == ROTH
    (roth,) = rh.rows_from_transfers([internal], ROTH, {}, {})
    assert (roth["Type"], roth["Counterparty"], roth["Match"]) == (
        "transfer_in",
        ACCT,
        "3.00",
    )
    assert roth["Description"] == "Transfer to Roth IRA from individual"


def test_interest_lending_margin_boost():
    rows = (
        rh.rows_from_sweeps(
            [
                {
                    "id": "s1",
                    "account_number": ACCT,
                    "amount": {"amount": "0.44"},
                    "direction": "credit",
                    "reason": "interest_payment",
                    "pay_date": "2026-06-30T21:00:00Z",
                }
            ],
            ACCT,
        )
        + rh.rows_from_stock_loans(
            [
                {
                    "id": "l1",
                    "account_number": ACCT,
                    "amount": {"amount": "0.01"},
                    "instrument_id": "ins-a",
                    "symbol": "AAA",
                    "record_date": "2026-05-06",
                    "created_at": "2026-05-06T19:11:04Z",
                }
            ],
            ACCT,
            INST,
        )
        + rh.rows_from_margin_interest(
            [
                {
                    "id": "m1",
                    "account": "https://api.example/accounts/111/",
                    "amount": "0.14",
                    "credit": "0.00",
                    "created_at": "2026-02-19T04:26:29Z",
                }
            ],
            ACCT,
        )
        + rh.rows_from_deposit_boosts(
            [
                {
                    "id": "b1",
                    "account_number": ACCT,
                    "amount": "0.92",
                    "created_at": "2026-01-31T12:00:00-05:00",
                    "title": "Gold deposit boost payout",
                }
            ],
            ACCT,
        )
    )
    assert [(r["Type"], r["Date"], r["Amount"]) for r in rows] == [
        ("interest", "2026-06-30", "0.44"),
        ("stock_lending", "2026-05-06", "0.01"),
        ("margin_interest", "2026-02-18", "-0.14"),
        ("deposit_boost", "2026-01-31", "0.92"),
    ]
    assert rows[1]["Description"] == "Alpha Fund Stock Lending Payment"


def test_contribution_tax_year():
    detail = {
        "rows": [
            {"label": "Contribution type", "value": "New"},
            {"label": "Tax year", "value": "2025"},
        ]
    }
    assert rh.contribution_tax_year(detail) == "2025"
    assert rh.contribution_tax_year({}) == ""


def test_merge_keeps_existing_and_appends_new():
    (old,) = rh.rows_from_orders([order()], ACCT, INST)
    old_text = rh.write_rows([old])
    existing = rh.read_rows(old_text)
    refetched = dict(old, Detail='{"changed":true}')  # detail drift is fine
    (new,) = rh.rows_from_orders(
        [order(id="ord-2", executions=[{"timestamp": "2026-09-01T15:00:00Z"}])],
        ACCT,
        INST,
    )
    merged, added = rh.merge_rows(existing, [refetched, new])
    assert added == 1
    assert [r["Id"] for r in merged] == ["ord-2", "ord-1"]  # sorted by date
    assert merged[1] == existing[0]  # stored row untouched


def test_merge_refuses_amended_rows():
    (old,) = rh.rows_from_orders([order()], ACCT, INST)
    with pytest.raises(rh.AmendedRows, match="Date '2026-09-03' -> '2026-09-04'"):
        rh.merge_rows([old], [dict(old, Date="2026-09-04")])


def test_csv_round_trip_and_columns():
    rows = rh.rows_from_orders([order()], ACCT, INST)
    text = rh.write_rows(rows)
    assert text.splitlines()[0] == ",".join(rh.COLUMNS)
    assert rh.read_rows(text) == rows
    assert rh.read_rows("") == []


def test_ny_datetime():
    assert rh.ny_datetime("2026-10-01T02:30:41Z").date() == date(2026, 9, 30)


def test_investment_account_config():
    raw = {
        "fetch": {
            "profile_dir": "/tmp/profile",
            "banks": {
                "robinhood": {
                    "credentials": {"source": "dashlane", "id": "demo"},
                    "accounts": [
                        {
                            "path": "investment/Demo",
                            "account_number": "111",
                            "history_start": date(2026, 1, 1),
                            "rolling": "Brokerage.csv",
                        },
                        {
                            "path": "investment/Demo",
                            "account_number": "222",
                            "rolling": "Roth-IRA.csv",
                        },
                    ],
                }
            },
        }
    }
    extract = {
        "accounts": [
            {
                "path": "investment/Demo",
                "bank": "Demo",
                "importer": "RobinhoodInvestmentImporter",
            }
        ]
    }
    config = parse_config(raw, extract)
    first, second = config.banks["robinhood"].accounts
    assert (first.kind, first.account_number, first.history_start) == (
        "investment",
        "111",
        date(2026, 1, 1),
    )
    assert second.history_start is None
