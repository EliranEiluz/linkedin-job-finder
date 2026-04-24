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
import shutil
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
LABEL = "com.eliran.linkedinjobs"
SOURCE_PLIST = HERE / f"{LABEL}.plist"
INSTALLED_PLIST = Path.home() / "Library" / "LaunchAgents" / f"{LABEL}.plist"

# Files used to surface "last run" state.
LAUNCHD_OUT_LOG = HERE / "launchd.out.log"
LAUNCHD_ERR_LOG = HERE / "launchd.err.log"
RUN_LOG = HERE / "run.log"

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


# ---------- plist parse / mutate ----------

def _read_interval(plist: Path) -> int | None:
    if not plist.exists():
        return None
    txt = plist.read_text()
    # The plist is small enough to regex-parse safely. We look for the
    # StartInterval key followed by an integer literal.
    m = re.search(
        r"<key>\s*StartInterval\s*</key>\s*<integer>\s*(\d+)\s*</integer>",
        txt, re.IGNORECASE,
    )
    return int(m.group(1)) if m else None


def _read_mode(plist: Path) -> str | None:
    if not plist.exists():
        return None
    txt = plist.read_text()
    m = re.search(
        r"<key>\s*LINKEDINJOBS_MODE\s*</key>\s*<string>\s*([a-z]+)\s*</string>",
        txt,
    )
    return m.group(1) if m else None


def _write_interval(plist: Path, seconds: int) -> None:
    txt = plist.read_text()
    new = re.sub(
        r"(<key>\s*StartInterval\s*</key>\s*<integer>\s*)\d+(\s*</integer>)",
        rf"\g<1>{seconds}\g<2>", txt, count=1, flags=re.IGNORECASE,
    )
    if new == txt:
        # No StartInterval block found — append one before </dict></plist>.
        new = txt.replace(
            "</dict>\n</plist>",
            f"  <key>StartInterval</key>\n  <integer>{seconds}</integer>\n</dict>\n</plist>",
        )
    plist.write_text(new)


def _write_mode(plist: Path, mode: str) -> None:
    txt = plist.read_text()
    new, n = re.subn(
        r"(<key>\s*LINKEDINJOBS_MODE\s*</key>\s*<string>\s*)[a-z]+(\s*</string>)",
        rf"\g<1>{mode}\g<2>", txt, count=1,
    )
    if n == 0:
        # No existing entry — inject inside the EnvironmentVariables block.
        new = re.sub(
            r"(<key>EnvironmentVariables</key>\s*<dict>)",
            rf"\g<1>\n    <key>LINKEDINJOBS_MODE</key>\n    <string>{mode}</string>",
            txt, count=1,
        )
    plist.write_text(new)


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
    interval = _read_interval(INSTALLED_PLIST if installed else SOURCE_PLIST)
    mode = _read_mode(INSTALLED_PLIST if installed else SOURCE_PLIST) or "guest"
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
        "source_plist_path": str(SOURCE_PLIST),
        "label": LABEL,
        "last_exit_status": _last_exit_status_from_launchctl() if loaded else None,
        "errors": errors,
    }
    _emit(out, 0)


def cmd_install(_args) -> None:
    if not SOURCE_PLIST.exists():
        _emit({"ok": False, "error": f"source plist missing: {SOURCE_PLIST}"}, 1)
    INSTALLED_PLIST.parent.mkdir(parents=True, exist_ok=True)
    # If something is already loaded, unload first so the copy succeeds cleanly.
    if _is_loaded():
        _unload()
    shutil.copy2(SOURCE_PLIST, INSTALLED_PLIST)
    rc, err = _load()
    if rc != 0:
        _emit({
            "ok": False, "error": f"launchctl load failed: {err}",
            "installed": True, "loaded": False,
        }, 1)
    _emit({"ok": True, "installed": True, "loaded": True}, 0)


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
    if not INSTALLED_PLIST.exists():
        _emit({"ok": False, "error": "not installed"}, 1)
    _unload()
    rc, err = _load()
    if rc != 0:
        _emit({"ok": False, "error": f"launchctl load failed: {err}"}, 1)
    _emit({"ok": True, "loaded": True}, 0)


def cmd_set_interval(args) -> None:
    seconds = int(args.seconds)
    if not (60 <= seconds <= 2_592_000):
        _emit({"ok": False, "error": "interval must be 60..2592000 seconds"}, 1)
    _write_interval(SOURCE_PLIST, seconds)
    if INSTALLED_PLIST.exists():
        _write_interval(INSTALLED_PLIST, seconds)
        _unload()
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
    _write_mode(SOURCE_PLIST, mode)
    if INSTALLED_PLIST.exists():
        _write_mode(INSTALLED_PLIST, mode)
        # Env-var changes only take effect on next fire if launchd reads the
        # plist again — easiest is to reload.
        _unload()
        rc, err = _load()
        if rc != 0:
            _emit({"ok": False, "error": f"reload failed: {err}", "mode": mode}, 1)
    _emit({"ok": True, "mode": mode}, 0)


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
