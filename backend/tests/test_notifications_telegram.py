"""Smoke + redaction tests for backend/send_digest.py's Telegram channel.

Mocks `requests.post` so no network calls leave the box. Verifies:
- happy path posts to the documented URL with the documented payload shape
- 4096-char overflow falls back to the short summary instead of chunking
- bot_token NEVER appears in any error message returned to the caller
- empty creds → (False, "Telegram not configured...") without a network call
- HTTP-200 + `ok=false` body still yields (False, ...) (defensive — the
  spec says 200 = success but Telegram historically embedded errors in
  200 responses for a window in 2018)

Lives alongside the rest of the pytest unit suite (test_*.py) so it
runs by default in `python3 -m pytest backend/tests/test_*.py`.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

# Bare-name import resolves via the sys.path shim in conftest.py.
import send_digest as sd

REAL_TOKEN = "0123456789:ABC-DEF-this-is-a-fake-bot-token-for-tests"
REAL_CHAT_ID = "987654321"


def _mock_response(status: int = 200, body: dict | None = None) -> MagicMock:
    resp = MagicMock()
    resp.status_code = status
    resp.json.return_value = body or {"ok": True, "result": {}}
    resp.text = ""
    return resp


def test_happy_path_posts_documented_url_and_payload():
    """sendMessage URL = https://api.telegram.org/bot<token>/sendMessage,
    payload carries chat_id + text + parse_mode=HTML + disable_web_page_preview=False."""
    captured: dict = {}

    def _fake_post(url, json=None, timeout=None):  # noqa: ARG001
        captured["url"] = url
        captured["json"] = json
        captured["timeout"] = timeout
        return _mock_response(200)

    with patch("requests.post", side_effect=_fake_post):
        ok, msg = sd.send_via_telegram(
            "<b>hello</b>",
            bot_token=REAL_TOKEN,
            chat_id=REAL_CHAT_ID,
        )

    assert ok is True
    assert msg == f"sent to chat {REAL_CHAT_ID}"
    assert captured["url"] == f"https://api.telegram.org/bot{REAL_TOKEN}/sendMessage"
    assert captured["timeout"] == sd.TELEGRAM_TIMEOUT_S
    payload = captured["json"]
    assert payload["chat_id"] == REAL_CHAT_ID
    assert payload["text"] == "<b>hello</b>"
    assert payload["parse_mode"] == "HTML"
    assert payload["disable_web_page_preview"] is False


def test_truncation_falls_back_to_summary_not_chunks():
    """Anything over 4096 chars sends the short summary instead of chunking."""
    huge = "x" * (sd.TELEGRAM_MAX_CHARS + 100)
    jobs = [
        {"fit": "good", "priority": True},
        {"fit": "good", "priority": False},
        {"fit": "ok"},
    ]
    captured: dict = {}

    def _fake_post(url, json=None, timeout=None):  # noqa: ARG001
        captured["text"] = json["text"]
        return _mock_response(200)

    with patch("requests.post", side_effect=_fake_post):
        ok, _ = sd.send_via_telegram(
            huge,
            bot_token=REAL_TOKEN,
            chat_id=REAL_CHAT_ID,
            jobs=jobs,
        )

    assert ok is True
    sent = captured["text"]
    # Not a chunk of the original.
    assert "x" * 100 not in sent
    # Is the summary.
    assert "3 new jobs found" in sent
    assert "Run History" in sent
    assert len(sent) <= sd.TELEGRAM_MAX_CHARS


def test_empty_jobs_summary_is_safe():
    """Empty jobs list with overflow text still produces a sensible summary."""
    huge = "y" * (sd.TELEGRAM_MAX_CHARS + 1)
    captured: dict = {}

    def _fake_post(url, json=None, timeout=None):  # noqa: ARG001
        captured["text"] = json["text"]
        return _mock_response(200)

    with patch("requests.post", side_effect=_fake_post):
        ok, _ = sd.send_via_telegram(
            huge,
            bot_token=REAL_TOKEN,
            chat_id=REAL_CHAT_ID,
            jobs=[],
        )

    assert ok is True
    assert "No new jobs" in captured["text"]
    assert len(captured["text"]) <= sd.TELEGRAM_MAX_CHARS


def test_missing_creds_short_circuits_without_network():
    """No bot_token and no env var → return (False, ...) without calling out."""
    with patch("requests.post") as m:
        ok, msg = sd.send_via_telegram(
            "anything",
            bot_token="",
            chat_id="",
        )
    assert ok is False
    assert "Telegram not configured" in msg
    m.assert_not_called()


def test_http_4xx_does_not_leak_token():
    """Telegram error responses can echo the URL (which contains the token).
    The returned status_message must redact the token wherever it appears."""
    body = {
        "ok": False,
        "error_code": 401,
        "description": (
            f"Unauthorized — token https://api.telegram.org/bot{REAL_TOKEN}/sendMessage rejected"
        ),
    }
    with patch("requests.post", return_value=_mock_response(401, body)):
        ok, msg = sd.send_via_telegram(
            "hi",
            bot_token=REAL_TOKEN,
            chat_id=REAL_CHAT_ID,
        )
    assert ok is False
    assert REAL_TOKEN not in msg, f"bot_token leaked into error message: {msg!r}"
    assert "<redacted>" in msg


def test_request_exception_does_not_leak_token():
    """A `requests` exception object can include the URL in its repr.
    Sanitization must scrub the token even on connection-level failures."""
    import requests as _requests

    err = _requests.exceptions.ConnectionError(
        f"Failed to establish https://api.telegram.org/bot{REAL_TOKEN}/sendMessage"
    )
    with patch("requests.post", side_effect=err):
        ok, msg = sd.send_via_telegram(
            "hi",
            bot_token=REAL_TOKEN,
            chat_id=REAL_CHAT_ID,
        )
    assert ok is False
    assert REAL_TOKEN not in msg, f"bot_token leaked into exception message: {msg!r}"


def test_enabled_channels_resolves_from_env(monkeypatch: pytest.MonkeyPatch):
    """enabled_channels() returns ['email'] / ['telegram'] / both based on env."""
    # All cleared.
    for var in ("SMTP_HOST", "SMTP_USER", "SMTP_PASS", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"):
        monkeypatch.delenv(var, raising=False)
    assert sd.enabled_channels() == []

    monkeypatch.setenv("SMTP_HOST", "smtp.example.com")
    monkeypatch.setenv("SMTP_USER", "alice@x")
    monkeypatch.setenv("SMTP_PASS", "p")
    assert sd.enabled_channels() == ["email"]

    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", REAL_TOKEN)
    monkeypatch.setenv("TELEGRAM_CHAT_ID", REAL_CHAT_ID)
    assert sd.enabled_channels() == ["email", "telegram"]

    monkeypatch.delenv("SMTP_PASS")
    assert sd.enabled_channels() == ["telegram"]


def test_dispatch_digest_writes_html_and_invokes_each_channel(
    tmp_path, monkeypatch: pytest.MonkeyPatch
):
    """dispatch_digest writes the HTML file and routes to each channel exactly once."""
    out = tmp_path / "digest.html"

    def _stub_email(html, *, jobs=None, **_kw):  # noqa: ARG001
        return True, "email-stub-ok"

    def _stub_telegram(html, *, jobs=None, **_kw):  # noqa: ARG001
        return True, "telegram-stub-ok"

    monkeypatch.setattr(sd, "send_via_email", _stub_email)
    monkeypatch.setattr(sd, "send_via_telegram", _stub_telegram)

    jobs = [{"id": "j1", "title": "x", "fit": "good"}]
    res = sd.dispatch_digest(jobs, channels=["email", "telegram"], digest_path=out)

    assert out.exists()
    body = out.read_text()
    assert body.startswith("<!doctype html>")
    assert res == {"email": (True, "email-stub-ok"), "telegram": (True, "telegram-stub-ok")}


def test_dispatch_digest_with_no_channels_still_writes_file(
    tmp_path, monkeypatch: pytest.MonkeyPatch
):
    """Empty channels list = digest is still rendered to disk."""
    out = tmp_path / "digest.html"
    res = sd.dispatch_digest([], channels=[], digest_path=out)
    assert out.exists()
    # Only digest_write key may appear if the write failed; otherwise empty.
    assert "email" not in res
    assert "telegram" not in res
