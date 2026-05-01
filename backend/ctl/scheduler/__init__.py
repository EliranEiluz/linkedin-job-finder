"""OS-dispatched scheduler abstraction for the LinkedIn jobs scraper.

`get_scheduler()` returns the concrete `Scheduler` for the host OS:
launchd on macOS, systemd-user on Linux (when systemd is present),
schtasks on Windows. Adding a new backend = drop a new module here and
extend the dispatch table; nothing else in the codebase changes.
"""

from __future__ import annotations

import platform
import shutil
from pathlib import Path

from .base import Scheduler, SchedulerStatus


def get_scheduler(working_dir: Path, out_log: Path, err_log: Path) -> Scheduler:
    """Pick the right backend for the host. `working_dir`/`out_log`/`err_log`
    are passed in (not hardcoded) so backends stay path-agnostic and unit-
    testable with `tmp_path`."""
    system = platform.system()
    if system == "Darwin":
        from .launchd import LaunchdScheduler

        return LaunchdScheduler(working_dir, out_log, err_log)
    if system == "Linux":
        if shutil.which("systemctl"):
            from .systemd_user import SystemdUserScheduler

            return SystemdUserScheduler(working_dir, out_log, err_log)
        raise RuntimeError(
            "Linux without systemd is not supported. Install systemd or use cron manually."
        )
    if system == "Windows":
        from .schtasks import SchtasksScheduler

        return SchtasksScheduler(working_dir, out_log, err_log)
    raise RuntimeError(f"Unsupported platform: {system}")


__all__ = ["Scheduler", "SchedulerStatus", "get_scheduler"]
