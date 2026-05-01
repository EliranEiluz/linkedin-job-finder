#!/usr/bin/env python3
"""
Cross-platform scheduler control surface for the LinkedIn jobs scraper.
Wraps the OS-native scheduler (launchd / systemd-user / schtasks, picked
automatically by `scheduler.get_scheduler()`) with a stable JSON CLI that
the UI's Vite middleware shells to.

Commands (all emit a single JSON object on stdout, exit 0 on success):

  python3 scheduler_ctl.py status
      -> { ok, installed, loaded, interval_seconds, interval_label,
           mode, last_run, next_run_estimate, log_tail, backend,
           native_id, last_exit_status, errors }

  python3 scheduler_ctl.py install
      -> registers under LABEL with state-file's interval+mode. Idempotent.

  python3 scheduler_ctl.py uninstall
      -> tears down the OS registration. Idempotent.

  python3 scheduler_ctl.py reload
      -> re-register with current state (call after editing run_command,
         interval, or mode).

  python3 scheduler_ctl.py set-interval <seconds>
      -> persist new interval to state, then reload. seconds must be 60..2592000.

  python3 scheduler_ctl.py set-mode <loggedin|guest>
      -> persist new mode to state, then reload.

Failures emit { "ok": false, "error": "...", ... } and exit 1.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timedelta
from pathlib import Path

# --- paths ---------------------------------------------------------------
HERE = Path(__file__).resolve().parent  # backend/ctl/
ROOT = HERE.parent.parent  # project root
RUN_SCRIPT = ROOT / "backend" / "run.py"
SCHED_STATE_FILE = ROOT / "scheduler_state.json"
LAUNCHD_OUT_LOG = ROOT / "launchd.out.log"
LAUNCHD_ERR_LOG = ROOT / "launchd.err.log"
RUN_LOG = ROOT / "run.log"

# --- defaults ------------------------------------------------------------
DEFAULT_INTERVAL = 43_200  # 12 h
DEFAULT_MODE = "guest"

INTERVAL_LABELS = {
    3600: "1 h",
    7200: "2 h",
    14400: "4 h",
    21600: "6 h",
    43200: "12 h",
    86400: "24 h",
    172800: "48 h",
}

# --- scheduler abstraction (OS-dispatched) -------------------------------
# sys.path shim so this script can be invoked directly (`python3 scheduler_ctl.py …`)
# without `pip install -e .`. We add backend/ctl/ for the bare-name `_common` /
# `scheduler` import paths AND the repo root so `backend.ctl.scheduler` resolves
# cleanly (mypy needs the latter; the bare-name fallback keeps direct CLI
# invocation working unchanged).
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT))
from _common import emit as _emit  # noqa: E402  (sys.path shim above)
from scheduler import get_scheduler  # noqa: E402  (sys.path shim above)

_SCHEDULER = get_scheduler(
    working_dir=ROOT,
    out_log=LAUNCHD_OUT_LOG,
    err_log=LAUNCHD_ERR_LOG,
)

# --- state -----------------------------------------------------------------


def _read_sched_state() -> dict:
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


# --- last/next run estimation (OS-agnostic; uses run.log mtime) -----------


def _last_run_iso() -> str | None:
    """Best-effort 'last run' timestamp. Prefers launchd.out.log mtime
    (reliable on macOS — launchd touches it on every fire). Falls back to
    run.log on any OS (run.py appends on every fire)."""
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
        with path.open("rb") as f:
            if size > max_bytes:
                f.seek(size - max_bytes)
                f.readline()  # drop possibly-partial first line
            data = f.read()
        text = data.decode("utf-8", errors="replace")
        lines = text.splitlines()
        return "\n".join(lines[-max_lines:])
    except Exception as e:
        return f"<log read error: {e}>"


# --- helpers ----------------------------------------------------------------


def _run_command() -> list[str]:
    """The command the scheduler should invoke — the cross-platform Python
    launcher at backend/run.py. Pinning sys.executable means the scheduled
    task always uses the same Python interpreter that ran the install."""
    return [sys.executable, str(RUN_SCRIPT)]


# --- commands --------------------------------------------------------------


def cmd_status(_args) -> None:
    errors: list[str] = []
    installed = _SCHEDULER.is_installed()
    loaded = installed and _SCHEDULER.is_loaded()
    # Truth source priority: live install (most authoritative) → state file → defaults.
    live_interval, live_mode = _SCHEDULER.installed_state()
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
        "backend": _SCHEDULER.backend_name,
        "native_id": _SCHEDULER.native_id,
        # Legacy alias kept so existing UI code reading `plist_path` still works
        # on macOS. New code should read `native_id` and `backend`.
        "plist_path": _SCHEDULER.native_id,
        "label": _SCHEDULER.LABEL,
        "last_exit_status": _SCHEDULER.last_exit_status() if loaded else None,
        "errors": errors,
    }
    _emit(out, 0)


def cmd_install(_args) -> None:
    state = _read_sched_state()
    try:
        _SCHEDULER.install(state["interval_seconds"], state["mode"], _run_command())
    except Exception as e:
        _emit(
            {
                "ok": False,
                "error": str(e),
                "installed": _SCHEDULER.is_installed(),
                "loaded": _SCHEDULER.is_loaded(),
            },
            1,
        )
    _emit(
        {
            "ok": True,
            "installed": True,
            "loaded": _SCHEDULER.is_loaded(),
            "interval_seconds": state["interval_seconds"],
            "mode": state["mode"],
            "backend": _SCHEDULER.backend_name,
            "native_id": _SCHEDULER.native_id,
        },
        0,
    )


def cmd_uninstall(_args) -> None:
    try:
        _SCHEDULER.uninstall()
    except Exception as e:
        _emit({"ok": False, "error": str(e)}, 1)
    _emit(
        {
            "ok": True,
            "installed": False,
            "loaded": False,
            "backend": _SCHEDULER.backend_name,
        },
        0,
    )


def cmd_reload(_args) -> None:
    if not _SCHEDULER.is_installed():
        _emit({"ok": False, "error": "not installed"}, 1)
    state = _read_sched_state()
    try:
        _SCHEDULER.reload(state["interval_seconds"], state["mode"], _run_command())
    except Exception as e:
        _emit({"ok": False, "error": str(e)}, 1)
    _emit({"ok": True, "loaded": True, "backend": _SCHEDULER.backend_name}, 0)


def cmd_set_interval(args) -> None:
    seconds = int(args.seconds)
    if not (60 <= seconds <= 2_592_000):
        _emit({"ok": False, "error": "interval must be 60..2592000 seconds"}, 1)
    state = _read_sched_state()
    state["interval_seconds"] = seconds
    _write_sched_state(state)
    if _SCHEDULER.is_installed():
        try:
            _SCHEDULER.reload(state["interval_seconds"], state["mode"], _run_command())
        except Exception as e:
            _emit({"ok": False, "error": str(e), "interval_seconds": seconds}, 1)
    _emit(
        {
            "ok": True,
            "interval_seconds": seconds,
            "interval_label": INTERVAL_LABELS.get(seconds, f"{seconds} s"),
        },
        0,
    )


def cmd_set_mode(args) -> None:
    mode = args.mode.lower()
    if mode not in {"guest", "loggedin"}:
        _emit({"ok": False, "error": f"mode must be guest|loggedin, got {mode!r}"}, 1)
    state = _read_sched_state()
    state["mode"] = mode
    _write_sched_state(state)
    if _SCHEDULER.is_installed():
        try:
            _SCHEDULER.reload(state["interval_seconds"], state["mode"], _run_command())
        except Exception as e:
            _emit({"ok": False, "error": str(e), "mode": mode}, 1)
    _emit({"ok": True, "mode": mode}, 0)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status").set_defaults(func=cmd_status)
    sub.add_parser("install").set_defaults(func=cmd_install)
    sub.add_parser("uninstall").set_defaults(func=cmd_uninstall)
    sub.add_parser("reload").set_defaults(func=cmd_reload)
    si = sub.add_parser("set-interval")
    si.add_argument("seconds", type=int)
    si.set_defaults(func=cmd_set_interval)
    sm = sub.add_parser("set-mode")
    sm.add_argument("mode")
    sm.set_defaults(func=cmd_set_mode)
    args = p.parse_args()
    try:
        args.func(args)
    except Exception as e:
        _emit({"ok": False, "error": f"{type(e).__name__}: {e}"}, 1)


if __name__ == "__main__":
    main()
