"""Card statements in `just fetch`: the read_statement hook in the runner,
the terminal prompt, the CLI flags, and the extract skip.

Fake fetchers and injected input only: no browser, no bank, no real ledger.
"""

import json
import os
from datetime import date
from decimal import Decimal

import pytest

from beancount_tooling import billing
from beancount_tooling.billing import StatementInfo
from beancount_tooling.fetch import browser, cli, runner, statements
from beancount_tooling.fetch.banks.base import REGISTRY, Fetcher, get_fetcher
from beancount_tooling.fetch.config import load_config

TODAY = date(2030, 6, 18)
CARD = "Liabilities:Credit:DemoCard"
INFO = StatementInfo(
    date(2030, 5, 20), Decimal("1234.56"), date(2030, 6, 15), Decimal("40.00")
)
SITE = {"checking/DemoChecking": Decimal("10.00"), "credit/DemoCard": Decimal("5.00")}
LEDGER = {
    "Assets:Checking:DemoChecking": Decimal("10.00"),
    "Liabilities:Credit:DemoCard": Decimal("-5.00"),
}


class _Ledger:
    def __init__(self, balances):
        self.balances = balances

    def balance(self, name):
        return self.balances.get(name, Decimal(0))


class StatementFetcher(Fetcher):
    """The site balance matches the ledger for every account, so the balance
    shortcut skips each export; fetch() must therefore never run."""

    key = "bofa"
    display_name = "Demo"
    domain = "bank.example"

    def __init__(self, statement):
        super().__init__()
        self.statement = statement  # StatementInfo, None, or an Exception
        self.asked = []

    def ensure_logged_in(self, page, creds):
        pass

    def read_balance(self, page, account):
        return SITE[account.path]

    def read_statement(self, page, account):
        self.asked.append(account.path)
        if isinstance(self.statement, Exception):
            raise self.statement
        return self.statement

    def fetch(self, page, account, staging_dir):
        raise AssertionError("export should have been skipped by the shortcut")


def _run(tmp_path, monkeypatch, statement, **kw):
    cfg = load_config()
    monkeypatch.setattr(
        "beancount_tooling.fetch.runner.make_source", lambda c, b: object()
    )
    fetcher = StatementFetcher(statement)
    outcomes = runner.run_bank(
        None,
        cfg.banks["bofa"],
        cfg,
        tmp_path / "run",
        tmp_path / "statements",
        fetcher=fetcher,
        log=lambda s: None,
        ledger=_Ledger(LEDGER),
        today=TODAY,
        **kw,
    )
    return {o.account.path: o for o in outcomes}, fetcher


def _store(tmp_path):
    return tmp_path / "statements" / "billing" / "credit" / "DemoCard.jsonl"


# --- runner hook -----------------------------------------------------------------


def test_run_bank_records_statement_before_balance_shortcut(tmp_path, monkeypatch):
    by_path, _ = _run(tmp_path, monkeypatch, INFO)
    card = by_path["credit/DemoCard"]
    assert card.ok and "balance matches ledger" in card.detail  # export skipped
    assert card.notes == [
        "statement 2030-05-20 recorded: balance 1,234.56, due 2030-06-15"
    ]
    (stmt,) = billing.read_statements(tmp_path / "statements", CARD)
    assert stmt.to_dict() | {"capturedAt": ""} == {
        "account": CARD,
        "id": "2030-05-20",
        "statementBalance": "1234.56",
        "dueDate": "2030-06-15",
        "minimumPayment": "40.00",
        "source": "fetch",
        "capturedAt": "",
    }
    assert "statement 2030-05-20 recorded" in runner.format_summary(by_path.values())

    # A second run reads the same statement: nothing written, nothing reported.
    before = _store(tmp_path).read_bytes()
    by_path, _ = _run(tmp_path, monkeypatch, INFO)
    assert by_path["credit/DemoCard"].notes == []
    assert _store(tmp_path).read_bytes() == before


def test_run_bank_statement_failure_never_fails_account(tmp_path, monkeypatch):
    by_path, _ = _run(tmp_path, monkeypatch, RuntimeError("selector changed"))
    card = by_path["credit/DemoCard"]
    assert card.ok and "balance matches ledger" in card.detail
    assert card.notes == ["statement not read (RuntimeError): kept existing records"]
    assert "selector changed" not in "\n".join(card.notes)
    assert not _store(tmp_path).exists()


def test_run_bank_statement_write_failure_never_fails_account(tmp_path, monkeypatch):
    def boom(*a, **kw):
        raise PermissionError("read-only file system")

    monkeypatch.setattr(billing, "record_statement", boom)
    by_path, _ = _run(tmp_path, monkeypatch, INFO)
    card = by_path["credit/DemoCard"]
    assert card.ok
    assert card.notes == ["statement not read (PermissionError): kept existing records"]


def test_run_bank_dry_run_reports_would_record_and_writes_nothing(
    tmp_path, monkeypatch
):
    by_path, _ = _run(tmp_path, monkeypatch, INFO, dry_run=True)
    assert by_path["credit/DemoCard"].notes == [
        "statement 2030-05-20 would be recorded: balance 1,234.56, due 2030-06-15"
    ]
    assert not (tmp_path / "statements").exists()


def test_run_bank_conflict_is_reported_not_written(tmp_path, monkeypatch):
    statements_dir = tmp_path / "statements"
    billing.record_statement(
        statements_dir,
        CARD,
        StatementInfo(INFO.closing_date, Decimal("1200.00"), INFO.due_date),
        source="manual",
        today=TODAY,
    )
    before = _store(tmp_path).read_bytes()
    by_path, _ = _run(tmp_path, monkeypatch, INFO)
    card = by_path["credit/DemoCard"]
    assert card.ok
    assert card.notes == [
        (
            "statement 2030-05-20 differs from the record, not written: "
            "statementBalance 1200.00 on file, 1234.56 read; "
            "minimumPayment none on file, 40.00 read"
        )
    ]
    assert _store(tmp_path).read_bytes() == before


def test_run_bank_voided_statement_is_reported_not_written(tmp_path, monkeypatch):
    statements_dir = tmp_path / "statements"
    billing.record_statement(statements_dir, CARD, INFO, source="fetch", today=TODAY)
    billing.void_statement(statements_dir, CARD, INFO.closing_date.isoformat())
    before = _store(tmp_path).read_bytes()
    by_path, _ = _run(tmp_path, monkeypatch, INFO)
    card = by_path["credit/DemoCard"]
    assert card.ok
    assert card.notes == [
        (
            "statement 2030-05-20 is voided on file, not written "
            "(re-enter it with `just fetch --statements-only` to bring it back)"
        )
    ]
    assert _store(tmp_path).read_bytes() == before
    assert billing.read_statements(statements_dir, CARD) == []


def test_run_bank_guard_rejection_is_reported_not_written(tmp_path, monkeypatch):
    future = StatementInfo(date(2030, 6, 20), Decimal("1.00"))
    seen = set()
    by_path, _ = _run(tmp_path, monkeypatch, future, statements_seen=seen)
    card = by_path["credit/DemoCard"]
    assert card.ok
    assert card.notes == [
        "statement not recorded: closing date 2030-06-20 is after today (2030-06-18)"
    ]
    assert not _store(tmp_path).exists()
    assert seen == set()  # an unusable read leaves the card to the prompt


def test_run_bank_soft_notes_follow_the_statement_line(tmp_path, monkeypatch):
    billing.record_statement(
        tmp_path / "statements",
        CARD,
        StatementInfo(date(2030, 3, 21), Decimal("1.00")),
        source="fetch",
        today=TODAY,
    )
    by_path, _ = _run(tmp_path, monkeypatch, INFO)
    assert by_path["credit/DemoCard"].notes == [
        "statement 2030-05-20 recorded: balance 1,234.56, due 2030-06-15",
        "cycle of 60 days since 2030-03-21",
    ]


def test_run_bank_skips_non_credit_accounts(tmp_path, monkeypatch):
    by_path, fetcher = _run(tmp_path, monkeypatch, INFO)
    assert fetcher.asked == ["credit/DemoCard"]
    assert by_path["checking/DemoChecking"].notes == []
    files = list((tmp_path / "statements" / "billing").rglob("*.jsonl"))
    assert [f.name for f in files] == ["DemoCard.jsonl"]


def test_run_bank_default_hook_is_none_for_registered_fetchers():
    account = load_config().banks["bofa"].accounts[1]
    readers = {"bofa", "amex"}  # the banks that read statements from the site
    for key in REGISTRY:
        cls = get_fetcher(key)
        assert (cls.read_statement is not Fetcher.read_statement) == (key in readers)
        if key not in readers:
            assert cls().read_statement(None, account) is None


def test_run_bank_without_statement_writes_nothing(tmp_path, monkeypatch):
    seen = set()
    by_path, _ = _run(tmp_path, monkeypatch, None, statements_seen=seen)
    assert by_path["credit/DemoCard"].notes == [] and seen == set()
    assert not (tmp_path / "statements" / "billing").exists()


def test_run_bank_fills_statements_seen(tmp_path, monkeypatch):
    seen = set()
    _run(tmp_path, monkeypatch, INFO, statements_seen=seen)
    assert seen == {CARD}
    # An unchanged re-read still counts: the site is the authority.
    seen = set()
    _run(tmp_path, monkeypatch, INFO, statements_seen=seen)
    assert seen == {CARD}
    seen = set()
    _run(tmp_path, monkeypatch, RuntimeError("x"), statements_seen=seen)
    assert seen == set()


# --- hints and candidates ------------------------------------------------------


def _write_cards(ledger_dir, cards):
    path = ledger_dir / "journal" / "plan" / "cc-cards.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(cards, indent=2))
    return path


CARDS = {
    "Liabilities:Credit:DemoCard": {"statementCloseDay": 20, "paymentDueDay": 15},
    # Not in fetch.yaml at all: it only exists in cc-cards.json.
    "Liabilities:Credit:Acme": {
        "statementCloseDay": -1,
        "paymentDueDay": 99,
        "fundingAccount": "Assets:Checking:DemoChecking",
        "statementBalance": "12.00",
    },
    "Liabilities:Credit:NoCloseDay": {"paymentDueDay": 15},
    "Liabilities:Credit:ZeroDay": {"statementCloseDay": 0},
    "Liabilities:Credit:BigDay": {"statementCloseDay": 32},
    "Liabilities:Credit:TextDay": {"statementCloseDay": "20"},
    "Liabilities:Credit:BoolDay": {"statementCloseDay": True},
    "Liabilities:Credit:NotARecord": 5,
    "Assets:Checking:DemoChecking": {"statementCloseDay": 20},
}


def test_load_card_hints_reads_cc_cards_read_only(tmp_path):
    path = _write_cards(tmp_path, CARDS)
    before = (path.read_bytes(), path.stat().st_mtime_ns)
    hints = statements.load_card_hints(tmp_path)
    # Every card record; an unusable day hint reads as None.
    assert hints == [
        statements.CardHint("Liabilities:Credit:Acme", -1, None),
        statements.CardHint("Liabilities:Credit:BigDay", None, None),
        statements.CardHint("Liabilities:Credit:BoolDay", None, None),
        statements.CardHint("Liabilities:Credit:DemoCard", 20, 15),
        statements.CardHint("Liabilities:Credit:NoCloseDay", None, 15),
        statements.CardHint("Liabilities:Credit:TextDay", None, None),
        statements.CardHint("Liabilities:Credit:ZeroDay", None, None),
    ]
    assert (path.read_bytes(), path.stat().st_mtime_ns) == before
    assert sorted(p.name for p in path.parent.iterdir()) == ["cc-cards.json"]


def test_load_card_hints_missing_or_malformed_file(tmp_path):
    assert statements.load_card_hints(tmp_path) == []
    path = _write_cards(tmp_path, CARDS)
    path.write_text("{not json")
    assert statements.load_card_hints(tmp_path) == []
    path.write_text("[1, 2]")
    assert statements.load_card_hints(tmp_path) == []


def test_manual_candidates_skip_cards_with_recent_record_and_skip_accounts(tmp_path):
    hints = [
        statements.CardHint("Liabilities:Credit:Acme", -1, None),
        statements.CardHint(CARD, 20, 15),
        statements.CardHint("Liabilities:Credit:Seen", 5, 1),
    ]
    got = statements.manual_candidates(
        hints, tmp_path, TODAY, skip_accounts={"Liabilities:Credit:Seen"}
    )
    assert [(c.card, c.expected_close, c.predicted_due) for c in got] == [
        ("Acme", date(2030, 5, 31), None),
        ("DemoCard", date(2030, 5, 20), date(2030, 6, 15)),
    ]
    # A record three days before the expected close is the same statement.
    billing.record_statement(
        tmp_path,
        CARD,
        StatementInfo(date(2030, 5, 17), Decimal("0.00")),
        source="manual",
        today=TODAY,
    )
    got = statements.manual_candidates(hints[:2], tmp_path, date(2030, 6, 16))
    assert [c.card for c in got] == ["Acme"]
    # The next cycle follows the last real close (the 17th), not the hint.
    got = statements.manual_candidates(hints[1:2], tmp_path, date(2030, 6, 16))
    assert got == []
    (again,) = statements.manual_candidates(hints[1:2], tmp_path, date(2030, 6, 17))
    assert again.expected_close == date(2030, 6, 17)
    assert again.predicted_due == date(2030, 7, 15)


def test_manual_candidates_card_without_hint(tmp_path):
    new = statements.CardHint("Liabilities:Credit:Fresh", None, 15)
    # No statement on file and no hint: only asked when include_new.
    assert statements.manual_candidates([new], tmp_path, TODAY) == []
    (first,) = statements.manual_candidates([new], tmp_path, TODAY, include_new=True)
    assert (first.expected_close, first.predicted_due) == (None, None)
    # The closing date has no default; leaving it empty skips the card.
    said = []
    answers = iter([""])
    assert (
        statements.prompt_statement(first, ask=lambda p: next(answers), out=said.append)
        is None
    )
    assert said == ["Fresh: no statement on file, enter the most recent one"]
    # Typed closing date: the due date default is predicted from it.
    prompts = []
    answers = iter(["2030-05-28", "10.00", "", ""])

    def ask(prompt):
        prompts.append(prompt)
        return next(answers)

    info = statements.prompt_statement(first, ask=ask, out=said.append)
    assert info == StatementInfo(date(2030, 5, 28), Decimal("10.00"), date(2030, 6, 15))
    assert prompts[0] == "  Closing date (Enter to skip): "
    assert prompts[2] == "  Due date [2030-06-15]: "
    # Once on file it needs no hint: asked again a month after the real close.
    billing.record_statement(tmp_path, new.account, info, source="manual", today=TODAY)
    assert statements.manual_candidates([new], tmp_path, date(2030, 6, 27)) == []
    (nxt,) = statements.manual_candidates([new], tmp_path, date(2030, 6, 28))
    assert nxt.expected_close == date(2030, 6, 28)


# --- prompt --------------------------------------------------------------------


class _Tty:
    def __init__(self, tty):
        self.tty = tty

    def isatty(self):
        return self.tty


def test_prompts_disabled_when_stdin_not_tty(monkeypatch):
    assert statements.prompts_enabled(False, stdin=_Tty(True))
    assert not statements.prompts_enabled(False, stdin=_Tty(False))
    monkeypatch.setattr("sys.stdin", _Tty(False))
    assert not statements.prompts_enabled(False)
    monkeypatch.setattr("sys.stdin", None)  # e.g. a launchd job with no stdin
    assert not statements.prompts_enabled(False)


def test_prompts_disabled_with_no_prompt_flag():
    assert not statements.prompts_enabled(True, stdin=_Tty(True))


def _candidate(due_day=15, account=CARD, close_day=20):
    hint = statements.CardHint(account, close_day, due_day)
    expected = billing.last_expected_close(TODAY, close_day)
    return statements.PromptCandidate(
        hint, expected, billing.predict_due(expected, due_day)
    )


class Script:
    """Scripted answers for `ask`; records the prompts and the printed lines."""

    def __init__(self, *answers):
        self.answers = list(answers)
        self.prompts = []
        self.printed = []

    def ask(self, prompt):
        self.prompts.append(prompt)
        if not self.answers:
            raise EOFError
        answer = self.answers.pop(0)
        if isinstance(answer, BaseException):
            raise answer
        return answer

    def out(self, line=""):
        self.printed.append(line)

    @property
    def io(self):
        return {"ask": self.ask, "out": self.out}


def test_prompt_empty_balance_skips_card(tmp_path):
    script = Script("", "")
    assert statements.prompt_statement(_candidate(), **script.io) is None
    assert script.printed == ["DemoCard: statement expected to have closed 2030-05-20"]
    assert script.prompts == [
        "  Closing date [2030-05-20]: ",
        "  Statement balance (Enter to skip): ",
    ]

    script = Script("", "  ")
    lines = statements.run_manual_prompts([_candidate()], tmp_path, TODAY, **script.io)
    assert lines == ["DemoCard: skipped"]
    assert list(tmp_path.iterdir()) == []


def test_prompt_defaults_fill_closing_and_due():
    script = Script("", "$1,234.56", "", "")
    info = statements.prompt_statement(_candidate(), **script.io)
    assert info == StatementInfo(
        date(2030, 5, 20), Decimal("1234.56"), date(2030, 6, 15), None
    )
    assert script.prompts == [
        "  Closing date [2030-05-20]: ",
        "  Statement balance (Enter to skip): ",
        "  Due date [2030-06-15]: ",
        "  Minimum payment (optional): ",
    ]


def test_prompt_typed_values_override_defaults():
    script = Script("5/18/2030", "0", "2030-06-12", "25")
    info = statements.prompt_statement(_candidate(), **script.io)
    assert info == StatementInfo(
        date(2030, 5, 18), Decimal(0), date(2030, 6, 12), Decimal(25)
    )
    # A typed closing date moves the default due date with it.
    script = Script("2030-06-16", "10", "", "")
    info = statements.prompt_statement(_candidate(), **script.io)
    assert info.due_date == date(2030, 7, 15)
    assert script.prompts[2] == "  Due date [2030-07-15]: "
    # "none" clears a predicted due date; no prediction shows "none".
    script = Script("", "10", "none", "")
    assert statements.prompt_statement(_candidate(), **script.io).due_date is None
    script = Script("", "10", "", "")
    info = statements.prompt_statement(_candidate(due_day=None), **script.io)
    assert info.due_date is None
    assert script.prompts[2] == "  Due date [none]: "


def test_prompt_reasks_bad_value_then_accepts():
    script = Script("yesterday", "", "lots", "12.00", "", "")
    info = statements.prompt_statement(_candidate(), **script.io)
    assert info == StatementInfo(
        date(2030, 5, 20), Decimal("12.00"), date(2030, 6, 15), None
    )
    assert script.prompts.count("  Statement balance (Enter to skip): ") == 2
    assert script.prompts.count("  Closing date [2030-05-20]: ") == 2
    assert any("not an amount" in line for line in script.printed)
    assert any("not a date" in line for line in script.printed)


def test_prompt_three_bad_values_skip_the_card():
    script = Script("a", "b", "c", "never asked")
    assert statements.prompt_statement(_candidate(), **script.io) is None
    assert script.printed[-1] == "  skipped: could not read closing date"
    assert script.answers == ["never asked"]


def test_prompt_eof_skips(tmp_path):
    assert statements.prompt_statement(_candidate(), **Script().io) is None
    assert statements.prompt_statement(_candidate(), **Script("12.00").io) is None
    script = Script("", "12.00")  # input ends at the due date
    other = _candidate(account="Liabilities:Credit:Acme")
    lines = statements.run_manual_prompts(
        [_candidate(), other], tmp_path, TODAY, **script.io
    )
    assert lines == ["DemoCard: skipped", "Acme: skipped"]
    assert list(tmp_path.iterdir()) == []


def test_run_manual_prompts_ctrl_c_skips_remaining_cards(tmp_path):
    script = Script("", "12.00", "", "", KeyboardInterrupt(), "99.00")
    cards = [
        _candidate(),
        _candidate(account="Liabilities:Credit:Acme"),
        _candidate(account="Liabilities:Credit:Third"),
    ]
    lines = statements.run_manual_prompts(cards, tmp_path, TODAY, **script.io)
    assert lines == [
        "DemoCard: statement 2030-05-20 recorded",
        "Acme: skipped",
        "Third: skipped",
    ]
    assert script.answers == ["99.00"]  # the third card was never asked
    assert list(billing.read_all(tmp_path)) == [CARD]


def test_run_manual_prompts_writes_source_manual(tmp_path):
    script = Script("", "1,234.56", "", "40")
    lines = statements.run_manual_prompts([_candidate()], tmp_path, TODAY, **script.io)
    assert lines == ["DemoCard: statement 2030-05-20 recorded"]
    (stmt,) = billing.read_statements(tmp_path, CARD)
    assert (stmt.source, stmt.statementBalance, stmt.dueDate, stmt.minimumPayment) == (
        "manual",
        "1234.56",
        "2030-06-15",
        "40.00",
    )

    # Typing the same statement again changes nothing; a new value corrects it.
    before = billing.card_file(tmp_path, CARD).read_bytes()
    lines = statements.run_manual_prompts(
        [_candidate()], tmp_path, TODAY, **Script("", "1234.56", "", "40").io
    )
    assert lines == ["DemoCard: statement 2030-05-20 unchanged"]
    assert billing.card_file(tmp_path, CARD).read_bytes() == before
    lines = statements.run_manual_prompts(
        [_candidate()], tmp_path, TODAY, **Script("", "1300", "", "40").io
    )
    assert lines == [
        "DemoCard: statement 2030-05-20 corrected",
        "  statementBalance 1234.56 on file, 1300.00 read",
    ]
    (stmt,) = billing.read_statements(tmp_path, CARD)
    assert stmt.statementBalance == "1300.00"


def test_run_manual_prompts_guard_failure_and_dry_run(tmp_path):
    script = Script("2030-06-25", "10", "", "")  # closing date after today
    lines = statements.run_manual_prompts([_candidate()], tmp_path, TODAY, **script.io)
    assert lines == [
        "DemoCard: not recorded: closing date 2030-06-25 is after today (2030-06-18)"
    ]
    script = Script("", "10", "", "20")
    lines = statements.run_manual_prompts(
        [_candidate()], tmp_path, TODAY, dry_run=True, **script.io
    )
    assert lines == [
        "DemoCard: statement 2030-05-20 would be recorded",
        "  minimum payment exceeds the statement balance",
    ]
    assert list(tmp_path.iterdir()) == []


# --- command line --------------------------------------------------------------


@pytest.fixture
def cli_ledger(tmp_path, monkeypatch):
    """A ledger with cc-cards.json and no config/fetch.yaml; any attempt to
    open a browser or to ask a question fails the test."""

    def forbidden(*a, **kw):
        raise AssertionError("must not be called")

    monkeypatch.setenv("LEDGER_DIR", str(tmp_path))
    monkeypatch.setattr(browser, "open_context", forbidden)
    monkeypatch.setattr(browser, "new_york_today", lambda: TODAY)
    monkeypatch.setattr("builtins.input", forbidden)
    hinted = ("Liabilities:Credit:DemoCard", "Liabilities:Credit:Acme")
    _write_cards(tmp_path, {k: CARDS[k] for k in hinted})
    return tmp_path


def test_cli_flags_parse():
    parser = cli.build_parser()
    args = parser.parse_args(["--statements-only", "--no-prompt", "--dry-run"])
    assert args.statements_only and args.no_prompt and args.dry_run
    args = parser.parse_args([])
    assert not args.statements_only and not args.no_prompt
    with pytest.raises(SystemExit):  # one mode at a time
        parser.parse_args(["--statements-only", "--login"])


def test_cli_statements_only_never_opens_browser_and_needs_no_fetch_yaml(
    cli_ledger, monkeypatch, capsys
):
    monkeypatch.setattr("sys.stdin", _Tty(False))
    assert not (cli_ledger / "config").exists()
    assert cli.main(["--statements-only"]) == 0
    assert capsys.readouterr().out.splitlines() == [
        (
            "Acme: statement expected since 2030-05-31, not recorded "
            "(run `just fetch --statements-only`)"
        ),
        (
            "DemoCard: statement expected since 2030-05-20, not recorded "
            "(run `just fetch --statements-only`)"
        ),
    ]
    assert not (cli_ledger / "statements").exists()


def test_cli_statements_only_prompts_on_a_terminal(cli_ledger, monkeypatch, capsys):
    monkeypatch.setattr("sys.stdin", _Tty(True))
    answers = iter(["", "", "", "55.00", "", ""])  # skip Acme, record DemoCard
    monkeypatch.setattr("builtins.input", lambda prompt="": next(answers))
    assert cli.main(["--statements-only"]) == 0
    out = capsys.readouterr().out
    assert "Card statements" in out
    assert "Acme: skipped" in out and "DemoCard: statement 2030-05-20 recorded" in out
    (stmt,) = billing.read_statements(cli_ledger / "statements", CARD)
    assert (stmt.statementBalance, stmt.source) == ("55.00", "manual")

    # --no-prompt wins over the terminal; --dry-run asks but writes nothing.
    monkeypatch.setattr("builtins.input", lambda prompt="": pytest.fail("asked"))
    assert cli.main(["--statements-only", "--no-prompt"]) == 0
    assert "Acme: statement expected since 2030-05-31" in capsys.readouterr().out
    answers = iter(["", "7.00", "", ""])
    monkeypatch.setattr("builtins.input", lambda prompt="": next(answers))
    assert cli.main(["--statements-only", "--dry-run"]) == 0
    assert "Acme: statement 2030-05-31 would be recorded" in capsys.readouterr().out
    assert list(billing.read_all(cli_ledger / "statements")) == [CARD]


def test_cli_statements_only_nothing_missing(cli_ledger, monkeypatch, capsys):
    monkeypatch.setattr("sys.stdin", _Tty(True))
    _write_cards(cli_ledger, {})
    assert cli.main(["--statements-only"]) == 0
    assert capsys.readouterr().out == "No card statements are missing.\n"


def test_cli_fetch_non_tty_does_not_block(cli_ledger, monkeypatch, capsys):
    # After the banks run: stdin is not a terminal, so nothing is asked.
    monkeypatch.setattr("sys.stdin", _Tty(False))
    assert cli.cmd_statements(dry_run=False, no_prompt=False, skip_accounts={CARD}) == 0
    assert capsys.readouterr().out.splitlines() == [
        "",
        (
            "Acme: statement expected since 2030-05-31, not recorded "
            "(run `just fetch --statements-only`)"
        ),
    ]
    # On a terminal, a dry run of a normal fetch lists instead of asking.
    monkeypatch.setattr("sys.stdin", _Tty(True))
    assert cli.cmd_statements(dry_run=True, no_prompt=False) == 0
    assert "DemoCard: statement expected since" in capsys.readouterr().out
    # Nothing missing after a normal fetch: silent.
    assert (
        cli.cmd_statements(
            dry_run=False,
            no_prompt=False,
            skip_accounts={CARD, "Liabilities:Credit:Acme"},
        )
        == 0
    )
    assert capsys.readouterr().out == ""
    assert not (cli_ledger / "statements").exists()


def test_cmd_fetch_passes_seen_cards_to_the_statement_step(
    cli_ledger, ledger_dir, monkeypatch, capsys
):
    """cmd_fetch wiring with a fake browser context and a fake run_bank."""
    from contextlib import contextmanager

    monkeypatch.setenv("LEDGER_DIR", str(ledger_dir))  # has config/fetch.yaml
    cfg = load_config()
    monkeypatch.setenv("LEDGER_DIR", str(cli_ledger))
    monkeypatch.setattr("sys.stdin", _Tty(False))

    @contextmanager
    def fake_context(profile_dir):
        yield object()

    def fake_run_bank(page, bank, config, run_dir, statements_dir, **kw):
        kw["statements_seen"].add(CARD)
        return []

    monkeypatch.setattr(browser, "open_context", fake_context)
    monkeypatch.setattr(browser, "first_page", lambda context: None)
    monkeypatch.setattr(browser, "make_staging_dir", lambda: cli_ledger / "run")
    monkeypatch.setattr(runner, "run_bank", fake_run_bank)
    code = cli.cmd_fetch(cfg, ["bofa"], dry_run=False, keep_open=False, shortcut=False)
    assert code == 0
    out = capsys.readouterr().out
    assert "Acme: statement expected since 2030-05-31" in out
    assert "DemoCard" not in out  # an adapter returned its statement


# --- extract -------------------------------------------------------------------


def test_extract_skipped_roots_include_billing_and_pending(tmp_path):
    from beancount_tooling import extract

    roots = extract.skipped_roots(str(tmp_path))
    real = os.path.realpath(tmp_path)
    assert set(roots) == {
        os.path.join(real, "pending", ""),
        os.path.join(real, "billing", ""),
    }
    store = billing.card_file(tmp_path, CARD)
    snapshot = tmp_path / "pending" / "checking" / "DemoChecking.csv"
    export = tmp_path / "credit" / "DemoCard" / "current_1111.csv"
    lookalike = tmp_path / "billing-old" / "x.csv"  # only the exact dir is skipped
    assert os.path.realpath(store).startswith(roots)
    assert os.path.realpath(snapshot).startswith(roots)
    assert not os.path.realpath(export).startswith(roots)
    assert not os.path.realpath(lookalike).startswith(roots)
