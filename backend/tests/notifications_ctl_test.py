#!/usr/bin/env python3
"""Smoke test for backend/ctl/notifications_ctl.py.

Verifies the documented JSON-CLI contract without actually contacting any
SMTP server (test-smtp lives in phase_d_test.py's opt-in real-send block).

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

# Sentinel string we use as the "password". If save-smtp ever prints it
# back on stdout/stderr we treat that as a regression; the API explicitly
# promises never to log the password.
SENTINEL_PASSWORD = "do-not-log-this-sentinel-2026"


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
        # 1. status on empty $HOME → ok=True, smtp_configured=False, all blanks.
        p = _run(["python3", str(CTL), "status"], None, env)
        if p.returncode != 0:
            failures.append(f"status (empty home) exit={p.returncode}: {p.stderr[-200:]}")
        try:
            body = json.loads(p.stdout)
        except json.JSONDecodeError as e:
            failures.append(f"status emitted non-JSON: {e}; stdout={p.stdout[-200:]}")
            body = {}
        for key in ("ok", "smtp_configured", "host", "port", "user", "email_to", "ssl"):
            if key not in body:
                failures.append(f"status missing key: {key}")
        if body.get("smtp_configured") is not False:
            failures.append("status (empty home) reported smtp_configured=true")

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

        # 3. status now reports smtp_configured=True with the saved fields.
        p = _run(["python3", str(CTL), "status"], None, env)
        try:
            body = json.loads(p.stdout)
        except json.JSONDecodeError as e:
            failures.append(f"status (configured) emitted non-JSON: {e}")
            body = {}
        if body.get("smtp_configured") is not True:
            failures.append(
                f"status (configured) reported smtp_configured={body.get('smtp_configured')}"
            )
        if body.get("host") != "smtp.example.com":
            failures.append(f"status host={body.get('host')!r}")
        if body.get("user") != "alice@example.com":
            failures.append(f"status user={body.get('user')!r}")
        # Critically, the documented response shape MUST NOT include the password.
        if "password" in body or "smtp_pass" in body or SENTINEL_PASSWORD in p.stdout:
            failures.append("status leaked password value")

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
