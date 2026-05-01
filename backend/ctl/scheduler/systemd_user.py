"""Linux systemd-user backend. Writes a .service + .timer unit pair to
~/.config/systemd/user/ and manages them with `systemctl --user` (no root).
Requires systemd; falls back to cron is not implemented (Alpine, OpenWrt
users would need to set up cron manually).

Design choice (per DESIGN_CROSS_PLATFORM.md §2.4): systemd-user over cron
because it (a) requires no root, (b) gets journald logging via
`journalctl --user -u linkedinjobs`, (c) provides Persistent=true for
missed-run catch-up — none of which cron offers out of the box.
"""

from __future__ import annotations

import contextlib
import shlex
import subprocess
from pathlib import Path

from .base import Scheduler

UNIT_NAME = "linkedinjobs"
UNITS_DIR = Path.home() / ".config" / "systemd" / "user"
SERVICE_PATH = UNITS_DIR / f"{UNIT_NAME}.service"
TIMER_PATH = UNITS_DIR / f"{UNIT_NAME}.timer"
ENV_FILE = Path.home() / ".linkedin-jobs.env"


def _run(*argv: str, timeout: int = 8) -> tuple[int, str, str]:
    try:
        proc = subprocess.run(
            list(argv),
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return proc.returncode, proc.stdout, proc.stderr
    except subprocess.TimeoutExpired as e:
        return 124, e.stdout or "", f"timeout after {timeout}s"
    except FileNotFoundError as e:
        return 127, "", f"command not found: {e.filename}"


def _service_unit(working_dir: Path, run_command: list[str], mode: str, log_path: Path) -> str:
    quoted_cmd = " ".join(shlex.quote(c) for c in run_command)
    return f"""[Unit]
Description=LinkedIn job scraper

[Service]
Type=oneshot
WorkingDirectory={working_dir}
ExecStart={quoted_cmd}
StandardOutput=append:{log_path}
StandardError=append:{log_path}
EnvironmentFile=-{ENV_FILE}
Environment=LINKEDINJOBS_MODE={mode}
"""


def _timer_unit(interval_seconds: int) -> str:
    return f"""[Unit]
Description=LinkedIn job scraper timer

[Timer]
OnBootSec={interval_seconds}s
OnUnitActiveSec={interval_seconds}s
Persistent=true

[Install]
WantedBy=timers.target
"""


class SystemdUserScheduler(Scheduler):
    LABEL = UNIT_NAME

    def __init__(
        self,
        working_dir: Path,
        out_log: Path,
        err_log: Path,  # noqa: ARG002 — systemd writes unified output to out_log
    ):
        self.working_dir = working_dir
        # systemd writes unified output via a single StandardOutput= path;
        # err_log is unused (errors append to the same file as stdout).
        self.log_path = out_log

    @property
    def backend_name(self) -> str:
        return "systemd-user"

    @property
    def native_id(self) -> str:
        return str(TIMER_PATH)

    def is_installed(self) -> bool:
        return SERVICE_PATH.exists() and TIMER_PATH.exists()

    def is_loaded(self) -> bool:
        rc, out, _ = _run("systemctl", "--user", "is-active", f"{UNIT_NAME}.timer")
        return rc == 0 and "active" in out

    def install(self, interval_seconds: int, mode: str, run_command: list[str]) -> None:
        UNITS_DIR.mkdir(parents=True, exist_ok=True)
        SERVICE_PATH.write_text(_service_unit(self.working_dir, run_command, mode, self.log_path))
        TIMER_PATH.write_text(_timer_unit(interval_seconds))
        rc, _, err = _run("systemctl", "--user", "daemon-reload")
        if rc != 0:
            raise RuntimeError(f"systemctl daemon-reload failed: {err.strip()}")
        rc, _, err = _run("systemctl", "--user", "enable", "--now", f"{UNIT_NAME}.timer")
        if rc != 0:
            raise RuntimeError(f"systemctl enable failed: {err.strip()}")

    def uninstall(self) -> None:
        _run("systemctl", "--user", "disable", "--now", f"{UNIT_NAME}.timer")
        _run("systemctl", "--user", "stop", f"{UNIT_NAME}.service")
        for p in (SERVICE_PATH, TIMER_PATH):
            with contextlib.suppress(FileNotFoundError):
                p.unlink()
        _run("systemctl", "--user", "daemon-reload")

    def reload(self, interval_seconds: int, mode: str, run_command: list[str]) -> None:
        if not self.is_installed():
            raise RuntimeError("not installed")
        SERVICE_PATH.write_text(_service_unit(self.working_dir, run_command, mode, self.log_path))
        TIMER_PATH.write_text(_timer_unit(interval_seconds))
        rc, _, err = _run("systemctl", "--user", "daemon-reload")
        if rc != 0:
            raise RuntimeError(f"daemon-reload failed: {err.strip()}")
        _run("systemctl", "--user", "restart", f"{UNIT_NAME}.timer")

    def last_exit_status(self) -> int | None:
        rc, out, _ = _run(
            "systemctl",
            "--user",
            "show",
            f"{UNIT_NAME}.service",
            "--property=ExecMainStatus",
            "--value",
        )
        if rc != 0:
            return None
        try:
            return int(out.strip())
        except ValueError:
            return None

    def installed_state(self) -> tuple[int | None, str | None]:
        """Parse interval (timer) and mode (service) from the on-disk units."""
        if not (SERVICE_PATH.exists() and TIMER_PATH.exists()):
            return None, None
        interval: int | None = None
        for line in TIMER_PATH.read_text().splitlines():
            if line.startswith("OnUnitActiveSec="):
                val = line.partition("=")[2].strip()
                if val.endswith("s"):
                    val = val[:-1]
                with contextlib.suppress(ValueError):
                    interval = int(val)
                break
        mode: str | None = None
        for line in SERVICE_PATH.read_text().splitlines():
            if line.startswith("Environment=LINKEDINJOBS_MODE="):
                # split: ['Environment', 'LINKEDINJOBS_MODE', 'guest']
                parts = line.split("=", 2)
                if len(parts) == 3:
                    mode = parts[2].strip()
                break
        return interval, mode
