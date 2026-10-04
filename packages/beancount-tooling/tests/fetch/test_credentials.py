import json
import logging
import subprocess

import pytest
from beancount_tooling.fetch import credentials
from beancount_tooling.fetch.config import CredentialConfig
from beancount_tooling.fetch.credentials import (
    CredentialError,
    DashlaneSource,
    EnvSource,
    KeychainSource,
    find_credentials,
    make_source,
    set_keychain_credentials,
)

SECRET = "s3cret-Pa55word-not-real"
LOGIN = "demo-user-name"


class FakeRun:
    """Records subprocess.run calls and replays canned results."""

    def __init__(self, *results):
        self.results = list(results)
        self.calls = []

    def __call__(self, argv, **kwargs):
        self.calls.append((argv, kwargs))
        code, out = self.results.pop(0)
        return subprocess.CompletedProcess(argv, code, stdout=out, stderr=None)


@pytest.fixture
def have_tools(monkeypatch):
    monkeypatch.setattr(credentials.shutil, "which", lambda name: f"/usr/bin/{name}")


def _assert_clean(capsys, caplog, *texts):
    out, err = capsys.readouterr()
    for t in texts:
        assert SECRET not in t
    assert SECRET not in out and SECRET not in err
    assert SECRET not in caplog.text


# --- dashlane ----------------------------------------------------------------


def test_dashlane_reads_fields_via_console(monkeypatch, have_tools, capsys, caplog):
    caplog.set_level(logging.DEBUG)
    fake = FakeRun((0, LOGIN + "\n"), (0, SECRET + "\n"))
    monkeypatch.setattr(credentials.subprocess, "run", fake)
    src = DashlaneSource("item-123", bank="demo")
    assert src.username() == LOGIN
    assert src.password() == SECRET
    (a1, k1), (a2, _) = fake.calls
    assert a1 == ["dcli", "p", "id=item-123", "-f", "login", "-o", "console"]
    assert a2 == ["dcli", "p", "id=item-123", "-f", "password", "-o", "console"]
    assert "clipboard" not in " ".join(a1 + a2)
    assert k1["stdout"] == subprocess.PIPE
    # nothing cached on the object
    assert SECRET not in repr(vars(src))
    _assert_clean(capsys, caplog)


def test_dashlane_nonzero_exit_raises_without_secret(
    monkeypatch, have_tools, capsys, caplog
):
    monkeypatch.setattr(credentials.subprocess, "run", FakeRun((1, SECRET)))
    with pytest.raises(CredentialError, match="status 1") as exc:
        DashlaneSource("item-123").password()
    _assert_clean(capsys, caplog, str(exc.value), repr(exc.value))
    assert exc.value.__cause__ is None


def test_dashlane_ambiguous_match_raises(monkeypatch, have_tools, capsys, caplog):
    monkeypatch.setattr(
        credentials.subprocess, "run", FakeRun((0, f"{SECRET}\nother-{SECRET}\n"))
    )
    with pytest.raises(CredentialError, match="ambiguous") as exc:
        DashlaneSource("item-123").password()
    _assert_clean(capsys, caplog, str(exc.value))


def test_dashlane_empty_value_raises(monkeypatch, have_tools):
    monkeypatch.setattr(credentials.subprocess, "run", FakeRun((0, "\n"), (0, "\n")))
    with pytest.raises(CredentialError, match="login.*empty"):
        DashlaneSource("item-123").username()


def test_dashlane_username_falls_back_to_email(monkeypatch, have_tools):
    fake = FakeRun((1, ""), (0, LOGIN + "\n"))
    monkeypatch.setattr(credentials.subprocess, "run", fake)
    assert DashlaneSource("item-123").username() == LOGIN
    assert [argv[4] for argv, _ in fake.calls] == ["login", "email"]


def test_dashlane_missing_binary(monkeypatch):
    monkeypatch.setattr(credentials.shutil, "which", lambda name: None)
    with pytest.raises(CredentialError, match="dcli not found"):
        DashlaneSource("item-123").username()


def test_dashlane_placeholder_id_rejected():
    with pytest.raises(CredentialError, match="find-credentials demo"):
        DashlaneSource("TODO", bank="demo")


# --- find_credentials --------------------------------------------------------


def test_find_credentials_drops_password_fields(
    monkeypatch, have_tools, capsys, caplog
):
    items = [
        {
            "id": "id-1",
            "title": "Demo Bank",
            "login": LOGIN,
            "password": SECRET,
            "otpSecret": SECRET,
            "note": SECRET,
            "url": "https://example.com",
        },
        {"id": "id-2", "title": "Demo Bank (old)", "password": SECRET},
    ]
    fake = FakeRun((0, json.dumps(items)))
    monkeypatch.setattr(credentials.subprocess, "run", fake)
    result = find_credentials("example.com")
    assert result == [
        {"id": "id-1", "title": "Demo Bank"},
        {"id": "id-2", "title": "Demo Bank (old)"},
    ]
    assert fake.calls[0][0] == ["dcli", "p", "url=example.com", "-o", "json"]
    _assert_clean(capsys, caplog, repr(result))


def test_find_credentials_bad_json_does_not_echo(
    monkeypatch, have_tools, capsys, caplog
):
    monkeypatch.setattr(credentials.subprocess, "run", FakeRun((0, f"oops {SECRET}")))
    with pytest.raises(CredentialError, match="not JSON") as exc:
        find_credentials("example.com")
    _assert_clean(capsys, caplog, str(exc.value))


def test_cli_find_credentials_prints_titles_and_ids_only(
    monkeypatch, have_tools, capsys, caplog
):
    from beancount_tooling.fetch import cli

    items = [{"id": "id-9", "title": "Demo Card", "password": SECRET, "login": LOGIN}]
    monkeypatch.setattr(credentials.subprocess, "run", FakeRun((0, json.dumps(items))))
    assert cli.main(["--find-credentials", "amex"]) == 0
    out, _ = capsys.readouterr()
    assert "id-9" in out and "Demo Card" in out
    assert SECRET not in out and LOGIN not in out


# --- keychain ----------------------------------------------------------------


def test_keychain_reads_username_and_password_items(monkeypatch, capsys, caplog):
    fake = FakeRun((0, LOGIN + "\n"), (0, SECRET + "\n"))
    monkeypatch.setattr(credentials.subprocess, "run", fake)
    src = KeychainSource("demo-svc")
    assert src.username() == LOGIN
    assert src.password() == SECRET
    assert fake.calls[0][0] == [
        "security",
        "find-generic-password",
        "-s",
        "demo-svc.username",
        "-w",
    ]
    assert fake.calls[1][0] == [
        "security",
        "find-generic-password",
        "-s",
        "demo-svc",
        "-w",
    ]
    _assert_clean(capsys, caplog)


def test_keychain_not_found(monkeypatch, capsys, caplog):
    monkeypatch.setattr(credentials.subprocess, "run", FakeRun((44, SECRET)))
    with pytest.raises(CredentialError, match="status 44") as exc:
        KeychainSource("demo-svc").password()
    _assert_clean(capsys, caplog, str(exc.value))


def test_set_keychain_never_puts_username_or_secret_on_argv(monkeypatch, capsys):
    fake = FakeRun((0, None), (0, None))
    monkeypatch.setattr(credentials.subprocess, "run", fake)
    monkeypatch.setattr(
        "builtins.input", lambda *a: pytest.fail("username must not be read here")
    )
    set_keychain_credentials("demo-svc")
    (user_argv, _), (pass_argv, _) = fake.calls
    for argv in (user_argv, pass_argv):
        assert argv[:2] == ["security", "add-generic-password"]
        assert argv[-1] == "-w"  # value-less -w: security prompts with echo off
        assert LOGIN not in argv and SECRET not in argv
    assert user_argv[user_argv.index("-s") + 1] == "demo-svc.username"
    assert pass_argv[pass_argv.index("-s") + 1] == "demo-svc"
    assert user_argv[user_argv.index("-a") + 1] == credentials.KEYCHAIN_USERNAME_ACCOUNT
    assert pass_argv[pass_argv.index("-a") + 1] == credentials.KEYCHAIN_PASSWORD_ACCOUNT
    assert "USERNAME" in capsys.readouterr().out


def test_set_keychain_failure(monkeypatch):
    monkeypatch.setattr(credentials.subprocess, "run", FakeRun((1, None)))
    with pytest.raises(CredentialError, match="status 1"):
        set_keychain_credentials("demo-svc")


# --- env ---------------------------------------------------------------------


def test_env_source(monkeypatch):
    monkeypatch.setenv("DEMO_USERNAME", LOGIN)
    monkeypatch.setenv("DEMO_PASSWORD", SECRET)
    src = EnvSource("demo")
    assert src.username() == LOGIN and src.password() == SECRET


def test_env_source_missing(monkeypatch):
    monkeypatch.delenv("DEMO_PASSWORD", raising=False)
    with pytest.raises(CredentialError, match="DEMO_PASSWORD is not set"):
        EnvSource("demo").password()


def test_make_source():
    assert isinstance(
        make_source(CredentialConfig("dashlane", id="x"), "b"), DashlaneSource
    )
    assert isinstance(
        make_source(CredentialConfig("keychain", service="s"), "b"), KeychainSource
    )
    env = make_source(CredentialConfig("env"), "bofa")
    assert isinstance(env, EnvSource) and env.prefix == "BOFA"
