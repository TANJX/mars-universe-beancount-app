"""Card statement facts end to end on the fetch side, in a synthetic ledger:
cc-cards.json hint -> terminal prompt -> billing JSONL -> the extractor walk
skips it. Invented names and amounts only.

`FETCH_LINE` / `MANUAL_LINE` are the exact bytes the writer produces. The
ledger-data-api suite (tests/test_statement_lifecycle.py) reads the same two
literals through its own copy of the reader, which pins the on-disk format
across the two packages that must not import each other.
"""

import datetime
import json
import os

from beancount_tooling import billing
from beancount_tooling.fetch import statements as fetch_statements
from beangulp.utils import walk

CARD = "Liabilities:Credit:DemoCard"

MANUAL_LINE = (
    '{"account": "Liabilities:Credit:DemoCard", "id": "2030-05-20", '
    '"statementBalance": "1000.00", "dueDate": "2030-06-15", '
    '"minimumPayment": "35.00", "source": "manual", '
    '"capturedAt": "2030-05-22T12:00:00+00:00"}\n'
)
FETCH_LINE = (
    '{"account": "Liabilities:Credit:DemoCard", "id": "2030-06-18", '
    '"statementBalance": "210.00", "dueDate": "2030-07-13", '
    '"minimumPayment": null, "source": "fetch", '
    '"capturedAt": "2030-06-19T12:00:00+00:00"}\n'
)


def _ledger(tmp_path):
    plan = tmp_path / "journal" / "plan"
    plan.mkdir(parents=True)
    cc_cards = plan / "cc-cards.json"
    cc_cards.write_text(
        json.dumps(
            {
                CARD: {
                    "fundingAccount": "Assets:Checking:Acme",
                    "statementCloseDay": 20,
                    "paymentDueDay": 15,
                }
            }
        )
    )
    return cc_cards, tmp_path / "statements"


def test_prompt_to_billing_file_to_extractor_skip(tmp_path):
    from beancount_tooling import extract

    cc_cards, statements_dir = _ledger(tmp_path)
    before = cc_cards.read_bytes()
    today = datetime.date(2030, 5, 22)

    hints = fetch_statements.load_card_hints(tmp_path)
    candidates = fetch_statements.manual_candidates(hints, statements_dir, today)
    assert [(c.card, c.expected_close.isoformat()) for c in candidates] == [
        ("DemoCard", "2030-05-20")
    ]

    # Enter keeps the predicted closing date; balance typed with currency
    # formatting; Enter keeps the predicted due date; then a minimum payment.
    answers = iter(["", "$1,000.00", "", "35"])
    lines = fetch_statements.run_manual_prompts(
        candidates,
        statements_dir,
        today,
        ask=lambda _prompt: next(answers),
        out=lambda _line: None,
    )
    assert lines == ["DemoCard: statement 2030-05-20 recorded"]

    card_file = statements_dir / "billing" / "credit" / "DemoCard.jsonl"
    (raw,) = card_file.read_text().splitlines()
    written = json.loads(raw)
    expected = json.loads(MANUAL_LINE)
    assert list(written) == list(expected)  # A1 key order
    assert {**written, "capturedAt": ""} == {**expected, "capturedAt": ""}

    # The hint file is read-only input, and the card is no longer asked about.
    assert cc_cards.read_bytes() == before
    assert fetch_statements.manual_candidates(hints, statements_dir, today) == []

    # The extractor walks all of statements/: billing and pending are skipped,
    # a real export beside them is not.
    export = statements_dir / "credit" / "DemoCard" / "current_1111.csv"
    snapshot = statements_dir / "pending" / "credit" / "DemoCard.csv"
    for path in (export, snapshot):
        path.parent.mkdir(parents=True)
        path.write_text("Date,Amount\n")
    skipped = extract.skipped_roots(str(statements_dir))
    walked = list(walk([os.path.realpath(statements_dir)]))
    assert os.path.realpath(card_file) in walked  # the walk does reach it
    assert [f for f in walked if not f.startswith(skipped)] == [
        os.path.realpath(export)
    ]


def test_writer_bytes_match_the_format_shared_with_the_api_reader(tmp_path):
    billing.record_statement(
        tmp_path,
        CARD,
        billing.parse_info("2030-05-20", "$1,000.00", "2030-06-15", "35"),
        source="manual",
        today=datetime.date(2030, 5, 22),
        captured_at="2030-05-22T12:00:00+00:00",
    )
    billing.record_statement(
        tmp_path,
        CARD,
        billing.parse_info("6/18/2030", "210", "2030-07-13"),
        source="fetch",
        today=datetime.date(2030, 6, 19),
        captured_at="2030-06-19T12:00:00+00:00",
    )
    assert billing.card_file(tmp_path, CARD).read_text() == MANUAL_LINE + FETCH_LINE
    assert [s.id for s in billing.read_statements(tmp_path, CARD)] == [
        "2030-05-20",
        "2030-06-18",
    ]
