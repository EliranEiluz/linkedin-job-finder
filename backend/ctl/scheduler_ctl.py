#!/usr/bin/env python3
"""
LaunchAgent control surface for the LinkedIn jobs scraper. Wraps macOS
`launchctl` and the plist file with a stable JSON CLI that the UI's Vite
middleware can shell to without needing to know launchd's quirks.

Commands (all emit a single JSON object on stdout, exit 0 on success):

  python3 scheduler_ctl.py status
      -> { ok, installed, loaded, interval_seconds, interval_label,
           mode, last_run, next_run_estimate, log_tail, plist_path,
           errors }

  python3 scheduler_ctl.py install
      -> copies the in-repo plist into ~/Library/LaunchAgents and
         `launchctl load`s it. Idempotent.

  python3 scheduler_ctl.py uninstall
      -> `launchctl unload` + removes the plist from ~/Library/LaunchAgents.
         Leaves the in-repo plist alone.

  python3 scheduler_ctl.py reload
      -> unload + load (call after editing the plist or run.sh).

  python3 scheduler_ctl.py set-interval <seconds>
      -> rewrite StartInterval in BOTH the in-repo plist and (if installed)
         the LaunchAgents copy, then reload. seconds must be 60..2592000.

  python3 scheduler_ctl.py set-mode <loggedin|guest>
      -> rewrite LINKEDINJOBS_MODE in both plists' EnvironmentVariables;
         no reload needed (env vars take effect on the next fire).

Failures emit { "ok": false, "error": "...", ... } and exit 1.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent  # backend/ctl/
ROOT = HERE.parent.parent               # project root
LABEL = "com.linkedinjobs"              # de-personalized 2026-04
INSTALLED_PLIST = Path.home() / "Library" / "LaunchAgents" / f"{LABEL}.plist"
RUN_SCRIPT = ROOT / "backend" / "launchd" / "run.sh"

# Persistent state for the in-memory plist (interval + mode). The plist
# template is GENERATED at install time from these — there is no on-disk
# template file. Defaults match the prior shipped behavior.
SCHED_STATE_FILE = ROOT / "scheduler_state.json"
DEFAULT_INTERVAL = 43_200   # 12 h
DEFAULT_MODE = "guest"

# Files used to surface "last run" state. All at project ROOT (where
# launchd writes them and where run.sh appends to run.log).
LAUNCHD_OUT_LOG = ROOT / "launchd.out.log"
LAUNCHD_ERR_LOG = ROOT / "launchd.err.log"
RUN_LOG = ROOT / "run.log"


def _read_sched_state() -> dict:
    """Load persisted interval + mode. Falls back to defaults if missing."""
    if not SCHED_STATE_FILE.exists():
        return {"interval_seconds": DEFAULT_INTERVAL, "mode": DEFAULT_MODE}
    try:
        d = json.loads(SCHED_STATE_FILE.read_text())
        return {
            "interval_seconds": int(d.get("interval_seconds", DEFAULT_INTERVAL)),
            "mode": str(d.get("mode", DEFAULT_MODE)),
        }
    except Exception:
        return {"interval_seconds": DEFAULT_INTERVAL, "mode": DEFAULT_MODE}


def _write_sched_state(state: dict) -> None:
    SCHED_STATE_FILE.write_text(json.dumps(state, indent=2))


def _build_plist(interval_seconds: int, mode: str) -> str:
    """Generate the LaunchAgent plist content as a string. No template file
    on disk — paths are computed at install time using THIS machine's project
    root, so a friend cloning the repo gets a plist that points at THEIR
    paths automatically."""
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>{RUN_SCRIPT}</string>
  </array>

  <key>WorkingDirectory</key>
  <string>{ROOT}</string>

  <key>StartInterval</key>
  <integer>{interval_seconds}</integer>

  <key>RunAtLoad</key>
  <false/>

  <key>StandardOutPath</key>
  <string>{LAUNCHD_OUT_LOG}</string>

  <key>StandardErrorPath</key>
  <string>{LAUNCHD_ERR_LOG}</string>

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

INTERVAL_LABELS = {
    3600: "1 h", 7200: "2 h", 14400: "4 h", 21600: "6 h",
    43200: "12 h", 86400: "24 h", 172800: "48 h",
}

# ---------- helpers ----------

def _run(*argv: str, check: bool = False, timeout: int = 8) -> tuple[int, str, str]:
    """Run a subprocess and return (rc, stdout, stderr). Never raises unless check."""
    try:
        proc = subprocess.run(
            list(argv), capture_output=True, text=True, timeout=timeout,
        )
    except subprocess.TimeoutExpired as e:
        return 124, e.stdout or "", f"timeout after {timeout}s"
    except FileNotFoundError as e:
        return 127, "", f"command not found: {e.filename}"
    if check and proc.returncode != 0:
        raise RuntimeError(
            f"{argv[0]} exit={proc.returncode}: {proc.stderr.strip()[:300]}"
        )
    return proc.returncode, proc.stdout, proc.stderr


def _emit(obj: dict, code: int = 0):
    """Print one JSON object and exit with the given code."""
    print(json.dumps(obj, indent=2, ensure_ascii=False))
    sys.exit(code)


# ---------- plist state ----------
#
# Reorg note (2026-04): there is no longer a SOURCE_PLIST file in the repo.
# The plist is GENERATED on demand by `_build_plist()` (above) using the
# state held in `scheduler_state.json` (interval + mode) plus the runtime-
# computed paths. This makes the install path machine-portable: a friend
# cloning into a different home directory gets a plist that points at THEIR
# paths automatically.


def _installed_state() -> tuple[int | None, str | None]:
    """Best-effort read of (interval, mode) FROM the live LaunchAgent file.
    Used to verify what's actually scheduled vs. what state thinks. Returns
    (None, None) if the LaunchAgent isn't installed."""
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


def _write_installed_plist(interval_seconds: int, mode: str) -> None:
    """Render the plist content and atomic-write to the installed location."""
    INSTALLED_PLIST.parent.mkdir(parents=True, exist_ok=True)
    content = _build_plist(interval_seconds, mode)
    tmp = INSTALLED_PLIST.with_suffix(".plist.tmp")
    tmp.write_text(content)
    tmp.replace(INSTALLED_PLIST)


# ---------- launchctl ----------

def _is_loaded() -> bool:
    rc, out, _ = _run("launchctl", "list", LABEL)
    return rc == 0


def _last_exit_status_from_launchctl() -> int | None:
    """Pull LastExitStatus from `launchctl list <label>` if present."""
    rc, out, _ = _run("launchctl", "list", LABEL)
    if rc != 0:
        return None
    m = re.search(r'"LastExitStatus"\s*=\s*(-?\d+)', out)
    return int(m.group(1)) if m else None


def _load() -> tuple[int, str]:
    rc, _, err = _run("launchctl", "load", str(INSTALLED_PLIST))
    return rc, err.strip()


def _unload() -> tuple[int, str]:
    rc, _, err = _run("launchctl", "unload", str(INSTALLED_PLIST))
    return rc, err.strip()


# ---------- last/next run estimation ----------

def _last_run_iso() -> str | None:
    """Best-effort 'last run' timestamp. Prefers launchd.out.log mtime
    (reliable: launchd writes/touches it on every fire); falls back to
    run.log if that's not present."""
    for p in (LAUNCHD_OUT_LOG, RUN_LOG):
        if p.exists():
            try:
                return datetime.fromtimestamp(p.stat().st_mtime).isoformat(timespec="seconds")
            except Exception:
                continue
    return None


def _next_run_iso(last_iso: str | None, interval: int | None) -> str | None:
    if not last_iso or not interval:
        return None
    try:
        last = datetime.fromisoformat(last_iso)
    except Exception:
        return None
    return (last + timedelta(seconds=interval)).isoformat(timespec="seconds")


def _log_tail(path: Path, max_lines: int = 40, max_bytes: int = 16 * 1024) -> str:
    if not path.exists():
        return ""
    try:
        size = path.stat().st_size
        with open(path, "rb") as f:
            if size > max_bytes:
                f.seek(size - max_bytes)
                # Drop a possibly-partial first line.
                f.readline()
            data = f.read()
        text = data.decode("utf-8", errors="replace")
        lines = text.splitlines()
        return "\n".join(lines[-max_lines:])
    except Exception as e:
        return f"<log read error: {e}>"


# ---------- commands ----------

def cmd_status(_args) -> None:
    errors: list[str] = []
    installed = INSTALLED_PLIST.exists()
    loaded = installed and _is_loaded()
    # Truth source priority: live installed plist (most authoritative —
    # what's actually scheduled) → state file → defaults.
    live_interval, live_mode = _installed_state()
    state = _read_sched_state()
    interval = live_interval if live_interval is not None else state["interval_seconds"]
    mode = live_mode if live_mode else state["mode"]
    last_run = _last_run_iso()
    next_run = _next_run_iso(last_run, interval)
    label = INTERVAL_LABELS.get(interval, f"{interval} s") if interval else None

    out = {
        "ok": True,
        "installed": installed,
        "loaded": loaded,
        "interval_seconds": interval,
        "interval_label": label,
        "mode": mode,
        "last_run": last_run,
        "next_run_estimate": next_run,
        "log_tail": _log_tail(RUN_LOG, max_lines=40),
        "plist_path": str(INSTALLED_PLIST),
        "label": LABEL,
        "last_exit_status": _last_exit_status_from_launchctl() if loaded else None,
        "errors": errors,
    }
    _emit(out, 0)


def cmd_install(_args) -> None:
    """Generate the plist from the persisted state and load it."""
    state = _read_sched_state()
    # If something is already loaded under our label (or the legacy
    # com.eliran.linkedinjobs label), unload first so the new install
    # succeeds cleanly even when the label changed.
    if _is_loaded():
        _unload()
    _legacy_unload_if_present()
    _write_installed_plist(state["interval_seconds"], state["mode"])
    rc, err = _load()
    if rc != 0:
        _emit({
            "ok": False, "error": f"launchctl load failed: {err}",
            "installed": True, "loaded": False,
        }, 1)
    _emit({"ok": True, "installed": True, "loaded": True,
           "interval_seconds": state["interval_seconds"],
           "mode": state["mode"]}, 0)


def cmd_uninstall(_args) -> None:
    unloaded_err = ""
    if INSTALLED_PLIST.exists():
        rc, err = _unload()
        if rc != 0 and "Could not find" not in err:
            unloaded_err = err
        try:
            INSTALLED_PLIST.unlink()
        except FileNotFoundError:
            pass
    _emit({
        "ok": True, "installed": False, "loaded": False,
        "warning": unloaded_err or None,
    }, 0)


def cmd_reload(_args) -> None:
    """Re-render the plist from current state and reload launchd."""
    if not INSTALLED_PLIST.exists():
        _emit({"ok": False, "error": "not installed"}, 1)
    state = _read_sched_state()
    _unload()
    _write_installed_plist(state["interval_seconds"], state["mode"])
    rc, err = _load()
    if rc != 0:
        _emit({"ok": False, "error": f"launchctl load failed: {err}"}, 1)
    _emit({"ok": True, "loaded": True}, 0)


def cmd_set_interval(args) -> None:
    seconds = int(args.seconds)
    if not (60 <= seconds <= 2_592_000):
        _emit({"ok": False, "error": "interval must be 60..2592000 seconds"}, 1)
    state = _read_sched_state()
    state["interval_seconds"] = seconds
    _write_sched_state(state)
    if INSTALLED_PLIST.exists():
        _unload()
        _write_installed_plist(state["interval_seconds"], state["mode"])
        rc, err = _load()
        if rc != 0:
            _emit({"ok": False, "error": f"reload failed: {err}",
                   "interval_seconds": seconds}, 1)
    _emit({"ok": True, "interval_seconds": seconds,
           "interval_label": INTERVAL_LABELS.get(seconds, f"{seconds} s")}, 0)


def cmd_set_mode(args) -> None:
    mode = args.mode.lower()
    if mode not in {"guest", "loggedin"}:
        _emit({"ok": False, "error": f"mode must be guest|loggedin, got {mode!r}"}, 1)
    state = _read_sched_state()
    state["mode"] = mode
    _write_sched_state(state)
    if INSTALLED_PLIST.exists():
        _unload()
        _write_installed_plist(state["interval_seconds"], state["mode"])
        rc, err = _load()
        if rc != 0:
            _emit({"ok": False, "error": f"reload failed: {err}", "mode": mode}, 1)
    _emit({"ok": True, "mode": mode}, 0)


def _legacy_unload_if_present():
    """Old installs used the label `com.eliran.linkedinjobs`. If that
    label is still loaded, unload it so we can install under the new
    generic label without conflict."""
    legacy_label = "com.eliran.linkedinjobs"
    legacy_plist = Path.home() / "Library" / "LaunchAgents" / f"{legacy_label}.plist"
    rc, _, _ = _run("launchctl", "list", legacy_label)
    if rc == 0:
        _run("launchctl", "unload", str(legacy_plist))
    if legacy_plist.exists():
        try:
            legacy_plist.unlink()
        except Exception:
            pass


def main():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status").set_defaults(func=cmd_status)
    sub.add_parser("install").set_defaults(func=cmd_install)
    sub.add_parser("uninstall").set_defaults(func=cmd_uninstall)
    sub.add_parser("reload").set_defaults(func=cmd_reload)
    si = sub.add_parser("set-interval"); si.add_argument("seconds", type=int)
    si.set_defaults(func=cmd_set_interval)
    sm = sub.add_parser("set-mode"); sm.add_argument("mode")
    sm.set_defaults(func=cmd_set_mode)
    args = p.parse_args()
    try:
        args.func(args)
    except Exception as e:
        _emit({"ok": False, "error": f"{type(e).__name__}: {e}"}, 1)


if __name__ == "__main__":
    main()
