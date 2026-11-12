"""The endpoints through Fava's Flask app: wiring, JSON shapes, HTTP 400s."""

import json

import pytest
from conftest import BANK, BASE_LEDGER, CARD, statement_mode, stmt_line

EXT = '\n2030-01-01 custom "fava-extension" "ledger_data_api"\n'
# The endpoints use the real date, so the statement must still be current:
# closed long ago with a far due date keeps it active whenever this runs.
FAR_DUE = "2999-01-15"


@pytest.fixture
def client(h):
    from fava.application import create_app

    h.write_ledger(BASE_LEDGER + EXT)
    statement_mode(h, stmt_line("2030-05-20", due=FAR_DUE))
    app = create_app([h.path])
    app.testing = True
    slug = next(iter(app.config["LEDGERS"].ledgers_by_slug))
    with app.test_client() as c:
        yield _Client(c, slug)


class _Client:
    def __init__(self, c, slug):
        self.c = c
        self.base = f"/{slug}/extension/LedgerDataApi/"

    def get(self, name, **query):
        r = self.c.get(self.base + name, query_string=query)
        return r.status_code, json.loads(r.data)

    def post(self, name, body):
        r = self.c.post(self.base + name, json=body)
        return r.status_code, json.loads(r.data)


def _card(cards):
    return next(c for c in cards if c["accountPath"] == CARD)


def test_plan_grid_and_cc_cards_carry_statement_fields(client):
    status, grid = client.get("plan_grid")
    assert status == 200
    c = _card(grid["ccCards"])
    assert c["hasStatements"] is True
    assert c["activeStatement"]["id"] == "2030-05-20"
    assert c["statementBalance"] == "1000.00"
    # 1000.00 before the 2030-05-28 payment is in the past, 700.00 after it.
    assert c["lockedSource"] == "balance"
    assert c["lockedAmount"] in ("1000.00", "700.00")

    status, cards = client.get("cc_cards")
    assert status == 200
    c = _card(cards)
    assert c["hasStatements"] is True and c["hasMonthlyInputs"] is True
    assert c["activeStatement"]["effectiveDueDate"] == FAR_DUE
    assert [s["id"] for s in c["statements"]] == ["2030-05-20"]
    assert c["lastClosedDate"] == "2030-05-20"
    assert c["lockedAmount"] is None and c["overrideTotal"] is None
    dormant = next(x for x in cards if x["accountPath"].endswith("Dormant"))
    assert dormant["hasStatements"] is False and dormant["statements"] == []


def test_cc_statements_endpoint(client):
    assert client.get("cc_statements")[0] == 400
    status, body = client.get("cc_statements", account=CARD)
    assert status == 200
    assert body["account"] == CARD and body["hasStatements"] is True
    assert body["statements"][0]["kind"] == "closed"
    assert body["expectedStatement"] is None


def test_expected_and_override_round_trip(client, h):
    status, body = client.post("cc_expected_save", {"accountPath": CARD})
    assert status == 200
    expected_id = body["expected"]["id"]
    assert body["expected"]["kind"] == "expected"
    assert body["expected"]["afterId"] == "2030-05-20"

    status, body = client.post(
        "cc_expected_save", {"accountPath": CARD, "id": "2030-01-01"}
    )
    assert status == 400 and body["status"] == "error" and body["message"]
    status, body = client.post(
        "cc_expected_save", {"accountPath": "Liabilities:Credit:Dormant"}
    )
    assert (status, body["message"]) == (400, "card has no statement records yet")

    plans = [{"date": "2030-06-14", "account": BANK, "amount": "-650.00"}]
    status, body = client.post(
        "cc_override_save",
        {"cardAccountPath": CARD, "statementId": "2030-05-21", "plans": plans},
    )
    assert status == 400
    assert body == {
        "status": "error",
        "message": f"unknown statement 2030-05-21 for {CARD}",
    }
    assert not h.plans_file.exists()
    status, body = client.post(
        "cc_override_save",
        {"cardAccountPath": CARD, "cycleMonth": "2030-06", "plans": plans},
    )
    assert status == 400
    assert (
        client.post("cc_override_save", {"cardAccountPath": CARD, "plans": plans})[0]
        == 400
    )

    for sid in ("2030-05-20", expected_id):
        status, body = client.post(
            "cc_override_save",
            {"cardAccountPath": CARD, "statementId": sid, "plans": plans},
        )
        assert status == 200
        (plan,) = body["plans"]
        assert (plan["ccStatementId"], plan["ccCycleMonth"]) == (sid, None)
    plan_id = plan["id"]

    status, body = client.post("cc_expected_delete", {"accountPath": CARD})
    assert status == 400
    assert body["message"] == "expected statement has override plans; reset them first"

    # plan_save without tag keys keeps them.
    status, body = client.post(
        "plan_save",
        {"id": plan_id, "date": "2030-06-13", "account": BANK, "amount": "-600.00"},
    )
    assert (status, body) == (200, {"id": plan_id})
    status, grid = client.get("plan_grid", start="2030-06-01", end="2030-06-30")
    row = next(r for r in grid["rows"] if r["date"] == "2030-06-13")
    (entry,) = [e for e in row["entries"][BANK] if e["id"] == plan_id]
    assert (entry["ccStatementId"], entry["ccStatementKind"]) == (
        expected_id,
        "expected",
    )

    status, _ = client.post(
        "cc_override_save",
        {"cardAccountPath": CARD, "statementId": expected_id, "plans": []},
    )
    assert status == 200
    assert client.post("cc_expected_delete", {"accountPath": CARD}) == (200, {})


def test_cc_card_save_ignores_typed_balance_in_statement_mode(client, h):
    status, body = client.post(
        "cc_card_save",
        {"accountPath": CARD, "fundingAccount": BANK, "statementBalance": "5.00"},
    )
    assert (status, body) == (200, {})
    saved = json.loads((h.plan_dir / "cc-cards.json").read_text())[CARD]
    assert "statementBalance" not in saved and saved["fundingAccount"] == BANK
    # Missing accountPath keeps the old 200 + error body.
    status, body = client.post("cc_card_save", {})
    assert status == 200 and body["status"] == "error"
