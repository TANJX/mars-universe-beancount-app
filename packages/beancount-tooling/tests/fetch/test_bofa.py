"""BofA fetcher: pure helpers and the fetch() orchestration, with synthetic data
only (no browser, no real site)."""

import re
from datetime import date
from pathlib import Path

import pytest
from beancount_tooling.fetch.banks import bofa
from beancount_tooling.fetch.banks.base import Fetcher, get_fetcher
from beancount_tooling.fetch.config import AccountConfig, load_config


def _card(**kw) -> AccountConfig:
    base = {
        "bank": "bofa",
        "path": "credit/DemoCard",
        "kind": "credit",
        "rolling": "current_1111.csv",
        "archive": "{MonthName}{YYYY}_1111.csv",
        "last4": "1111",
    }
    base.update(kw)
    return AccountConfig(**base)


def _checking() -> AccountConfig:
    return AccountConfig(
        bank="bofa",
        path="checking/DemoChecking",
        kind="checking",
        rolling="stmt.csv",
        last4="0000",
    )


# --- registry ----------------------------------------------------------------


def test_registered_and_concrete():
    cls = get_fetcher("bofa")
    assert cls is bofa.BofAFetcher
    assert issubclass(cls, Fetcher)
    assert cls.domain == "bankofamerica.com"
    fetcher = cls(3)  # the runner constructs it with the login timeout only
    assert fetcher.login_timeout_minutes == 3


# --- account matching --------------------------------------------------------


@pytest.mark.parametrize(
    "label",
    [
        "Demo Checking - 1111",
        "Demo Rewards Visa Signature - 1111 ",
        "Demo Card ...1111",
        "Demo Card x1111",
        "Demo Card 1111",
    ],
)
def test_account_link_pattern_matches(label):
    assert bofa.account_link_pattern("1111").search(label)


@pytest.mark.parametrize(
    "label",
    [
        "Demo Card - 21111",  # longer number ending in the same digits
        "Demo Card - 1111 2",
        "Demo Card - 2222",
        "Demo Card 1111 rewards",
    ],
)
def test_account_link_pattern_rejects(label):
    assert not bofa.account_link_pattern("1111").search(label)


@pytest.mark.parametrize("digits", [None, "", "TODO", "12a4"])
def test_account_link_pattern_requires_digits(digits):
    with pytest.raises(bofa.AccountNotFound, match="last4"):
        bofa.account_link_pattern(digits)


def test_account_digits_come_from_config(ledger_dir):
    config = load_config(ledger_dir / "config")
    for account in config.banks["bofa"].accounts:
        pattern = bofa.account_link_pattern(account.last_digits)
        assert pattern.search(f"Some Account - {account.last_digits}")


@pytest.mark.parametrize(
    "label,matches",
    [
        ("Demo Checking Account", True),
        (" demo checking account ", True),  # whitespace and case
        ("Demo Checking Account 2", False),
        ("Your special offer! for Demo Checking Account", False),
    ],
)
def test_account_link_matcher_uses_overview_name(label, matches):
    account = _card(overview_name="Demo Checking Account")
    assert bool(bofa.account_link_matcher(account).search(label)) is matches


def test_account_link_matcher_escapes_overview_name():
    account = _card(overview_name="VISA (Travel) + 1")
    assert bofa.account_link_matcher(account).search("VISA (Travel) + 1")


def test_account_link_matcher_falls_back_to_digits():
    assert bofa.account_link_matcher(_card()).search("Demo Card - 1111")


# --- statement periods -------------------------------------------------------


@pytest.mark.parametrize(
    "label,expected",
    [
        ("September 2026", (2026, 9)),
        ("january 2027", (2027, 1)),
        ("Statement closing 08/24/2026", (2026, 8)),
        ("12/03/2025", (2025, 12)),
        ("Current transactions", None),
        ("13/01/2026", None),
        ("", None),
    ],
)
def test_parse_statement_period(label, expected):
    assert bofa.parse_statement_period(label) == expected


def test_latest_statement_option_picks_newest_across_years():
    options = [
        "Current transactions",
        "November 2025",
        "January 2026",
        "December 2025",
    ]
    assert bofa.latest_statement_option(options) == ("January 2026", 2026, 1)


def test_latest_statement_option_none_when_only_current():
    assert bofa.latest_statement_option(["Current transactions"]) is None


@pytest.mark.parametrize(
    "today,expected",
    [(date(2026, 10, 2), (2026, 9)), (date(2026, 1, 15), (2025, 12))],
)
def test_previous_month(today, expected):
    assert bofa.previous_month(today) == expected


def test_pick_option():
    options = ["Quicken", " Microsoft Excel Format ", "Text"]
    assert (
        bofa.pick_option(options, bofa.FILE_TYPE_OPTION) == " Microsoft Excel Format "
    )
    assert bofa.pick_option(["Current Transactions"], bofa.CURRENT_PERIOD_OPTION)
    assert bofa.pick_option(["Quicken"], bofa.FILE_TYPE_OPTION) is None


# --- archive target names ----------------------------------------------------


OPTIONS = ["Current transactions", "September 2026", "August 2026"]


def test_archive_target_formats_name_from_template(tmp_path):
    target = bofa.archive_target(_card(), OPTIONS, tmp_path)
    assert target == ("September 2026", "September2026_1111.csv")


def test_archive_target_other_template(tmp_path):
    account = _card(archive="{YYYY}-{MM}.csv")
    assert bofa.archive_target(account, OPTIONS, tmp_path) == (
        "September 2026",
        "2026-09.csv",
    )


def test_archive_target_skips_existing(tmp_path):
    account = _card()
    existing = tmp_path / account.path / "September2026_1111.csv"
    existing.parent.mkdir(parents=True)
    existing.write_text("x")
    assert bofa.archive_target(account, OPTIONS, tmp_path) is None


def test_archive_target_none_without_template_or_statement(tmp_path):
    assert bofa.archive_target(_checking(), OPTIONS, tmp_path) is None
    assert bofa.archive_target(_card(), ["Current transactions"], tmp_path) is None


# --- fetch() orchestration ---------------------------------------------------


class FakeSelect:
    def __init__(self, options):
        self.options = options


class FakeFlow(bofa.BofAFetcher):
    """BofAFetcher with the page-driving steps replaced by recorders."""

    def __init__(self, statements_dir, options):
        super().__init__(statements_dir=statements_dir, log=self.logs_append)
        self.logs = []
        self.calls = []
        self.dialog_options = options

    def logs_append(self, msg):
        self.logs.append(msg)

    def open_account(self, page, account):
        self.calls.append(("open_account", account.path))

    def open_download_dialog(self, page):
        self.calls.append(("dialog",))
        return FakeSelect(self.dialog_options), FakeSelect(["Microsoft Excel Format"])

    def submit_download(
        self, page, period, file_type, staging_dir, target_name, *, period_label
    ):
        self.calls.append(("download", target_name, period_label))
        path = staging_dir / target_name
        path.write_text("synthetic\n")
        return path


@pytest.fixture
def fake_options(monkeypatch):
    monkeypatch.setattr(bofa, "_options", lambda select: list(select.options))


def test_fetch_card_rolling_and_missing_archive(tmp_path, fake_options):
    staging = tmp_path / "run" / "credit" / "DemoCard"
    staging.mkdir(parents=True)
    fetcher = FakeFlow(tmp_path / "statements", OPTIONS)

    staged = fetcher.fetch(None, _card(), staging)

    assert [(s.target_name, s.role) for s in staged] == [
        ("current_1111.csv", "rolling"),
        ("September2026_1111.csv", "archive"),
    ]
    assert all(s.path.parent == staging for s in staged)
    assert ("download", "current_1111.csv", "Current transactions") in fetcher.calls
    assert ("download", "September2026_1111.csv", "September 2026") in fetcher.calls


def test_fetch_card_existing_archive_only_rolling(tmp_path, fake_options):
    statements = tmp_path / "statements"
    archived = statements / "credit" / "DemoCard" / "September2026_1111.csv"
    archived.parent.mkdir(parents=True)
    archived.write_text("x")
    staging = tmp_path / "run"
    staging.mkdir()

    staged = FakeFlow(statements, OPTIONS).fetch(None, _card(), staging)

    assert [s.target_name for s in staged] == ["current_1111.csv"]


def test_fetch_checking_keeps_default_period_when_unmatched(tmp_path, fake_options):
    staging = tmp_path / "run"
    staging.mkdir()
    fetcher = FakeFlow(tmp_path / "statements", ["Some other label"])

    staged = fetcher.fetch(None, _checking(), staging)

    assert [(s.target_name, s.role) for s in staged] == [("stmt.csv", "rolling")]
    assert ("download", "stmt.csv", None) in fetcher.calls
    assert any("CURRENT_PERIOD_OPTION" in m for m in fetcher.logs)


def test_fetch_card_logs_when_no_statement_listed(tmp_path, fake_options):
    staging = tmp_path / "run"
    staging.mkdir()
    fetcher = FakeFlow(tmp_path / "statements", ["Current transactions"])
    fetcher.today = lambda: date(2026, 10, 2)

    staged = fetcher.fetch(None, _card(), staging)

    assert [s.target_name for s in staged] == ["current_1111.csv"]
    assert any("September 2026" in m for m in fetcher.logs)


def test_fetch_card_archive_failure_keeps_rolling(tmp_path, fake_options):
    staging = tmp_path / "run"
    staging.mkdir()

    class ArchiveBreaks(FakeFlow):
        def submit_download(
            self, page, period, file_type, staging_dir, target_name, *, period_label
        ):
            if target_name != "current_1111.csv":
                raise bofa.SelectorTimeout("download dialog: submit", "DOWNLOAD_SUBMIT")
            return super().submit_download(
                page,
                period,
                file_type,
                staging_dir,
                target_name,
                period_label=period_label,
            )

    staged = ArchiveBreaks(tmp_path / "statements", OPTIONS).fetch(
        None, _card(), staging
    )

    rolling, archive = staged
    assert rolling.target_name == "current_1111.csv" and rolling.path.exists()
    assert archive.role == "archive" and archive.path is None
    assert archive.target_name == "September2026_1111.csv"
    assert "DOWNLOAD_SUBMIT" in archive.error


def test_default_today_is_new_york():
    from beancount_tooling.fetch import browser

    assert bofa.BofAFetcher(statements_dir=Path(".")).today is browser.new_york_today


# --- failure path ------------------------------------------------------------


def test_step_names_step_and_constant():
    from playwright.sync_api import TimeoutError as PlaywrightTimeoutError

    with (
        pytest.raises(bofa.SelectorTimeout) as info,
        bofa._step("activity: open download", "DOWNLOAD_OPEN"),
    ):
        raise PlaywrightTimeoutError("Timeout 20000ms exceeded")
    message = str(info.value)
    assert "activity: open download" in message
    assert "DOWNLOAD_OPEN" in message
    assert "--keep-open" in message


def test_step_passes_other_errors_through():
    with pytest.raises(ValueError), bofa._step("x", "Y"):
        raise ValueError("boom")


def test_no_hardcoded_account_files():
    source = Path(bofa.__file__).read_text()
    # File names and digits come from fetch.yaml, never from the module.
    assert not re.search(r"\d{4,5}\.csv", source)
    assert chr(0x2014) not in source  # no em-dash
