#!/usr/bin/env python3
"""Smoke test for backend/ctl/notifications_ctl.py.

Verifies the documented JSON-CLI contract without actually contacting any
SMTP server or the Telegram API (test-smtp lives in phase_d_test.py's
opt-in real-send block; test-telegram is exercised via mocking in
test_notifications_telegram.py).

Runs against an isolated $HOME under /tmp so the developer's real
~/.linkedin-jobs.env is never touched. Exit code 0 = pass, 1 = fail.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

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


def main() -> int:
    failures: list[str] = []
    tmp_home = Path(tempfile.mkdtemp(prefix="notif-ctl-test-"))
    env = dict(os.environ)
    env["HOME"] = str(tmp_home)

    try:
        # 1. status on empty $HOME → ok=True, channels.email.configured=False,
        #    channels.telegram.configured=False, all blanks.
        p = _run(["python3", str(CTL), "status"], None, env)
        if p.returncode != 0:
            failures.append(f"status (empty home) exit={p.returncode}: {p.stderr[-200:]}")
        try:
            body = json.loads(p.stdout)
        except json.JSONDecodeError as e:
            failures.append(f"status emitted non-JSON: {e}; stdout={p.stdout[-200:]}")
            body = {}
        for key in ("ok", "channels", "env_file"):
            if key not in body:
                failures.append(f"status missing top-level key: {key}")
        channels = body.get("channels", {})
        if not isinstance(channels, dict):
            failures.append(f"status.channels is not a dict: {type(channels).__name__}")
            channels = {}
        email = channels.get("email", {})
        for key in ("configured", "host", "port", "user", "email_to", "ssl"):
            if key not in email:
                failures.append(f"status.channels.email missing: {key}")
        if email.get("configured") is not False:
            failures.append("status (empty home) reported email.configured=true")
        telegram = channels.get("telegram", {})
        for key in ("configured", "chat_id"):
            if key not in telegram:
                failures.append(f"status.channels.telegram missing: {key}")
        if telegram.get("configured") is not False:
            failures.append("status (empty home) reported telegram.configured=true")

        # 2. save-smtp writes the env file with all 6 SMTP_* vars + chmod 600.
        payload = json.dumps(
            {
                "host": "smtp.example.com",
                "port": 587,
                "user": "alice@example.com",
                "password": SENTINEL_PASSWORD,
                "email_to": "bob@example.com",
                "use_ssl": False,
            }
        )
        p = _run(["python3", str(CTL), "save-smtp"], payload, env)
        if p.returncode != 0:
            failures.append(f"save-smtp exit={p.returncode}: {p.stderr[-200:]}")
        # Crucial: password must NOT appear in either stream.
        if SENTINEL_PASSWORD in p.stdout:
            failures.append("save-smtp leaked password on stdout")
        if SENTINEL_PASSWORD in p.stderr:
            failures.append("save-smtp leaked password on stderr")

        env_file = tmp_home / ".linkedin-jobs.env"
        if not env_file.exists():
            failures.append(f"env file not written at {env_file}")
        else:
            text = env_file.read_text()
            for var in (
                "SMTP_HOST",
                "SMTP_PORT",
                "SMTP_USER",
                "SMTP_PASS",
                "EMAIL_TO",
                "SMTP_USE_SSL",
            ):
                if f"{var}=" not in text:
                    failures.append(f"env file missing {var}=")
            mode = env_file.stat().st_mode & 0o777
            if mode != 0o600:
                failures.append(f"env file mode is 0o{mode:o}, expected 0o600")

        # 3. status now reports email.configured=True with the saved fields.
        p = _run(["python3", str(CTL), "status"], None, env)
        try:
            body = json.loads(p.stdout)
        except json.JSONDecodeError as e:
            failures.append(f"status (configured) emitted non-JSON: {e}")
            body = {}
        email = body.get("channels", {}).get("email", {})
        if email.get("configured") is not True:
            failures.append(f"status (configured) email.configured={email.get('configured')}")
        if email.get("host") != "smtp.example.com":
            failures.append(f"status email.host={email.get('host')!r}")
        if email.get("user") != "alice@example.com":
            failures.append(f"status email.user={email.get('user')!r}")
        # Critically, the documented response shape MUST NOT include the password.
        if SENTINEL_PASSWORD in p.stdout:
            failures.append("status leaked password value")
        if "password" in email or "smtp_pass" in email:
            failures.append("status returned a 'password' field on the email channel")

        # 4. save-smtp with empty password preserves the saved one.
        payload = json.dumps(
            {
                "host": "smtp2.example.com",
                "port": 465,
                "user": "alice@example.com",
                "password": "",
            }
        )
        p = _run(["python3", str(CTL), "save-smtp"], payload, env)
        if p.returncode != 0:
            failures.append(f"save-smtp (empty pass) exit={p.returncode}: {p.stderr[-200:]}")
        text = env_file.read_text()
        if f"SMTP_PASS={SENTINEL_PASSWORD}" not in text:
            failures.append("empty password didn't preserve the saved SMTP_PASS")
        if "SMTP_USE_SSL=1" not in text:
            failures.append("port 465 didn't auto-enable SMTP_USE_SSL")

        # 5. Reject invalid payload (missing host).
        p = _run(["python3", str(CTL), "save-smtp"], json.dumps({"user": "x@y.z"}), env)
        if p.returncode == 0:
            failures.append("save-smtp accepted payload with no host")

        # 6. save-telegram writes the env file with both TELEGRAM_* vars.
        payload = json.dumps(
            {
                "bot_token": SENTINEL_BOT_TOKEN,
                "chat_id": "12345678",
            }
        )
        p = _run(["python3", str(CTL), "save-telegram"], payload, env)
        if p.returncode != 0:
            failures.append(f"save-telegram exit={p.returncode}: {p.stderr[-200:]}")
        if SENTINEL_BOT_TOKEN in p.stdout:
            failures.append("save-telegram leaked bot_token on stdout")
        if SENTINEL_BOT_TOKEN in p.stderr:
            failures.append("save-telegram leaked bot_token on stderr")
        text = env_file.read_text()
        for var in ("TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"):
            if f"{var}=" not in text:
                failures.append(f"env file missing {var}=")

        # 7. status now reports telegram.configured=True with chat_id only.
        p = _run(["python3", str(CTL), "status"], None, env)
        body = json.loads(p.stdout)
        telegram = body.get("channels", {}).get("telegram", {})
        if telegram.get("configured") is not True:
            failures.append(f"status telegram.configured={telegram.get('configured')}")
        if telegram.get("chat_id") != "12345678":
            failures.append(f"status telegram.chat_id={telegram.get('chat_id')!r}")
        # The bot_token MUST NOT round-trip through status.
        if SENTINEL_BOT_TOKEN in p.stdout:
            failures.append("status leaked bot_token value")
        if "bot_token" in telegram:
            failures.append("status returned a 'bot_token' field on the telegram channel")

        # 8. save-telegram with empty bot_token preserves the saved one.
        payload = json.dumps({"bot_token": "", "chat_id": "99999"})
        p = _run(["python3", str(CTL), "save-telegram"], payload, env)
        if p.returncode != 0:
            failures.append(f"save-telegram (empty token) exit={p.returncode}: {p.stderr[-200:]}")
        text = env_file.read_text()
        if f"TELEGRAM_BOT_TOKEN={SENTINEL_BOT_TOKEN}" not in text:
            failures.append("empty bot_token didn't preserve the saved TELEGRAM_BOT_TOKEN")
        if "TELEGRAM_CHAT_ID=99999" not in text:
            failures.append("save-telegram didn't update chat_id")

        # 9. Reject save-telegram with empty chat_id.
        p = _run(
            ["python3", str(CTL), "save-telegram"],
            json.dumps({"bot_token": SENTINEL_BOT_TOKEN, "chat_id": ""}),
            env,
        )
        if p.returncode == 0:
            failures.append("save-telegram accepted empty chat_id")

        # 10. test-telegram with no env vars set returns a clean error.
        bare_env = dict(os.environ)
        bare_env["HOME"] = str(Path(tempfile.mkdtemp(prefix="notif-bare-")))
        p = _run(["python3", str(CTL), "test-telegram"], None, bare_env)
        if p.returncode == 0:
            failures.append("test-telegram succeeded with no creds")
        try:
            body = json.loads(p.stdout)
            if body.get("ok") is not False:
                failures.append("test-telegram (no creds) didn't return ok=false")
        except json.JSONDecodeError:
            failures.append(f"test-telegram (no creds) emitted non-JSON: {p.stdout[-200:]}")
        shutil.rmtree(bare_env["HOME"], ignore_errors=True)

    finally:
        shutil.rmtree(tmp_home, ignore_errors=True)

    if failures:
        print("FAIL", file=sys.stderr)
        for f in failures:
            print(f"  - {f}", file=sys.stderr)
        return 1
    print(f"OK — notifications_ctl smoke ({CTL.name})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
