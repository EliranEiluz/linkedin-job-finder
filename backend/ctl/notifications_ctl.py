#!/usr/bin/env python3
"""
Notifications CLI for the welcome wizard. Three commands:

  status     — no stdin → returns SMTP config presence (never the password).
  save-smtp  — {host, port, user, password, email_to?, use_ssl?} on stdin →
               atomic-writes SMTP_* vars into ~/.linkedin-jobs.env (chmod 600).
  test-smtp  — no stdin → reads creds from env, sends a one-paragraph test
               email to EMAIL_TO. Reuses backend.send_email's SMTP path.

Same JSON CLI conventions as llm_ctl.py: read JSON from stdin, emit one JSON
envelope on stdout, exit 0/1. NEVER logs the password (not even on error) —
error messages reference env-var names only.
"""

from __future__ import annotations

import argparse
import os
import sys
from email.message import EmailMessage
from pathlib import Path

HERE = Path(__file__).resolve().parent  # backend/ctl/
ROOT = HERE.parent.parent
sys.path.insert(0, str(HERE))  # → backend/ctl/  (for _common)
sys.path.insert(0, str(HERE.parent))  # → backend/
sys.path.insert(0, str(ROOT))  # so `from backend...` resolves

from _common import (  # noqa: E402  (sys.path shim above)
    atomic_write_env_var,
    load_env_file,
    read_stdin_json,
)
from _common import emit as _emit  # noqa: E402  (sys.path shim above)

ENV_FILE = Path.home() / ".linkedin-jobs.env"

# Hard timeout shared between SMTP connect, login, send. Wizard "Test connection"
# button is interactive — anything beyond ~30s feels broken to the user. The
# vite middleware also enforces its own outer cap; this is the inner-loop bound.
SMTP_TIMEOUT_S = 30

# Names of the env vars we manage. Single source of truth so save-smtp and
# status agree on the exact keys (the typo-bug magnet of repeating string
# literals across two files).
SMTP_VARS = ("SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "EMAIL_TO", "SMTP_USE_SSL")


def _read_env_vars() -> dict[str, str]:
    """Parse `~/.linkedin-jobs.env` into a flat {KEY: value} dict.

    Returns an empty dict if the file is missing or unreadable. Mirrors the
    parser in `_common.load_env_file` but doesn't mutate `os.environ` —
    `status` only needs to surface what's stored, not activate it.
    """
    out: dict[str, str] = {}
    if not ENV_FILE.exists():
        return out
    try:
        for raw in ENV_FILE.read_text().splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            if line.startswith("export "):
                line = line[len("export ") :].lstrip()
            k, _, v = line.partition("=")
            k = k.strip()
            v = v.strip().strip('"').strip("'")
            if k:
                out[k] = v
    except Exception:
        # Surface what we can; don't crash the wizard over a malformed file.
        return out
    return out


def cmd_status() -> None:
    """Report SMTP configuration without ever leaking the password."""
    env = _read_env_vars()
    has_pass = bool(env.get("SMTP_PASS", "").strip())
    host = env.get("SMTP_HOST", "")
    port_raw = env.get("SMTP_PORT", "").strip()
    user = env.get("SMTP_USER", "")
    email_to = env.get("EMAIL_TO", "") or user
    ssl_raw = env.get("SMTP_USE_SSL", "").strip().lower()
    use_ssl = ssl_raw in ("1", "true", "yes")
    # Configured = at minimum host+user+password. Port has a default (587).
    smtp_configured = bool(host and user and has_pass)
    try:
        port: int | None = int(port_raw) if port_raw else None
    except ValueError:
        port = None
    _emit(
        {
            "ok": True,
            "smtp_configured": smtp_configured,
            "host": host,
            "port": port,
            "user": user,
            "email_to": email_to,
            "ssl": use_ssl,
            "env_file": str(ENV_FILE),
        }
    )


def _validate_save_payload(body: dict) -> tuple[str, int, str, str, str, bool]:
    """Validate + coerce the save-smtp payload. Raises TypeError / ValueError.

    TypeError = field has the wrong JSON type (e.g. port is a list).
    ValueError = field has the right type but a bad value (e.g. port out of
    range, host blank). The caller catches both as a single 400 response —
    splitting them just keeps ruff's TRY004 happy without leaking JSON-
    schema vs. business-rule complexity into the error envelope.

    Password may be empty — `cmd_save_smtp` decides whether that means
    "leave the saved one alone"; this helper just reports it.
    """
    host = body.get("host")
    if not isinstance(host, str):
        raise TypeError("host must be a string")
    if not host.strip():
        raise ValueError("host must be non-empty")
    port_raw = body.get("port", 587)
    if isinstance(port_raw, str):
        try:
            port = int(port_raw)
        except ValueError as e:
            raise ValueError(f"port must be an integer 1-65535, got '{port_raw}'") from e
    elif isinstance(port_raw, int) and not isinstance(port_raw, bool):
        port = port_raw
    else:
        raise TypeError("port must be an integer 1-65535")
    if not (1 <= port <= 65535):
        raise ValueError(f"port must be 1-65535, got {port}")
    user = body.get("user")
    if not isinstance(user, str):
        raise TypeError("user must be a string")
    if not user.strip():
        raise ValueError("user must be non-empty")
    password = body.get("password", "")
    if not isinstance(password, str):
        raise TypeError("password must be a string")
    email_to_raw = body.get("email_to", "")
    if not isinstance(email_to_raw, str):
        raise TypeError("email_to must be a string")
    email_to = email_to_raw.strip() or user.strip()
    use_ssl_raw = body.get("use_ssl", port == 465)
    if isinstance(use_ssl_raw, bool):
        use_ssl = use_ssl_raw
    elif isinstance(use_ssl_raw, str):
        use_ssl = use_ssl_raw.strip().lower() in ("1", "true", "yes")
    else:
        raise TypeError("use_ssl must be a boolean")
    return host.strip(), port, user.strip(), password, email_to, use_ssl


def cmd_save_smtp() -> None:
    """Persist SMTP_* vars to ~/.linkedin-jobs.env. Empty password = keep saved.

    NEVER echoes the password back. Errors reference env var names only — the
    same hygiene policy as llm_ctl.save-credential.
    """
    try:
        body = read_stdin_json()
    except Exception as e:
        _emit({"ok": False, "error": f"bad stdin: {e}"}, code=1)
    try:
        host, port, user, password, email_to, use_ssl = _validate_save_payload(body)
    except (TypeError, ValueError) as e:
        _emit({"ok": False, "error": str(e)}, code=1)
    # If the caller sent an empty password, preserve the saved one. This is
    # how the UI lets the user re-save host/port without re-typing the
    # app-password every time.
    if not password.strip():
        existing = _read_env_vars()
        password = existing.get("SMTP_PASS", "")
        if not password:
            _emit(
                {
                    "ok": False,
                    "error": "password missing — no saved SMTP_PASS to fall back to",
                },
                code=1,
            )
    try:
        atomic_write_env_var(ENV_FILE, "SMTP_HOST", host)
        atomic_write_env_var(ENV_FILE, "SMTP_PORT", str(port))
        atomic_write_env_var(ENV_FILE, "SMTP_USER", user)
        atomic_write_env_var(ENV_FILE, "SMTP_PASS", password)
        atomic_write_env_var(ENV_FILE, "EMAIL_TO", email_to)
        atomic_write_env_var(ENV_FILE, "SMTP_USE_SSL", "1" if use_ssl else "0")
    except Exception as e:
        # Error message refers to the env-var names, NEVER the password.
        _emit(
            {
                "ok": False,
                "error": f"failed to write {ENV_FILE} (SMTP_*): {type(e).__name__}: {e}",
            },
            code=1,
        )
    # Also expose the new vars to the same-process test-smtp that may follow.
    os.environ["SMTP_HOST"] = host
    os.environ["SMTP_PORT"] = str(port)
    os.environ["SMTP_USER"] = user
    os.environ["SMTP_PASS"] = password
    os.environ["EMAIL_TO"] = email_to
    os.environ["SMTP_USE_SSL"] = "1" if use_ssl else "0"
    _emit(
        {
            "ok": True,
            "env_file": str(ENV_FILE),
            "vars_written": list(SMTP_VARS),
        }
    )


def _build_test_message(user: str, to_addr: str) -> EmailMessage:
    """One-paragraph plaintext + HTML test email. No personal data."""
    msg = EmailMessage()
    msg["Subject"] = "linkedin-job-finder — SMTP test"
    msg["From"] = user
    msg["To"] = to_addr
    msg.set_content(
        "This is a test message from the linkedin-job-finder Setup wizard. "
        "If you are reading this in your inbox, your SMTP credentials are "
        "wired up correctly and future scrape digests will arrive here."
    )
    msg.add_alternative(
        "<p style=\"font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;"
        'font-size:14px;color:#111827;line-height:1.5">'
        "This is a test message from the <strong>linkedin-job-finder</strong> "
        "Setup wizard. If you are reading this in your inbox, your SMTP "
        "credentials are wired up correctly and future scrape digests will "
        "arrive here.</p>",
        subtype="html",
    )
    return msg


def cmd_test_smtp() -> None:
    """Send a one-paragraph test email via the saved SMTP creds.

    Reuses the same SMTPS-vs-STARTTLS branching as backend.send_email so the
    test result faithfully predicts what the digest send will do.
    """
    # Pull the just-saved env vars off disk (the wizard does save → test in
    # rapid succession; if the user restarted between save and test, the
    # parent shell wouldn't have them either).
    load_env_file(ENV_FILE)
    host = os.environ.get("SMTP_HOST", "").strip()
    user = os.environ.get("SMTP_USER", "").strip()
    password = os.environ.get("SMTP_PASS", "")
    if not (host and user and password):
        _emit(
            {
                "ok": False,
                "error": "SMTP not configured — set SMTP_HOST / SMTP_USER / SMTP_PASS first",
            },
            code=1,
        )
    try:
        port = int(os.environ.get("SMTP_PORT", "587"))
    except ValueError:
        _emit({"ok": False, "error": "SMTP_PORT is not a valid integer"}, code=1)
    to_addr = os.environ.get("EMAIL_TO", "").strip() or user
    msg = _build_test_message(user, to_addr)
    # Late-import so the `status` and `save-smtp` paths don't pay the import
    # cost of smtplib + ssl + certifi just to write env vars.
    import smtplib
    import ssl

    try:
        import certifi

        ctx = ssl.create_default_context(cafile=certifi.where())
    except Exception:
        ctx = ssl.create_default_context()

    use_ssl = (
        os.environ.get("SMTP_USE_SSL", "").strip().lower() in ("1", "true", "yes") or port == 465
    )
    try:
        if use_ssl:
            with smtplib.SMTP_SSL(host, port, timeout=SMTP_TIMEOUT_S, context=ctx) as smtp:
                smtp.login(user, password)
                smtp.send_message(msg)
        else:
            with smtplib.SMTP(host, port, timeout=SMTP_TIMEOUT_S) as smtp:
                smtp.ehlo()
                smtp.starttls(context=ctx)
                smtp.login(user, password)
                smtp.send_message(msg)
    except Exception as e:
        # The exception type + message can mention host/port (helpful), but
        # smtplib never includes the password in its repr.
        _emit(
            {
                "ok": False,
                "error": f"SMTP {type(e).__name__}: {e}",
                "host": host,
                "port": port,
                "ssl": use_ssl,
            },
            code=1,
        )
    _emit(
        {
            "ok": True,
            "message": f"Sent test email to {to_addr}",
            "host": host,
            "port": port,
            "ssl": use_ssl,
        }
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd")
    sub.add_parser("status")
    sub.add_parser("save-smtp")
    sub.add_parser("test-smtp")
    args = parser.parse_args()
    if args.cmd == "status":
        cmd_status()
    if args.cmd == "save-smtp":
        cmd_save_smtp()
    if args.cmd == "test-smtp":
        cmd_test_smtp()
    parser.print_help()
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as e:
        _emit({"ok": False, "error": f"{type(e).__name__}: {e}"}, code=1)
