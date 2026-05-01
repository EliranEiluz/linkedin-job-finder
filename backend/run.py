#!/usr/bin/env python3
"""Cross-platform launcher invoked by the scheduler (launchd / systemd /
schtasks). Loads ~/.linkedin-jobs.env, runs search.py, then send_email.py
— same behavior on macOS, Linux, and Windows.

The scheduler backends pass `[sys.executable, "<root>/backend/run.py"]`
as their ProgramArguments / ExecStart / TR. Trigger `scheduler reload`
from the UI after upgrading from a pre-2026-04 install so any old
plist/unit files get regenerated to point here.
"""

from __future__ import annotations

import contextlib
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent  # project root
LOG = ROOT / "run.log"
ENV_FILE = Path.home() / ".linkedin-jobs.env"
SEARCH = ROOT / "backend" / "search.py"
SEND_EMAIL = ROOT / "backend" / "send_email.py"

LOG_ROTATE_BYTES = 2_000_000  # 2 MB


def _load_env(path: Path) -> None:
    """Parse KEY=VALUE lines (no shell expansion). Mirrors `set -a; source`
    semantics: file values do NOT override env vars already set by the
    scheduler (e.g. LINKEDINJOBS_MODE in the launchd plist's
    EnvironmentVariables block)."""
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        k = k.strip()
        v = v.strip()
        # Strip optional surrounding quotes (matches `KEY="value"` shell idiom)
        if len(v) >= 2 and v[0] == v[-1] and v[0] in ("'", '"'):
            v = v[1:-1]
        os.environ.setdefault(k, v)


def _ts() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _log(msg: str) -> None:
    line = f"[{_ts()}] {msg}\n"
    with LOG.open("a", encoding="utf-8") as f:
        f.write(line)


def _rotate_log() -> None:
    if LOG.exists() and LOG.stat().st_size > LOG_ROTATE_BYTES:
        with contextlib.suppress(OSError):
            LOG.replace(LOG.with_suffix(".log.1"))


def main() -> int:
    _load_env(ENV_FILE)
    _rotate_log()
    mode = os.environ.get("LINKEDINJOBS_MODE", "guest")
    _log(f"=== run start === mode={mode}")

    rc = subprocess.run(
        [sys.executable, str(SEARCH), f"--mode={mode}"],
        cwd=ROOT,
    ).returncode
    _log(f"search.py exit={rc}")
    if rc != 0:
        _log("search failed, skipping email")
        _log("=== run end ===")
        return rc

    rc = subprocess.run(
        [sys.executable, str(SEND_EMAIL)],
        cwd=ROOT,
    ).returncode
    _log(f"send_email.py exit={rc}")
    _log("=== run end ===")
    return rc


if __name__ == "__main__":
    sys.exit(main())
