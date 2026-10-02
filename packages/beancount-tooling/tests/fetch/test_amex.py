"""Pure parts of the Amex fetcher. All card digits and dates are synthetic."""

from datetime import date

import pytest
from beancount_tooling.fetch.banks import amex
from beancount_tooling.fetch.banks.base import Fetcher, get_fetcher
from beancount_tooling.fetch.config import AccountConfig, load_config


def _account(**kw):
    defaults = {
        "bank": "amex",
        "path": "credit/DemoAmex",
        "kind": "credit",
        "rolling": "activity.csv",
        "archive": "{YYYY}-{MM}.csv",
        "last5": "12345",
    }
    defaults.update(kw)
    return AccountConfig(**defaults)


# --- registry ------------------------------------------------------------------


def test_registered():
    cls = get_fetcher("amex")
    assert cls is amex.AmexFetcher and issubclass(cls, Fetcher)
    f = cls(3)
    assert f.login_timeout_minutes == 3
    assert f.domain == "americanexpress.com"


# --- card matching ---------------------------------------------------------------

CARDS = [
    "Demo Gold Card -11111",
    "Demo Platinum •22222",
    "Demo Blue, ending in 33333",
    "Demo Green (44444)",
]


@pytest.mark.parametrize(
    "digits,index", [("11111", 0), ("22222", 1), ("33333", 2), ("44444", 3)]
)
def test_match_card(digits, index):
    assert amex.match_card(CARDS, digits) == index


def test_match_card_whole_digit_group_only():
    labels = ["Demo Card -112345", "Demo Card -123456", "Demo Card -12345"]
    assert amex.match_card(labels, "12345") == 2


def test_match_card_none_or_ambiguous():
    with pytest.raises(LookupError, match="no card"):
        amex.match_card(CARDS, "99999")
    with pytest.raises(LookupError, match="2 cards"):
        amex.match_card(["Demo A -55555", "Demo B -55555"], "55555")


@pytest.mark.parametrize("bad", ["TODO", "1234", "123456", "", None])
def test_card_digits_pattern_rejects_bad_digits(bad):
    with pytest.raises(ValueError):
        amex.card_digits_pattern(bad)


def test_require_last5():
    assert amex.require_last5(_account()) == "12345"
    with pytest.raises(ValueError, match="set last5"):
        amex.require_last5(_account(last5="TODO"))
    with pytest.raises(ValueError, match="set last5"):
        amex.require_last5(_account(last5=None))


def test_config_placeholder_last5_is_rejected_at_fetch_time():
    account = load_config().banks["amex"].accounts[0]
    assert account.last5 == "TODO"
    with pytest.raises(ValueError, match="credit/DemoAmex"):
        amex.require_last5(account)


# --- period labels -----------------------------------------------------------------


@pytest.mark.parametrize(
    "label,expected",
    [
        ("Aug 13 - Sep 12, 2030", (date(2030, 8, 13), date(2030, 9, 12))),
        ("Aug 13 – Sep 12, 2030", (date(2030, 8, 13), date(2030, 9, 12))),
        ("Dec 13 - Jan 12, 2031", (date(2030, 12, 13), date(2031, 1, 12))),
        (
            "Dec 13, 2030 - Jan 12, 2031",
            (date(2030, 12, 13), date(2031, 1, 12)),
        ),
        ("August 13 to September 12, 2030", (date(2030, 8, 13), date(2030, 9, 12))),
        ("Sept. 13 - Oct. 12, 2030", (date(2030, 9, 13), date(2030, 10, 12))),
        ("08/13/2030 - 09/12/2030", (date(2030, 8, 13), date(2030, 9, 12))),
        ("Statement closing Sep 12, 2030", (None, date(2030, 9, 12))),
    ],
)
def test_parse_period_label(label, expected):
    assert amex.parse_period_label(label) == expected


@pytest.mark.parametrize(
    "label", ["Recent Activity", "Since last statement", "Aug 13 - Sep 12", ""]
)
def test_parse_period_label_without_dated_end(label):
    assert amex.parse_period_label(label) is None


# --- archive period ---------------------------------------------------------------

PERIODS = [
    "Recent Activity",
    "Sep 13 - Oct 12, 2030",  # open: closes after "today"
    "Aug 13 - Sep 12, 2030",
    "Jul 13 - Aug 12, 2030",
    "Jun 13 - Jul 12, 2030",
]


def test_latest_closed_period_skips_open_period():
    index, (start, end) = amex.latest_closed_period(PERIODS, date(2030, 10, 2))
    assert index == 2 and start == date(2030, 8, 13) and end == date(2030, 9, 12)


def test_latest_closed_period_closing_today_is_still_open():
    index, (_, end) = amex.latest_closed_period(PERIODS, date(2030, 9, 12))
    assert index == 3 and end == date(2030, 8, 12)


def test_latest_closed_period_order_independent():
    shuffled = [PERIODS[3], PERIODS[0], PERIODS[2], PERIODS[1]]
    index, (_, end) = amex.latest_closed_period(shuffled, date(2030, 10, 2))
    assert shuffled[index] == PERIODS[2] and end == date(2030, 9, 12)


def test_latest_closed_period_none():
    assert amex.latest_closed_period(["Recent Activity"], date(2030, 10, 2)) is None
    assert amex.latest_closed_period(PERIODS[1:2], date(2030, 10, 2)) is None


def test_archive_period_is_closing_month():
    assert amex.archive_period(date(2030, 9, 12)) == (2030, 9)
    assert amex.archive_period(date(2031, 1, 3)) == (2031, 1)


# --- target names -------------------------------------------------------------------


def test_archive_target_from_config_template():
    assert amex.archive_target(_account(), date(2030, 9, 12)) == "2030-09.csv"
    assert amex.archive_target(_account(), date(2031, 1, 12)) == "2031-01.csv"
    named = _account(archive="{MonthName}{YYYY}_demo.csv")
    assert amex.archive_target(named, date(2030, 9, 12)) == "September2030_demo.csv"
    assert amex.archive_target(_account(archive=None), date(2030, 9, 12)) is None


def test_archive_target_end_to_end_from_labels():
    _, (_, closing) = amex.latest_closed_period(PERIODS, date(2030, 10, 2))
    assert amex.archive_target(_account(), closing) == "2030-09.csv"


# --- archive date check ----------------------------------------------------------------

HEADER = "Date,Description,Amount\n"


def test_check_archive_dates_accepts_rows_up_to_closing(tmp_path):
    f = tmp_path / "a.csv"
    f.write_text(HEADER + "09/12/2030,DEMO SHOP,1.00\n08/20/2030,DEMO CAFE,2.00\n")
    amex.check_archive_dates(f, date(2030, 9, 12))


def test_check_archive_dates_rejects_current_period(tmp_path):
    f = tmp_path / "a.csv"
    f.write_text(HEADER + "09/30/2030,DEMO SHOP,1.00\n09/01/2030,DEMO CAFE,2.00\n")
    with pytest.raises(amex.AmexStepError, match="after the closing date"):
        amex.check_archive_dates(f, date(2030, 9, 12))


# --- step errors ----------------------------------------------------------------------


def test_step_converts_playwright_timeout():
    from playwright.sync_api import TimeoutError as PlaywrightTimeoutError

    with (
        pytest.raises(amex.AmexStepError) as exc,
        amex.step("choose CSV", "DOWNLOAD_CSV_LABEL"),
    ):
        raise PlaywrightTimeoutError("Timeout 20000ms exceeded")
    err = exc.value
    assert err.step == "choose CSV" and err.constant == "DOWNLOAD_CSV_LABEL"
    assert "choose CSV" in str(err) and "DOWNLOAD_CSV_LABEL" in str(err)
    assert "--keep-open" in str(err)
    assert chr(0x2014) not in str(err)


def test_step_passes_other_errors_through():
    with pytest.raises(KeyError), amex.step("anything", "X"):
        raise KeyError("x")


# --- archive skip when it already exists ---------------------------------------------


class _Keyboard:
    def __init__(self):
        self.pressed = []

    def press(self, key):
        self.pressed.append(key)


class _Options:
    def __init__(self, labels):
        self.labels = labels
        self.clicked = None

    @property
    def first(self):
        return self

    def wait_for(self, **kw):
        pass

    def count(self):
        return len(self.labels)

    def nth(self, i):
        outer = self

        class _One:
            def click(self, **kw):
                outer.clicked = i

            def aria_snapshot(self, **kw):
                return f'- button "{outer.labels[i]}"'

        return _One()


class _Selector:
    def click(self, **kw):
        pass


class _ArchivePage:
    def __init__(self, labels):
        self.options = _Options(labels)
        self.keyboard = _Keyboard()

    def get_by_test_id(self, test_id):
        assert test_id == amex.PERIOD_SELECTOR_TEST_ID
        return type("L", (), {"first": _Selector()})()

    def get_by_role(self, role, **kw):
        return self.options


def test_existing_archive_is_not_downloaded(tmp_path):
    statements = tmp_path / "statements"
    (statements / "credit" / "DemoAmex").mkdir(parents=True)
    (statements / "credit" / "DemoAmex" / "2030-09.csv").write_text("kept")
    fetcher = amex.AmexFetcher(
        statements_dir=statements, today=lambda: date(2030, 10, 2)
    )
    page = _ArchivePage(PERIODS)
    assert fetcher._fetch_archive(page, _account(), tmp_path / "staging") is None
    assert page.options.clicked is None
    assert page.keyboard.pressed == ["Escape"]


def test_no_closed_period_names_the_constant(tmp_path):
    fetcher = amex.AmexFetcher(statements_dir=tmp_path, today=lambda: date(2030, 10, 2))
    page = _ArchivePage(["Recent Activity"])
    with pytest.raises(amex.AmexStepError, match="PERIOD_OPTION_ROLE"):
        fetcher._fetch_archive(page, _account(), tmp_path)


def test_archive_failure_keeps_rolling(tmp_path):
    fetcher = amex.AmexFetcher(statements_dir=tmp_path, today=lambda: date(2030, 10, 2))
    fetcher._open_activity = lambda page: None
    fetcher._select_card = lambda page, last5: None
    fetcher._assert_card = lambda page, last5: None
    fetcher._select_rolling_period = lambda page: None

    def download(page, staging_dir, target_name):
        path = staging_dir / target_name
        path.write_text("synthetic\n")
        return path

    def archive(page, account, staging_dir):
        raise amex.AmexStepError("read the statement periods", "PERIOD_OPTION_ROLE")

    fetcher._download = download
    fetcher._fetch_archive = archive
    rolling, failed = fetcher.fetch(None, _account(), tmp_path)
    assert rolling.target_name == "activity.csv" and rolling.path.exists()
    assert failed.role == "archive" and failed.path is None
    assert "PERIOD_OPTION_ROLE" in failed.error


def test_latest_closed_period_on_closing_date_labels():
    # The live popover names each recent statement by its closing date only.
    labels = ["Sep 9, 2030", "Aug 10, 2030", "Jul 10, 2030"]
    index, (start, end) = amex.latest_closed_period(labels, date(2030, 10, 2))
    assert (index, start, end) == (0, None, date(2030, 9, 9))
    assert amex.PERIOD_OPTION_NAME.match("Sep 9, 2030")
    assert not amex.PERIOD_OPTION_NAME.match("Last 30 Days")
    assert not amex.PERIOD_OPTION_NAME.match("2025")
