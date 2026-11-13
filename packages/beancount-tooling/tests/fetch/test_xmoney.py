"""X Money fetcher and importer: pure helpers only (no browser, no real site)."""

from decimal import Decimal

import pytest

from beancount_tooling.fetch.banks import xmoney
from beancount_tooling.fetch.banks.base import get_fetcher
from beancount_tooling.importer.x_money import XMoneyImporter

# --- a minimal protobuf encoder, to build synthetic responses -----------------


def varint(value: int) -> bytes:
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        out.append(byte | (0x80 if value else 0))
        if not value:
            return bytes(out)


def field(number: int, value) -> bytes:
    if isinstance(value, int):
        return varint(number << 3) + varint(value)
    if isinstance(value, str):
        value = value.encode()
    return varint(number << 3 | 2) + varint(len(value)) + value


def money(micros: int) -> bytes:
    return field(1, micros) if micros else b""


def detail_row(name: str, text: str = "", micros: int | None = None) -> bytes:
    body = field(1, name)
    if micros is not None:
        body += field(3, money(micros))
    else:
        body += field(2, text)
    return field(8, body)


def transaction(
    txn_id: str,
    seconds: int,
    micros: int,
    direction: int,
    *,
    title: str = "Demo Bank",
    label: str = "Transfer",
    kind: str = "External Deposit",
    status: str = "Completed",
    code: str = "",
    category: str = "",
    description: str = "",
    balance: int = 0,
) -> bytes:
    display = field(6, title) + field(7, label)
    display += detail_row("Status", status)
    if category:
        display += detail_row("Category", category)
    display += detail_row("Available Balance", micros=balance)
    if description:
        display += detail_row("Statement Description", description)
    display += field(29, kind) + field(30, status) + field(31, "Bank Transfer (ACH)")
    body = field(1, txn_id) + field(4, money(micros)) + field(5, direction)
    body += field(6, field(1, seconds) + field(2, 5000))
    if code:
        body += field(9, code)
    return body + field(34, display)


def search_response(*transactions: bytes) -> bytes:
    message = b"".join(field(1, t) for t in transactions) + field(2, b"")
    trailer = b"grpc-status:0\r\n"
    return (
        b"\x00"
        + len(message).to_bytes(4, "big")
        + message
        + b"\x80"
        + len(trailer).to_bytes(4, "big")
        + trailer
    )


# 2026-03-02 04:30:00 UTC is 2026-03-01 23:30:00 in New York.
LATE_EVENING = 1772425800
DEPOSIT = transaction(
    "TxnDeposit1",
    LATE_EVENING,
    250_000_000,
    2,
    title="DEMO EMPLOYER",
    label="Early ACH",
    code="PAYROLL",
    description="DEMO EMPLOYER PAYROLL ACH PPD ID: 0000000000",
    balance=1_255_000_000,
)
PAYMENT = transaction(
    "TxnPayment1",
    LATE_EVENING - 86_400,
    45_000_000,
    3,
    title="Demo Shop",
    label="Shopping",
    kind="Payment",
    category="Shopping",
    description="DEMO SHOP 123",
    balance=1_005_000_000,
)
INTEREST = transaction(
    "TxnInterest1",
    LATE_EVENING - 2 * 86_400,
    1_050_000_000,
    1,
    title="Interest Payout",
    label="Mar 2026",
    kind="Interest Payout",
    balance=1_050_000_000,
)


def test_registered():
    assert get_fetcher("xmoney") is xmoney.XMoneyFetcher


def test_rows_from_search_response_decodes_and_signs():
    rows = xmoney.rows_from_search_response(search_response(DEPOSIT, PAYMENT, INTEREST))
    deposit, payment, interest = rows
    assert deposit == {
        "Id": "TxnDeposit1",
        "Date": "2026-03-01",  # New York, not UTC
        "Time": "23:30:00",
        "Amount": "250.00",
        "Balance": "1255.00",
        "Type": "External Deposit",
        "Status": "Completed",
        "Mode": "Bank Transfer (ACH)",
        "Counterparty": "DEMO EMPLOYER",
        "Label": "Early ACH",
        "Category": "",
        "Code": "PAYROLL",
        "Description": "DEMO EMPLOYER PAYROLL ACH PPD ID: 0000000000",
    }
    assert payment["Amount"] == "-45.00"
    assert payment["Category"] == "Shopping"
    assert interest["Amount"] == "1050.00"
    assert interest["Description"] == ""


def test_zero_amount_and_empty_response():
    prenote = transaction("TxnZero1", LATE_EVENING, 0, 3, code="VERIFY")
    assert xmoney.rows_from_search_response(search_response(prenote))[0]["Amount"] in (
        "0.00",
        "-0.00",
    )
    assert xmoney.rows_from_search_response(search_response()) == []


def test_unknown_direction_stops_the_fetch():
    odd = transaction("TxnOdd1", LATE_EVENING, 1_000_000, 7)
    with pytest.raises(xmoney.XMoneyStepError, match="DIRECTION_SIGN"):
        xmoney.rows_from_search_response(search_response(odd))


def test_truncated_body_is_a_step_error():
    body = search_response(DEPOSIT)
    with pytest.raises(xmoney.XMoneyStepError, match="decode"):
        xmoney.rows_from_search_response(body[:40])


def test_merge_keeps_existing_adds_completed_and_flags_amended():
    fetched = xmoney.rows_from_search_response(search_response(DEPOSIT, PAYMENT))
    existing = [dict(fetched[1], Label="as first saved")]
    pending = dict(fetched[0], Id="TxnPending1", Status="Pending")
    merged, added = xmoney.merge_rows(existing, [*fetched, pending])
    assert added == 1
    assert [r["Id"] for r in merged] == ["TxnPayment1", "TxnDeposit1"]
    assert merged[0]["Label"] == "as first saved"

    amended = [dict(fetched[1], Amount="-46.00")]
    with pytest.raises(xmoney.AmendedRows, match="Amount changed"):
        xmoney.merge_rows(existing, amended)


def test_csv_round_trip():
    rows = xmoney.rows_from_search_response(search_response(DEPOSIT, PAYMENT))
    text = xmoney.write_rows(rows)
    assert text.splitlines()[0] == ",".join(xmoney.COLUMNS)
    assert xmoney.read_rows(text) == rows
    assert xmoney.read_rows("") == []


def test_check_total():
    rows = xmoney.rows_from_search_response(search_response(DEPOSIT, PAYMENT, INTEREST))
    xmoney.check_total(rows, rows, Decimal("1255.00"))
    xmoney.check_total(rows, rows, None)
    with pytest.raises(xmoney.XMoneyStepError, match="add up to 1,255.00"):
        xmoney.check_total(rows, rows, Decimal("1300.00"))
    # A row that is not completed yet makes the site balance incomparable.
    pending = dict(rows[0], Id="TxnPending1", Status="Pending")
    xmoney.check_total(rows, [*rows, pending], Decimal("1300.00"))


def test_parse_balance():
    assert xmoney.parse_balance("$1,255.00") == Decimal("1255.00")
    assert xmoney.parse_balance(" $0.07 ") == Decimal("0.07")
    assert xmoney.parse_balance("$1,255.00\n$\n1,255\n1\n2\n00") == Decimal("1255.00")
    assert xmoney.parse_balance("6.00% APY") is None
    assert xmoney.parse_balance("") is None


def test_importer_routes_and_skips(tmp_path):
    rows = xmoney.rows_from_search_response(search_response(DEPOSIT, PAYMENT, INTEREST))
    rows.append(
        dict(rows[0], Id="TxnMove1", Amount="-100.00", Category="Transfer", Code="")
    )
    rows.append(
        dict(rows[0], Id="TxnVerify1", Amount="0.12", Category="", Code="ACCTVERIFY")
    )
    rows.append(dict(rows[0], Id="TxnZero1", Amount="0.00"))
    rows.append(dict(rows[0], Id="TxnPending1", Status="Pending"))
    d = tmp_path / "checking" / "Demo-X"
    d.mkdir(parents=True)
    f = d / "activity.csv"
    f.write_text(xmoney.write_rows(rows), newline="")

    imp = XMoneyImporter("Demo-X")
    assert imp.identify(str(f))
    assert not XMoneyImporter("Demo-X", type="saving").identify(str(f))
    entries = imp.extract(str(f), [])
    by_id = {
        row["Id"]: next(
            e
            for e in entries
            if e.postings[0].meta["ref"] == imp.get_trans_ref(row, "")
        )
        for row in rows
        if row["Id"] not in ("TxnZero1", "TxnPending1")
    }
    assert len(entries) == len(by_id) == 5

    deposit = by_id["TxnDeposit1"]
    assert deposit.date.isoformat() == "2026-03-01"
    assert deposit.postings[0].account == "Assets:Checking:Demo-X"
    assert deposit.postings[0].units.number == Decimal("250.00")
    assert deposit.postings[1].account == "Equity:FIXME"
    assert by_id["TxnPayment1"].postings[0].units.number == Decimal("-45.00")
    assert by_id["TxnPayment1"].postings[1].account == "Equity:FIXME"
    interest = by_id["TxnInterest1"]
    assert interest.payee == "X Money"
    assert interest.postings[1].account == "Income:Interest:Demo-X"
    assert by_id["TxnMove1"].postings[1].account == "Assets:Pending-Transfer"
    assert by_id["TxnMove1"].payee == "DEMO EMPLOYER"
    assert by_id["TxnVerify1"].postings[1].account == "Assets:Pending-Transfer"

    # A second run with the first run's refs books nothing.
    refs = [e.postings[0].meta["ref"] for e in entries]
    assert XMoneyImporter("Demo-X", existing_refs=refs).extract(str(f), []) == []
