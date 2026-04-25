"""macOS launchd backend. Direct extraction of the launchctl/plist code
that used to live inline in scheduler_ctl.py — no behavior change."""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

from .base import Scheduler

LABEL = "com.linkedinjobs"
INSTALLED_PLIST = Path.home() / "Library" / "LaunchAgents" / f"{LABEL}.plist"
LEGACY_LABEL = "com.eliran.linkedinjobs"


def _run(*argv: str, timeout: int = 8) -> tuple[int, str, str]:
    try:
        proc = subprocess.run(
            list(argv), capture_output=True, text=True, timeout=timeout,
        )
        return proc.returncode, proc.stdout, proc.stderr
    except subprocess.TimeoutExpired as e:
        return 124, e.stdout or "", f"timeout after {timeout}s"
    except FileNotFoundError as e:
        return 127, "", f"command not found: {e.filename}"


def _build_plist(
    interval_seconds: int,
    mode: str,
    run_command: list[str],
    working_dir: Path,
    out_log: Path,
    err_log: Path,
) -> str:
    program_args = "\n".join(f"    <string>{c}</string>" for c in run_command)
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{LABEL}</string>

  <key>ProgramArguments</key>
  <array>
{program_args}
  </array>

  <key>WorkingDirectory</key>
  <string>{working_dir}</string>

  <key>StartInterval</key>
  <integer>{interval_seconds}</integer>

  <key>RunAtLoad</key>
  <false/>

  <key>StandardOutPath</key>
  <string>{out_log}</string>

  <key>StandardErrorPath</key>
  <string>{err_log}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>LINKEDINJOBS_MODE</key>
    <string>{mode}</string>
  </dict>
</dict>
</plist>
"""


class LaunchdScheduler(Scheduler):
    LABEL = LABEL  # so callers can read .LABEL on the instance too

    def __init__(self, working_dir: Path, out_log: Path, err_log: Path):
        self.working_dir = working_dir
        self.out_log = out_log
        self.err_log = err_log

    @property
    def backend_name(self) -> str:
        return "launchd"

    @property
    def native_id(self) -> str:
        return str(INSTALLED_PLIST)

    def is_installed(self) -> bool:
        return INSTALLED_PLIST.exists()

    def is_loaded(self) -> bool:
        rc, _, _ = _run("launchctl", "list", LABEL)
        return rc == 0

    def install(self, interval_seconds: int, mode: str, run_command: list[str]) -> None:
        if self.is_loaded():
            self._unload()
        self._unload_legacy()
        self._write_plist(interval_seconds, mode, run_command)
        rc, err = self._load()
        if rc != 0:
            raise RuntimeError(f"launchctl load failed: {err}")

    def uninstall(self) -> None:
        if INSTALLED_PLIST.exists():
            self._unload()
            try:
                INSTALLED_PLIST.unlink()
            except FileNotFoundError:
                pass

    def reload(self, interval_seconds: int, mode: str, run_command: list[str]) -> None:
        if not INSTALLED_PLIST.exists():
            raise RuntimeError("not installed")
        self._unload()
        self._write_plist(interval_seconds, mode, run_command)
        rc, err = self._load()
        if rc != 0:
            raise RuntimeError(f"launchctl load failed: {err}")

    def last_exit_status(self) -> int | None:
        rc, out, _ = _run("launchctl", "list", LABEL)
        if rc != 0:
            return None
        m = re.search(r'"LastExitStatus"\s*=\s*(-?\d+)', out)
        return int(m.group(1)) if m else None

    def installed_state(self) -> tuple[int | None, str | None]:
        if not INSTALLED_PLIST.exists():
            return None, None
        txt = INSTALLED_PLIST.read_text()
        interval_m = re.search(
            r"<key>\s*StartInterval\s*</key>\s*<integer>\s*(\d+)\s*</integer>",
            txt, re.IGNORECASE,
        )
        mode_m = re.search(
            r"<key>\s*LINKEDINJOBS_MODE\s*</key>\s*<string>\s*([a-z]+)\s*</string>",
            txt,
        )
        return (
            int(interval_m.group(1)) if interval_m else None,
            mode_m.group(1) if mode_m else None,
        )

    # ---------- private ----------

    def _write_plist(self, interval_seconds: int, mode: str, run_command: list[str]) -> None:
        INSTALLED_PLIST.parent.mkdir(parents=True, exist_ok=True)
        content = _build_plist(
            interval_seconds, mode, run_command,
            self.working_dir, self.out_log, self.err_log,
        )
        tmp = INSTALLED_PLIST.with_suffix(".plist.tmp")
        tmp.write_text(content)
        tmp.replace(INSTALLED_PLIST)

    def _load(self) -> tuple[int, str]:
        rc, _, err = _run("launchctl", "load", str(INSTALLED_PLIST))
        return rc, err.strip()

    def _unload(self) -> tuple[int, str]:
        rc, _, err = _run("launchctl", "unload", str(INSTALLED_PLIST))
        return rc, err.strip()

    def _unload_legacy(self) -> None:
        """Old installs used `com.eliran.linkedinjobs`. Unload + remove
        if still present so a fresh install under the new generic label
        succeeds without conflict."""
        legacy_plist = Path.home() / "Library" / "LaunchAgents" / f"{LEGACY_LABEL}.plist"
        rc, _, _ = _run("launchctl", "list", LEGACY_LABEL)
        if rc == 0:
            _run("launchctl", "unload", str(legacy_plist))
        if legacy_plist.exists():
            try:
                legacy_plist.unlink()
            except Exception:
                pass
