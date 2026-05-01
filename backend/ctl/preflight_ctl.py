#!/usr/bin/env python3
"""
Preflight CLI for the LinkedIn jobs scraper. Verifies a fresh-clone
machine has the things the wizard needs before showing any UI:

  - Python 3.10+
  - `node` reachable on PATH
  - playwright + chromium installed (for logged-in mode)
  - config root (project root) writable
  - target ~/.linkedin-jobs.env file path writable

Same stable JSON CLI style as scheduler_ctl.py — the Vite middleware
shells to it.

Commands (no stdin needed, single JSON object on stdout):

  python3 preflight_ctl.py check
      -> { ok: bool, checks: [
             { name, ok, value|null, fix?: "...shell command..." }, ...
           ] }
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent  # backend/ctl/
ROOT = HERE.parent.parent               # project root

# Same env-file path the LLM credential save writes to.
ENV_FILE = Path.home() / ".linkedin-jobs.env"


def _emit(obj: dict, code: int = 0) -> None:
    print(json.dumps(obj, indent=2, ensure_ascii=False))
    sys.exit(code)


def _check_python() -> dict:
    v = sys.version_info
    value = f"{v.major}.{v.minor}.{v.micro}"
    ok = (v.major, v.minor) >= (3, 10)
    out = {"name": "python", "ok": ok, "value": value}
    if not ok:
        out["fix"] = "install Python >= 3.10 from python.org or your package manager"
    return out


def _check_node() -> dict:
    exe = shutil.which("node")
    if not exe:
        return {
            "name": "node",
            "ok": False,
            "value": None,
            "fix": "install Node.js >= 18 from nodejs.org or your package manager",
        }
    try:
        proc = subprocess.run(
            [exe, "--version"], capture_output=True, text=True, timeout=5,
        )
        ver = (proc.stdout or proc.stderr).strip()
    except Exception as e:  # noqa: BLE001
        return {
            "name": "node", "ok": False, "value": None,
            "fix": f"node found at {exe} but `node --version` failed: {e}",
        }
    return {"name": "node", "ok": True, "value": ver}


def _check_playwright_chromium() -> dict:
    """playwright is OPTIONAL — only needed for --mode=loggedin. We surface
    a not-ok status with a fix command, but `ok=false` here doesn't gate the
    wizard (frontend marks this check as advisory, not halting)."""
    try:
        from playwright.sync_api import sync_playwright  # noqa: F401
    except ImportError:
        return {
            "name": "playwright_chromium",
            "ok": False,
            "value": None,
            "fix": f"{sys.executable} -m pip install playwright && {sys.executable} -m playwright install chromium",
            "advisory": True,
        }
    # Verify chromium is actually installed (not just the python package).
    try:
        from playwright.sync_api import sync_playwright as _sp
        with _sp() as p:
            exe_path = p.chromium.executable_path
            if not exe_path or not Path(exe_path).exists():
                return {
                    "name": "playwright_chromium",
                    "ok": False,
                    "value": None,
                    "fix": f"{sys.executable} -m playwright install chromium",
                    "advisory": True,
                }
            return {"name": "playwright_chromium", "ok": True, "value": str(exe_path)}
    except Exception as e:  # noqa: BLE001
        return {
            "name": "playwright_chromium",
            "ok": False,
            "value": None,
            "fix": f"{sys.executable} -m playwright install chromium",
            "advisory": True,
            "detail": f"{type(e).__name__}: {str(e)[:200]}",
        }


def _check_writable(path: Path, name: str) -> dict:
    """Check write access by trying to create then delete a sentinel file
    in the directory (or parent if path is a file). Avoids the os.access
    false-positives on macOS sandbox setups."""
    try:
        target_dir = path if path.is_dir() else path.parent
        target_dir.mkdir(parents=True, exist_ok=True)
        sentinel = target_dir / f".preflight_write_test_{os.getpid()}"
        sentinel.write_text("x")
        sentinel.unlink()
        return {"name": name, "ok": True, "value": str(target_dir)}
    except Exception as e:  # noqa: BLE001
        return {
            "name": name, "ok": False, "value": str(path),
            "fix": f"chmod the parent directory to be writable by your user: {e}",
        }


def cmd_check() -> None:
    checks = [
        _check_python(),
        _check_node(),
        _check_playwright_chromium(),
        _check_writable(ROOT, "config_dir_writable"),
        _check_writable(ENV_FILE, "env_file_writable"),
    ]
    # Required checks (those without `advisory: true`) drive top-level ok.
    required_ok = all(c["ok"] for c in checks if not c.get("advisory"))
    _emit({"ok": required_ok, "checks": checks})


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd")
    sub.add_parser("check")
    args = parser.parse_args()
    if args.cmd == "check":
        cmd_check()
    parser.print_help()
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        _emit({"ok": False, "error": f"{type(e).__name__}: {e}"}, code=1)
