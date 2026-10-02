import os
import stat
from decimal import Decimal
from pathlib import Path

import pytest
from beancount_tooling.fetch import browser, runner
from beancount_tooling.fetch.banks.base import (
    REGISTRY,
    Fetcher,
    StagedFile,
    get_fetcher,
)
from beancount_tooling.fetch.config import load_config
from beancount_tooling.fetch.credentials import CredentialSource

FIXTURES = Path(__file__).parent / "fixtures"
SECRET = "s3cret-Pa55word-not-real"


# --- login flow --------------------------------------------------------------


class FakeField:
    def __init__(self, page, name):
        self.page, self.name = page, name

    def fill(self, value):
        self.page.filled[self.name] = value

    def click(self):
        self.page.submitted += 1


class FakePage:
    def __init__(self, states):
        self.states = list(states)  # state per poll after submit
        self.state = "logged_out"
        self.filled = {}
        self.submitted = 0
        self.urls = []

    def goto(self, url):
        self.urls.append(url)

    def advance(self):
        if self.submitted and self.states:
            self.state = self.states.pop(0)


class Creds(CredentialSource):
    def __init__(self):
        self.reads = []

    def username(self):
        self.reads.append("username")
        return "demo-user"

    def password(self):
        self.reads.append("password")
        return SECRET


def _spec():
    return browser.LoginSpec(
        overview_url="https://bank.example/overview",
        is_logged_in=lambda p: p.state == "in",
        username_field=lambda p: FakeField(p, "user"),
        password_field=lambda p: FakeField(p, "pass"),
        submit=lambda p: FakeField(p, "submit"),
        is_mfa=lambda p: p.state == "mfa",
        is_rejected=lambda p: p.state == "rejected",
    )


def _run_login(page, timeout_minutes=1, **kw):
    t = [0.0]
    logs, notes = [], []

    def sleep(s):
        t[0] += s
        page.advance()

    def clock():
        return t[0]

    browser.login(
        page,
        _spec(),
        kw.pop("creds", Creds()),
        bank_label="Demo",
        timeout_minutes=timeout_minutes,
        poll_seconds=10,
        log=logs.append,
        notifier=lambda title, msg: notes.append(msg),
        clock=clock,
        sleep=sleep,
    )
    return logs, notes


def test_login_already_logged_in():
    page = FakePage([])
    page.state = "in"
    creds = Creds()
    _run_login(page, creds=creds)
    assert creds.reads == [] and page.submitted == 0


def test_login_fills_once_then_mfa_then_in():
    page = FakePage(["mfa", "mfa", "in"])
    creds = Creds()
    logs, notes = _run_login(page, creds=creds)
    assert creds.reads == ["username", "password"]
    assert page.submitted == 1
    assert logs == ["Demo: waiting for 2FA"] and len(notes) == 1
    assert all(SECRET not in line for line in logs + notes)


def test_login_password_rejected_hard_stop():
    page = FakePage(["rejected"])
    with pytest.raises(browser.PasswordRejected) as exc:
        _run_login(page)
    assert page.submitted == 1
    assert SECRET not in str(exc.value)


def test_login_timeout():
    page = FakePage(["mfa"] * 100)
    with pytest.raises(browser.LoginTimeout):
        _run_login(page, timeout_minutes=1)
    assert page.submitted == 1


# --- staging -----------------------------------------------------------------


def test_staging_dirs_are_private(tmp_path):
    run = browser.make_staging_dir("run-1", root=tmp_path / "bank-fetch")
    acct = browser.account_staging_dir(run, "credit/DemoCard")
    assert acct == run / "credit" / "DemoCard"
    for d in (tmp_path / "bank-fetch", run, acct):
        assert stat.S_IMODE(os.stat(d).st_mode) == 0o700


def test_open_context_refuses_recording(tmp_path):
    with (
        pytest.raises(ValueError, match="record_har_path"),
        browser.open_context(tmp_path / "profile", record_har_path="x.har"),
    ):
        pass


class _FakeChromium:
    def __init__(self):
        self.calls = []

    def launch_persistent_context(self, user_data_dir, **options):
        self.calls.append((user_data_dir, options))
        return type("Ctx", (), {"close": lambda self: None, "pages": []})()


class _FakePlaywright:
    def __init__(self):
        self.chromium = _FakeChromium()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def test_open_context_uses_real_keychain_and_disables_password_manager(
    tmp_path, monkeypatch
):
    import json

    import playwright.sync_api

    fake = _FakePlaywright()
    monkeypatch.setattr(playwright.sync_api, "sync_playwright", lambda: fake)
    profile = tmp_path / "profile"
    (profile / "Default").mkdir(parents=True)
    (profile / "Default" / "Preferences").write_text(
        json.dumps({"keep": 1, "profile": {"name": "demo"}})
    )
    with browser.open_context(profile):
        pass
    ((_, options),) = fake.chromium.calls
    assert set(options["ignore_default_args"]) == {
        "--use-mock-keychain",
        "--password-store=basic",
        "--enable-automation",
    }
    assert "--disable-blink-features=AutomationControlled" in options["args"]
    assert options["timezone_id"] == "America/New_York"
    prefs_path = profile / "Default" / "Preferences"
    prefs = json.loads(prefs_path.read_text())
    assert prefs["keep"] == 1 and prefs["profile"]["name"] == "demo"
    assert prefs["credentials_enable_service"] is False
    assert prefs["profile"]["password_manager_enabled"] is False
    assert stat.S_IMODE(os.stat(prefs_path).st_mode) == 0o600
    assert stat.S_IMODE(os.stat(profile / "Default").st_mode) == 0o700


def test_disable_password_manager_creates_prefs(tmp_path):
    import json

    path = browser.disable_password_manager(tmp_path / "profile")
    assert json.loads(path.read_text())["credentials_enable_service"] is False


def test_failure_screenshot_masks_every_text_field(tmp_path):
    class ShotPage:
        def __init__(self):
            self.selectors, self.masks = [], None

        def locator(self, selector):
            self.selectors.append(selector)
            return selector

        def screenshot(self, path, full_page, mask):
            self.masks = mask
            Path(path).write_bytes(b"png")

    page = ShotPage()
    assert browser.failure_screenshot(page, tmp_path / "x.png")
    (selector,) = page.masks
    assert selector.startswith("input:not([type=hidden])") and "textarea" in selector
    assert "[type=password]" not in selector  # not limited to password inputs


# --- registry ----------------------------------------------------------------


def test_registry_resolves_fetchers():
    assert set(REGISTRY) == {"bofa", "amex", "td"}
    for key in REGISTRY:
        cls = get_fetcher(key)
        assert issubclass(cls, Fetcher) and cls.key == key and cls.domain


# --- runner ------------------------------------------------------------------


class FixtureFetcher(Fetcher):
    key = "bofa"
    display_name = "Demo"
    domain = "bank.example"

    def __init__(self, files):
        super().__init__()
        self.files = files  # account.path -> list of (fixture text, target, role)

    def ensure_logged_in(self, page, creds):
        pass

    def fetch(self, page, account, staging_dir):
        out = []
        for text, target, role in self.files.get(account.path, []):
            p = staging_dir / target
            p.write_text(text, newline="")
            out.append(StagedFile(p, target, role))
        if account.path not in self.files:
            raise RuntimeError("site changed")
        return out


def _fx(name):
    return (FIXTURES / name).read_text(newline="")


def test_run_bank_installs_isolates_and_summarizes(tmp_path, monkeypatch):
    cfg = load_config()
    bank = cfg.banks["bofa"]
    statements = tmp_path / "statements"
    # Existing rolling file for the card: an older export missing the last row.
    card_dir = statements / "credit/DemoCard"
    card_dir.mkdir(parents=True)
    credit = _fx("bofa_credit.csv")
    old_credit = "\r\n".join(credit.split("\r\n")[:3]) + "\r\n"
    (card_dir / "current_1111.csv").write_text(old_credit, newline="")
    (card_dir / "August2030_1111.csv").write_text("existing archive", newline="")

    fetcher = FixtureFetcher(
        {
            "credit/DemoCard": [
                (credit, "current_1111.csv", "rolling"),
                (credit, "August2030_1111.csv", "archive"),
                (credit, "September2030_1111.csv", "archive"),
            ],
            # checking/DemoChecking missing: fetch raises, must be isolated
        }
    )
    monkeypatch.setattr(
        "beancount_tooling.fetch.runner.make_source", lambda c, b: object()
    )
    outcomes = runner.run_bank(
        None,
        bank,
        cfg,
        tmp_path / "run",
        statements,
        fetcher=fetcher,
        log=lambda s: None,
    )
    by_file = {o.file_name: o for o in outcomes}
    assert by_file["stmt.csv"].detail.startswith("SKIPPED: download failed")
    assert by_file["current_1111.csv"].ok
    assert by_file["current_1111.csv"].detail.startswith("+1 rows")
    assert (card_dir / "current_1111.csv").read_text(newline="") == credit
    assert by_file["August2030_1111.csv"].detail == "archive exists (kept existing)"
    assert (card_dir / "August2030_1111.csv").read_text() == "existing archive"
    assert by_file["September2030_1111.csv"].detail.startswith("archived (new")
    summary = runner.format_summary(outcomes)
    assert "DemoChecking checking" in summary and "DemoCard" in summary


def _account_and_dirs(tmp_path, bank="bofa", index=1):
    cfg = load_config()
    account = cfg.banks[bank].accounts[index]
    staging = tmp_path / "run" / account.path
    staging.mkdir(parents=True)
    target = tmp_path / "statements" / account.path
    target.mkdir(parents=True)
    return cfg, account, staging, target


def _stage(staging, text, name):
    p = staging / name
    p.write_text(text, newline="")
    return StagedFile(p, name, "rolling")


def test_evaluate_timezone_shift_keeps_existing(tmp_path):
    cfg, account, staging, target = _account_and_dirs(tmp_path)
    old = _fx("bofa_credit.csv")
    (target / account.rolling).write_text(old, newline="")
    shifted = old.replace("09/05/2030", "09/06/2030").replace(
        "09/12/2030", "09/13/2030"
    )
    out = runner.evaluate_staged(
        _stage(staging, shifted, account.rolling),
        account,
        target,
        payment_account=cfg.payment_account,
    )
    assert not out.ok and "wrong timezone" in out.detail
    assert (target / account.rolling).read_text(newline="") == old


def test_evaluate_placeholder_keeps_existing(tmp_path):
    cfg, account, staging, target = _account_and_dirs(tmp_path, index=0)
    (target / "stmt.csv").write_text(_fx("bofa_checking.csv"), newline="")
    out = runner.evaluate_staged(
        _stage(staging, _fx("bofa_checking_placeholder.csv"), "stmt.csv"),
        account,
        target,
        payment_account=cfg.payment_account,
    )
    assert out.ok and out.detail == "no new rows (kept existing)"
    assert (target / "stmt.csv").read_text(newline="") == _fx("bofa_checking.csv")


def test_evaluate_previous_period_fails_sanity(tmp_path):
    cfg, account, staging, target = _account_and_dirs(tmp_path, bank="amex", index=0)
    current = _fx("amex_activity.csv")
    (target / "activity.csv").write_text(current, newline="")
    previous = current.replace("09/", "08/")
    out = runner.evaluate_staged(
        _stage(staging, previous, "activity.csv"),
        account,
        target,
        payment_account=cfg.payment_account,
    )
    assert not out.ok and out.detail.startswith("SKIPPED: sanity")


def test_evaluate_dry_run_touches_nothing(tmp_path):
    cfg, account, staging, target = _account_and_dirs(tmp_path)
    out = runner.evaluate_staged(
        _stage(staging, _fx("bofa_credit.csv"), account.rolling),
        account,
        target,
        payment_account=cfg.payment_account,
        dry_run=True,
    )
    assert out.ok and "would be created" in out.detail
    assert not (target / account.rolling).exists()


def test_run_bank_login_failures_skip_whole_bank(tmp_path, monkeypatch):
    cfg = load_config()
    monkeypatch.setattr(
        "beancount_tooling.fetch.runner.make_source", lambda c, b: object()
    )

    class Rejecting(FixtureFetcher):
        def ensure_logged_in(self, page, creds):
            raise browser.PasswordRejected("Demo: password rejected")

    outcomes = runner.run_bank(
        None,
        cfg.banks["bofa"],
        cfg,
        tmp_path,
        tmp_path / "s",
        fetcher=Rejecting({}),
        log=lambda s: None,
    )
    assert len(outcomes) == 2
    assert all(o.detail == "SKIPPED: password rejected (not retried)" for o in outcomes)


def test_run_bank_login_step_error_names_the_step(tmp_path, monkeypatch):
    cfg = load_config()
    monkeypatch.setattr(
        "beancount_tooling.fetch.runner.make_source", lambda c, b: object()
    )

    class StepFailure(browser.SiteStepError):
        pass

    class Broken(FixtureFetcher):
        def ensure_logged_in(self, page, creds):
            raise StepFailure("Demo: step 'sign in' failed waiting for SOME_LABEL")

    class Other(FixtureFetcher):
        def ensure_logged_in(self, page, creds):
            raise RuntimeError("detail that is not meant for the summary")

    outcomes = runner.run_bank(
        None,
        cfg.banks["bofa"],
        cfg,
        tmp_path,
        tmp_path / "s",
        fetcher=Broken({}),
        log=lambda s: None,
    )
    assert outcomes[0].detail == "SKIPPED: login error: StepFailure"
    assert any("SOME_LABEL" in n for n in outcomes[0].notes)

    outcomes = runner.run_bank(
        None,
        cfg.banks["bofa"],
        cfg,
        tmp_path,
        tmp_path / "s",
        fetcher=Other({}),
        log=lambda s: None,
    )
    assert not any("not meant" in n for o in outcomes for n in o.notes)


AMEX_SAME_DAY = (
    "09/09/2030,SAMPLE CAFE,7.00,SAMPLE CAFE,SAMPLE CAFE,,,,,"
    "'900000000000000005',Restaurant-Restaurant\n"
)
AMEX_NEXT = (
    "09/22/2030,SAMPLE GROCER,12.00,SAMPLE GROCER,SAMPLE GROCER,,,,,"
    "'900000000000000004',Merchandise & Supplies-Groceries\n"
)


def _amex_header(text):
    return text.split("\n", 1)[0] + "\n"


def test_evaluate_header_only_rolling_is_no_new_rows(tmp_path):
    cfg, account, staging, target = _account_and_dirs(tmp_path, bank="amex", index=0)
    current = _fx("amex_activity.csv")
    (target / "activity.csv").write_text(current, newline="")
    out = runner.evaluate_staged(
        _stage(staging, _amex_header(current), "activity.csv"),
        account,
        target,
        payment_account=cfg.payment_account,
    )
    assert out.ok and out.detail == "no new rows (kept existing)"
    assert (target / "activity.csv").read_text(newline="") == current


def test_evaluate_empty_file_is_no_new_rows(tmp_path):
    # Amex sends a 0-byte file for a card with no activity in the period.
    cfg, account, staging, target = _account_and_dirs(tmp_path, bank="amex", index=0)
    current = _fx("amex_activity.csv")
    (target / "activity.csv").write_text(current, newline="")
    out = runner.evaluate_staged(
        _stage(staging, "", "activity.csv"),
        account,
        target,
        payment_account=cfg.payment_account,
    )
    assert out.ok and out.detail == "no new rows (kept existing)"
    assert (target / "activity.csv").read_text(newline="") == current


def test_evaluate_amex_enriched_rows_replace(tmp_path):
    cfg, account, staging, target = _account_and_dirs(tmp_path, bank="amex", index=0)
    new = _fx("amex_activity.csv")
    old = new.replace(",Merchandise & Supplies-Books", ",")
    (target / "activity.csv").write_text(old, newline="")
    out = runner.evaluate_staged(
        _stage(staging, new, "activity.csv"),
        account,
        target,
        payment_account=cfg.payment_account,
    )
    assert out.ok, out.detail
    assert (target / "activity.csv").read_text(newline="") == new


def test_evaluate_statement_rollover_with_archive_on_disk(tmp_path):
    cfg, account, staging, target = _account_and_dirs(tmp_path, bank="amex", index=0)
    old = _fx("amex_activity.csv")
    (target / "activity.csv").write_text(old, newline="")
    new = _amex_header(old) + AMEX_SAME_DAY + AMEX_NEXT
    staged = _stage(staging, new, "activity.csv")
    out = runner.evaluate_staged(
        staged, account, target, payment_account=cfg.payment_account, dry_run=True
    )
    assert not out.ok and "missing" in out.detail
    (target / "2030-09.csv").write_text(old, newline="")
    out = runner.evaluate_staged(
        staged, account, target, payment_account=cfg.payment_account
    )
    assert out.ok, out.detail
    assert "3 aged out" in out.detail
    assert (target / "activity.csv").read_text(newline="") == new


def test_run_bank_rollover_uses_archive_staged_same_run(tmp_path, monkeypatch):
    cfg = load_config()
    bank = cfg.banks["amex"]
    account = bank.accounts[0]
    statements = tmp_path / "statements"
    target = statements / account.path
    target.mkdir(parents=True)
    old = _fx("amex_activity.csv")
    (target / "activity.csv").write_text(old, newline="")
    new = _amex_header(old) + AMEX_SAME_DAY + AMEX_NEXT

    class AmexFixture(FixtureFetcher):
        key = "amex"

    fetcher = AmexFixture(
        {
            account.path: [
                (new, "activity.csv", "rolling"),
                (old, "2030-09.csv", "archive"),
            ]
        }
    )
    monkeypatch.setattr(
        "beancount_tooling.fetch.runner.make_source", lambda c, b: object()
    )
    outcomes = runner.run_bank(
        None,
        bank,
        cfg,
        tmp_path / "run",
        statements,
        dry_run=True,
        fetcher=fetcher,
        log=lambda s: None,
    )
    assert [o.file_name for o in outcomes] == ["activity.csv", "2030-09.csv"]
    assert all(o.ok for o in outcomes), [o.detail for o in outcomes]
    assert not (target / "2030-09.csv").exists()  # dry run


def test_run_bank_archive_failure_keeps_rolling(tmp_path, monkeypatch):
    cfg = load_config()
    bank = cfg.banks["bofa"]
    statements = tmp_path / "statements"

    class ArchiveFails(FixtureFetcher):
        def fetch(self, page, account, staging_dir):
            out = super().fetch(page, account, staging_dir)
            if account.archive:
                out.append(
                    StagedFile.failed(
                        "September2030_1111.csv", "archive", RuntimeError("no period")
                    )
                )
            return out

    fetcher = ArchiveFails(
        {
            "checking/DemoChecking": [
                (_fx("bofa_checking.csv"), "stmt.csv", "rolling")
            ],
            "credit/DemoCard": [
                (_fx("bofa_credit.csv"), "current_1111.csv", "rolling")
            ],
        }
    )
    monkeypatch.setattr(
        "beancount_tooling.fetch.runner.make_source", lambda c, b: object()
    )
    outcomes = runner.run_bank(
        None,
        bank,
        cfg,
        tmp_path / "run",
        statements,
        fetcher=fetcher,
        log=lambda s: None,
    )
    by_file = {o.file_name: o for o in outcomes}
    assert by_file["current_1111.csv"].ok
    assert (statements / "credit/DemoCard/current_1111.csv").exists()
    failed = by_file["September2030_1111.csv"]
    assert not failed.ok
    assert failed.detail == "SKIPPED: download failed (RuntimeError: no period)"


def test_clear_download_history_keeps_other_tables(tmp_path):
    import sqlite3

    from beancount_tooling.fetch.browser import clear_download_history

    (tmp_path / "Default").mkdir()
    db_path = tmp_path / "Default" / "History"
    with sqlite3.connect(db_path) as db:
        for t in ("downloads", "downloads_url_chains", "downloads_slices", "urls"):
            db.execute(f"CREATE TABLE {t} (id INTEGER)")
            db.execute(f"INSERT INTO {t} VALUES (1)")
    clear_download_history(tmp_path)
    with sqlite3.connect(db_path) as db:
        counts = {
            t: db.execute(f"SELECT count(*) FROM {t}").fetchone()[0]
            for t in ("downloads", "downloads_url_chains", "downloads_slices", "urls")
        }
    assert counts == {
        "downloads": 0,
        "downloads_url_chains": 0,
        "downloads_slices": 0,
        "urls": 1,
    }
    clear_download_history(tmp_path / "missing")  # no profile yet: no-op


# --- balance shortcut ----------------------------------------------------------


class _Ledger:
    def __init__(self, balances):
        self.balances = balances

    def balance(self, name):
        return self.balances.get(name, Decimal(0))


class BalanceFetcher(FixtureFetcher):
    def __init__(self, files, site):
        super().__init__(files)
        self.site = site  # account.path -> Decimal, or an Exception to raise
        self.fetched = []

    def read_balance(self, page, account):
        value = self.site.get(account.path)
        if isinstance(value, Exception):
            raise value
        return value

    def fetch(self, page, account, staging_dir):
        self.fetched.append(account.path)
        return super().fetch(page, account, staging_dir)


def _run_shortcut(tmp_path, monkeypatch, site, ledger):
    cfg = load_config()
    monkeypatch.setattr(
        "beancount_tooling.fetch.runner.make_source", lambda c, b: object()
    )
    credit = _fx("bofa_credit.csv")
    fetcher = BalanceFetcher(
        {"credit/DemoCard": [(credit, "current_1111.csv", "rolling")]}, site
    )
    outcomes = runner.run_bank(
        None,
        cfg.banks["bofa"],
        cfg,
        tmp_path / "run",
        tmp_path / "statements",
        fetcher=fetcher,
        log=lambda s: None,
        ledger=_Ledger(ledger),
    )
    return {o.account.path: o for o in outcomes}, fetcher


def test_shortcut_skips_export_when_balances_match(tmp_path, monkeypatch):
    by_path, fetcher = _run_shortcut(
        tmp_path,
        monkeypatch,
        site={
            "checking/DemoChecking": Decimal("10.00"),
            "credit/DemoCard": Decimal("5.00"),
        },
        # Credit: the site shows the amount owed, the ledger a liability.
        ledger={
            "Assets:Checking:DemoChecking": Decimal("10.00"),
            "Liabilities:Credit:DemoCard": Decimal("-5.00"),
        },
    )
    assert fetcher.fetched == []
    for path in ("checking/DemoChecking", "credit/DemoCard"):
        assert by_path[path].ok
        assert "balance matches ledger" in by_path[path].detail


def test_shortcut_mismatch_or_error_falls_back_to_export(tmp_path, monkeypatch):
    by_path, fetcher = _run_shortcut(
        tmp_path,
        monkeypatch,
        site={
            "checking/DemoChecking": RuntimeError("selector changed"),
            "credit/DemoCard": Decimal("5.00"),
        },
        ledger={"Liabilities:Credit:DemoCard": Decimal("5.00")},  # wrong sign
    )
    assert fetcher.fetched == ["checking/DemoChecking", "credit/DemoCard"]
    assert by_path["credit/DemoCard"].ok
    assert "balance matches" not in by_path["credit/DemoCard"].detail


def test_no_activity_keeps_existing(tmp_path, monkeypatch):
    from beancount_tooling.fetch.banks.base import NoActivity

    class Quiet(FixtureFetcher):
        def fetch(self, page, account, staging_dir):
            raise NoActivity(account.path)

    cfg = load_config()
    monkeypatch.setattr(
        "beancount_tooling.fetch.runner.make_source", lambda c, b: object()
    )
    outcomes = runner.run_bank(
        None,
        cfg.banks["bofa"],
        cfg,
        tmp_path / "run",
        tmp_path / "statements",
        fetcher=Quiet({}),
        log=lambda s: None,
    )
    assert all(o.ok and "no activity" in o.detail for o in outcomes)


def test_ledger_balances_sum_postings_up_to_as_of(tmp_path):
    from datetime import date

    from beancount_tooling.fetch.ledger import LedgerBalances, ledger_account

    journal = tmp_path / "j.beancount"
    journal.write_text(
        "2030-01-01 open Assets:Checking:Demo\n"
        "2030-01-01 open Expenses:Food\n"
        '2030-01-02 * "Shop"\n  Assets:Checking:Demo  -3.00 USD\n  Expenses:Food\n'
        '2030-01-03 ! "Pending"\n  Assets:Checking:Demo  -1.50 USD\n  Expenses:Food\n'
        '2030-02-01 ! "Future forecast"\n  Assets:Checking:Demo  -9.00 USD\n'
        "  Expenses:Food\n"
    )
    ledger = LedgerBalances(journal, date(2030, 1, 31))
    assert ledger.balance("Assets:Checking:Demo") == Decimal("-4.50")
    assert ledger.balance("Assets:Checking:Missing") == 0
    cfg = load_config()
    names = {ledger_account(a) for a in cfg.banks["bofa"].accounts}
    assert names == {"Assets:Checking:DemoChecking", "Liabilities:Credit:DemoCard"}


def test_money_parsers():
    from beancount_tooling.fetch.banks.amex import parse_total_balance
    from beancount_tooling.fetch.banks.bofa import parse_money

    assert parse_money('- link "Demo - 1111"\n- text: $2,040.36') == Decimal("2040.36")
    assert parse_money("- text: -$1.00") == Decimal("-1.00")
    assert parse_money("no amount") is None
    snap = "- text: Posted Charges $29.63\n- text: Total Balance\n- text: $219.07"
    assert parse_total_balance(snap) == Decimal("219.07")
    assert parse_total_balance("- text: Posted Charges $29.63") is None
