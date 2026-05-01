"""Windows Task Scheduler backend via `schtasks.exe`. Picked over PowerShell
`Register-ScheduledTask` (per DESIGN_CROSS_PLATFORM.md §2.4): schtasks ships
with every Windows since XP, has no execution-policy concerns, and avoids
nested-quoting hell when invoked from Python.

The scheduled task invokes the cross-platform `backend/run.py` wrapper —
no shell required."""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

from .base import Scheduler

TASK_NAME = r"\linkedinjobs"


def _run(*argv: str, timeout: int = 8) -> tuple[int, str, str]:
    """schtasks output uses the OEM codepage on Windows, not UTF-8.
    Pass encoding='oem' to avoid garbled output. cpython issues #105312/#71366.
    The 'oem' codec is unavailable off-Windows; fall back to default encoding."""
    try:
        proc = subprocess.run(
            list(argv),
            capture_output=True,
            text=True,
            timeout=timeout,
            encoding="oem",
        )
        return proc.returncode, proc.stdout or "", proc.stderr or ""
    except subprocess.TimeoutExpired as e:
        return 124, e.stdout or "", f"timeout after {timeout}s"
    except FileNotFoundError as e:
        return 127, "", f"command not found: {e.filename}"
    except LookupError:
        proc = subprocess.run(
            list(argv),
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return proc.returncode, proc.stdout or "", proc.stderr or ""


def _format_tr(run_command: list[str]) -> str:
    """schtasks /TR takes a single string. Quote any path containing spaces."""
    if len(run_command) == 1:
        c = run_command[0]
        return f'"{c}"' if " " in c else c
    return " ".join(f'"{c}"' if " " in c else c for c in run_command)


class SchtasksScheduler(Scheduler):
    LABEL = TASK_NAME

    def __init__(
        self,
        working_dir: Path,
        out_log: Path,
        err_log: Path,  # noqa: ARG002 — kept for ABC parity with launchd/systemd
    ):
        self.working_dir = working_dir
        # schtasks has no separate stdout/stderr redirection; run.py writes
        # to run.log directly. Both args accepted for ABC compliance.
        self.out_log = out_log

    @property
    def backend_name(self) -> str:
        return "schtasks"

    @property
    def native_id(self) -> str:
        return TASK_NAME

    def is_installed(self) -> bool:
        rc, _, _ = _run("schtasks", "/Query", "/TN", TASK_NAME)
        return rc == 0

    def is_loaded(self) -> bool:
        # schtasks tasks are always "loaded" once registered (no separate
        # enabled/active distinction unless explicitly disabled). For our
        # purposes, is_installed == is_loaded.
        return self.is_installed()

    def install(
        self,
        interval_seconds: int,
        mode: str,  # noqa: ARG002 — schtasks reads LINKEDINJOBS_MODE from env
        run_command: list[str],
    ) -> None:
        # /MO MINUTE expects integer minutes; round up.
        minutes = max(1, (interval_seconds + 59) // 60)
        rc, _, err = _run(
            "schtasks",
            "/Create",
            "/F",
            "/TN",
            TASK_NAME,
            "/TR",
            _format_tr(run_command),
            "/SC",
            "MINUTE",
            "/MO",
            str(minutes),
            "/RL",
            "HIGHEST",
        )
        if rc != 0:
            raise RuntimeError(f"schtasks /Create failed: {err.strip()}")

    def uninstall(self) -> None:
        _run("schtasks", "/Delete", "/F", "/TN", TASK_NAME)

    def reload(self, interval_seconds: int, mode: str, run_command: list[str]) -> None:
        if not self.is_installed():
            raise RuntimeError("not installed")
        # /Create /F is idempotent — just re-issue.
        self.install(interval_seconds, mode, run_command)

    def last_exit_status(self) -> int | None:
        rc, out, _ = _run("schtasks", "/Query", "/TN", TASK_NAME, "/FO", "LIST", "/V")
        if rc != 0:
            return None
        m = re.search(r"Last Result:\s*(-?\d+)", out)
        return int(m.group(1)) if m else None

    def installed_state(self) -> tuple[int | None, str | None]:
        """schtasks doesn't expose arbitrary task metadata cleanly via CLI.
        Return (None, None) to fall back to scheduler_state.json — that's
        the source of truth when this backend is in use."""
        return None, None
