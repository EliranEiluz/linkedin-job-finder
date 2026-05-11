"""Pytest tests for backend/ctl/notifications_ctl.py.

Verifies the documented JSON-CLI contract without actually contacting any
SMTP server or the Telegram API (test-smtp lives in phase_d_test.py's
opt-in real-send block; test-telegram is exercised via mocking in
test_notifications_telegram.py).

Each test runs against an isolated $HOME under tmp_path so the developer's
real ~/.linkedin-jobs.env is never touched. Sentinel "secrets" are spliced
into save-* payloads to verify the CLI never echoes them on stdout/stderr.

Style mirrors the rest of backend/tests/: small, focused functions with
real `assert` so pytest can collect them. Replaces the legacy script-shaped
notifications_ctl_test.py — that one slept silent under the test_*.py
discovery glob and was effectively unrun.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent  # repo root
CTL = ROOT / "backend" / "ctl" / "notifications_ctl.py"

# Sentinel strings we use as "secrets". If save-* ever prints them back on
# stdout/stderr we treat that as a regression; the API explicitly promises
# never to log the password / bot_token.
SENTINEL_PASSWORD = "do-not-log-this-sentinel-2026"
SENTINEL_BOT_TOKEN = "0123456789:DO-NOT-LOG-THIS-BOT-TOKEN-SENTINEL"


def _run(argv: list[str], stdin: str | None, env: dict[str, str]) -> subprocess.CompletedProcess:
    return subprocess.run(
        argv,
        input=stdin,
        text=True,
        capture_output=True,
        timeout=10,
        env=env,
    )


@pytest.fixture
def isolated_env(tmp_path: Path) -> dict[str, str]:
    """Per-test $HOME pointing at tmp_path so the real ~/.linkedin-jobs.env
    is never touched. The ctl script reads/writes inside $HOME."""
    env = dict(os.environ)
    env["HOME"] = str(tmp_path)
    return env


def _save_smtp_payload(**overrides: object) -> str:
    payload: dict[str, object] = {
        "host": "smtp.example.com",
        "port": 587,
        "user": "alice@example.com",
        "password": SENTINEL_PASSWORD,
        "email_to": "bob@example.com",
        "use_ssl": False,
    }
    payload.update(overrides)
    return json.dumps(payload)


# ---------------------------------------------------------------------------
# status — empty $HOME envelope shape.
# ---------------------------------------------------------------------------


def test_status_on_empty_home_returns_unconfigured_envelope(
    isolated_env: dict[str, str],
) -> None:
    """status against a fresh $HOME (no ~/.linkedin-jobs.env) must emit a
    structured JSON object with both channels reporting configured=False
    and all the documented per-channel keys present."""
    p = _run(["python3", str(CTL), "status"], None, isolated_env)
    assert p.returncode == 0, p.stderr
    body = json.loads(p.stdout)

    for key in ("ok", "channels", "env_file"):
        assert key in body, f"top-level key {key} missing"
    channels = body["channels"]
    assert isinstance(channels, dict)

    email = channels.get("email", {})
    for key in ("configured", "host", "port", "user", "email_to", "ssl"):
        assert key in email, f"status.channels.email missing {key}"
    assert email["configured"] is False

    telegram = channels.get("telegram", {})
    for key in ("configured", "chat_id"):
        assert key in telegram, f"status.channels.telegram missing {key}"
    assert telegram["configured"] is False


# ---------------------------------------------------------------------------
# save-smtp — atomic env write, password redaction, mode 0o600.
# ---------------------------------------------------------------------------


def test_save_smtp_writes_env_file_with_all_six_smtp_vars(
    tmp_path: Path, isolated_env: dict[str, str]
) -> None:
    p = _run(["python3", str(CTL), "save-smtp"], _save_smtp_payload(), isolated_env)
    assert p.returncode == 0, p.stderr

    env_file = tmp_path / ".linkedin-jobs.env"
    assert env_file.exists()
    text = env_file.read_text()
    for var in (
        "SMTP_HOST",
        "SMTP_PORT",
        "SMTP_USER",
        "SMTP_PASS",
        "EMAIL_TO",
        "SMTP_USE_SSL",
    ):
        assert f"{var}=" in text, f"env file missing {var}="


def test_save_smtp_chmods_env_file_to_0o600(tmp_path: Path, isolated_env: dict[str, str]) -> None:
    _run(["python3", str(CTL), "save-smtp"], _save_smtp_payload(), isolated_env)
    env_file = tmp_path / ".linkedin-jobs.env"
    mode = env_file.stat().st_mode & 0o777
    assert mode == 0o600, f"env file mode is 0o{mode:o}, expected 0o600"


def test_save_smtp_does_not_leak_password_on_stdout_or_stderr(
    isolated_env: dict[str, str],
) -> None:
    """The CLI promise: password never appears in either output stream.
    If this regression fires, secrets are leaking into the UI's command
    log + the user's terminal scrollback."""
    p = _run(["python3", str(CTL), "save-smtp"], _save_smtp_payload(), isolated_env)
    assert p.returncode == 0
    assert SENTINEL_PASSWORD not in p.stdout
    assert SENTINEL_PASSWORD not in p.stderr


def test_save_smtp_with_empty_password_preserves_saved_password(
    tmp_path: Path, isolated_env: dict[str, str]
) -> None:
    """Empty-string password = "user didn't retype it"; we must keep the
    one already on disk and still update the rest of the fields. Also
    confirms that switching to port 465 without an explicit `use_ssl` flag
    triggers the auto-SSL behavior the wizard relies on."""
    _run(["python3", str(CTL), "save-smtp"], _save_smtp_payload(), isolated_env)
    # Deliberately omit `use_ssl` so the ctl auto-derives from port=465.
    partial = json.dumps(
        {
            "host": "smtp2.example.com",
            "port": 465,
            "user": "alice@example.com",
            "password": "",
        }
    )
    p = _run(["python3", str(CTL), "save-smtp"], partial, isolated_env)
    assert p.returncode == 0, p.stderr
    text = (tmp_path / ".linkedin-jobs.env").read_text()
    assert f"SMTP_PASS={SENTINEL_PASSWORD}" in text
    # port 465 should auto-enable SSL when use_ssl wasn't passed.
    assert "SMTP_USE_SSL=1" in text


def test_save_smtp_rejects_payload_missing_host(isolated_env: dict[str, str]) -> None:
    p = _run(
        ["python3", str(CTL), "save-smtp"],
        json.dumps({"user": "x@y.z"}),
        isolated_env,
    )
    assert p.returncode != 0, "save-smtp accepted payload with no host"


# ---------------------------------------------------------------------------
# status (post-save) — round-trip check; password MUST NOT appear.
# ---------------------------------------------------------------------------


def test_status_after_save_smtp_reports_configured_without_leaking_password(
    isolated_env: dict[str, str],
) -> None:
    _run(["python3", str(CTL), "save-smtp"], _save_smtp_payload(), isolated_env)
    p = _run(["python3", str(CTL), "status"], None, isolated_env)
    assert p.returncode == 0
    body = json.loads(p.stdout)
    email = body["channels"]["email"]
    assert email["configured"] is True
    assert email["host"] == "smtp.example.com"
    assert email["user"] == "alice@example.com"
    # Password must NEVER round-trip via status.
    assert SENTINEL_PASSWORD not in p.stdout
    assert "password" not in email
    assert "smtp_pass" not in email


# ---------------------------------------------------------------------------
# save-telegram — atomic write, bot_token redaction, validation.
# ---------------------------------------------------------------------------


def test_save_telegram_writes_both_telegram_env_vars(
    tmp_path: Path, isolated_env: dict[str, str]
) -> None:
    payload = json.dumps({"bot_token": SENTINEL_BOT_TOKEN, "chat_id": "12345678"})
    p = _run(["python3", str(CTL), "save-telegram"], payload, isolated_env)
    assert p.returncode == 0, p.stderr
    text = (tmp_path / ".linkedin-jobs.env").read_text()
    for var in ("TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"):
        assert f"{var}=" in text, f"env file missing {var}="


def test_save_telegram_does_not_leak_bot_token(isolated_env: dict[str, str]) -> None:
    payload = json.dumps({"bot_token": SENTINEL_BOT_TOKEN, "chat_id": "12345678"})
    p = _run(["python3", str(CTL), "save-telegram"], payload, isolated_env)
    assert p.returncode == 0
    assert SENTINEL_BOT_TOKEN not in p.stdout
    assert SENTINEL_BOT_TOKEN not in p.stderr


def test_save_telegram_with_empty_token_preserves_saved_token(
    tmp_path: Path, isolated_env: dict[str, str]
) -> None:
    """Mirror of save-smtp's empty-password preservation: an empty bot_token
    keeps the existing one and lets the user just bump chat_id."""
    first = json.dumps({"bot_token": SENTINEL_BOT_TOKEN, "chat_id": "12345678"})
    _run(["python3", str(CTL), "save-telegram"], first, isolated_env)
    second = json.dumps({"bot_token": "", "chat_id": "99999"})
    p = _run(["python3", str(CTL), "save-telegram"], second, isolated_env)
    assert p.returncode == 0, p.stderr
    text = (tmp_path / ".linkedin-jobs.env").read_text()
    assert f"TELEGRAM_BOT_TOKEN={SENTINEL_BOT_TOKEN}" in text
    assert "TELEGRAM_CHAT_ID=99999" in text


def test_save_telegram_rejects_empty_chat_id(isolated_env: dict[str, str]) -> None:
    payload = json.dumps({"bot_token": SENTINEL_BOT_TOKEN, "chat_id": ""})
    p = _run(["python3", str(CTL), "save-telegram"], payload, isolated_env)
    assert p.returncode != 0, "save-telegram accepted empty chat_id"


def test_status_after_save_telegram_reports_chat_id_only(
    isolated_env: dict[str, str],
) -> None:
    payload = json.dumps({"bot_token": SENTINEL_BOT_TOKEN, "chat_id": "12345678"})
    _run(["python3", str(CTL), "save-telegram"], payload, isolated_env)
    p = _run(["python3", str(CTL), "status"], None, isolated_env)
    body = json.loads(p.stdout)
    telegram = body["channels"]["telegram"]
    assert telegram["configured"] is True
    assert telegram["chat_id"] == "12345678"
    # bot_token must NEVER round-trip via status.
    assert SENTINEL_BOT_TOKEN not in p.stdout
    assert "bot_token" not in telegram


# ---------------------------------------------------------------------------
# test-telegram — bare $HOME (no creds) must surface a clean ok=false.
# ---------------------------------------------------------------------------


def test_test_telegram_returns_clean_error_with_no_creds() -> None:
    """Edge: an unconfigured user pokes the test button. We must NOT raise
    a traceback — JSON envelope with ok=false is the contract."""
    bare_home = Path(tempfile.mkdtemp(prefix="notif-bare-"))
    bare_env = dict(os.environ)
    bare_env["HOME"] = str(bare_home)
    try:
        p = _run(["python3", str(CTL), "test-telegram"], None, bare_env)
        assert p.returncode != 0
        body = json.loads(p.stdout)
        assert body.get("ok") is False
    finally:
        shutil.rmtree(bare_home, ignore_errors=True)


# Guard: pytest must NEVER pick up the legacy if-name-main script-runner shape.
# This file uses real `def test_*` so we deliberately don't add one.
if __name__ == "__main__":  # pragma: no cover — convenience for ad-hoc runs
    sys.exit(pytest.main([__file__, "-v"]))
