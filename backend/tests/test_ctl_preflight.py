"""Tests for backend/ctl/preflight_ctl.py.

The script reports on python version / node binary / playwright+chromium /
write-permission to two paths. We stub `shutil.which` and the playwright
import so the tests pass on a CI runner without playwright installed.
Done in-process by importing the cmd handlers directly — preflight is
read-only and doesn't sys.exit until the very end, so we patch _emit
to capture instead of exit.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest


def _capture_emit(monkeypatch: pytest.MonkeyPatch) -> dict:
    """Replace `_emit` so it appends the payload to the returned dict
    instead of printing + sys.exit-ing. Tests then read back captured."""
    captured: dict = {}

    def _fake_emit(obj: dict, code: int = 0) -> None:
        captured.update({"obj": obj, "code": code})
        # Raise instead of sys.exit so the caller can inspect captured.
        raise SystemExit(code)

    import preflight_ctl

    monkeypatch.setattr(preflight_ctl, "_emit", _fake_emit)
    return captured


def test_preflight_check_happy_path(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    captured = _capture_emit(monkeypatch)
    import preflight_ctl

    # Make every check pass.
    monkeypatch.setattr(preflight_ctl, "ROOT", tmp_path)
    monkeypatch.setattr(preflight_ctl, "ENV_FILE", tmp_path / ".env")
    monkeypatch.setattr(preflight_ctl.shutil, "which", lambda _: "/usr/bin/node")

    class _FakeNodeProc:
        stdout = "v20.0.0\n"
        stderr = ""

    monkeypatch.setattr(
        preflight_ctl.subprocess,
        "run",
        lambda *a, **kw: _FakeNodeProc(),
    )

    monkeypatch.setattr(
        preflight_ctl,
        "_check_playwright_chromium",
        lambda: {"name": "playwright_chromium", "ok": True, "value": "/path/chromium"},
    )

    with pytest.raises(SystemExit):
        preflight_ctl.cmd_check()
    out = captured["obj"]
    assert out["ok"] is True  # all required checks pass
    names = [c["name"] for c in out["checks"]]
    assert names == [
        "python",
        "node",
        "playwright_chromium",
        "config_dir_writable",
        "env_file_writable",
    ]


def test_preflight_node_missing_fails_required(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    captured = _capture_emit(monkeypatch)
    import preflight_ctl

    monkeypatch.setattr(preflight_ctl, "ROOT", tmp_path)
    monkeypatch.setattr(preflight_ctl, "ENV_FILE", tmp_path / ".env")
    # node missing
    monkeypatch.setattr(preflight_ctl.shutil, "which", lambda _: None)
    monkeypatch.setattr(
        preflight_ctl,
        "_check_playwright_chromium",
        lambda: {"name": "playwright_chromium", "ok": True, "value": "x"},
    )
    with pytest.raises(SystemExit):
        preflight_ctl.cmd_check()
    out = captured["obj"]
    assert out["ok"] is False
    node_check = next(c for c in out["checks"] if c["name"] == "node")
    assert node_check["ok"] is False
    assert "install Node.js" in node_check["fix"]


def test_preflight_playwright_missing_does_not_fail_required(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """playwright_chromium is `advisory: true`. Even if missing, the top-level
    `ok` stays True so the wizard doesn't gate the user."""
    captured = _capture_emit(monkeypatch)
    import preflight_ctl

    monkeypatch.setattr(preflight_ctl, "ROOT", tmp_path)
    monkeypatch.setattr(preflight_ctl, "ENV_FILE", tmp_path / ".env")
    monkeypatch.setattr(preflight_ctl.shutil, "which", lambda _: "/usr/bin/node")

    class _FakeProc:
        stdout = "v20.0.0\n"
        stderr = ""

    monkeypatch.setattr(preflight_ctl.subprocess, "run", lambda *a, **kw: _FakeProc())
    monkeypatch.setattr(
        preflight_ctl,
        "_check_playwright_chromium",
        lambda: {
            "name": "playwright_chromium",
            "ok": False,
            "value": None,
            "fix": "install playwright",
            "advisory": True,
        },
    )
    with pytest.raises(SystemExit):
        preflight_ctl.cmd_check()
    out = captured["obj"]
    assert out["ok"] is True


def test_preflight_unwritable_dir_fails(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    captured = _capture_emit(monkeypatch)
    import preflight_ctl

    # Point ROOT at a path we can't write — patch the helper directly.
    monkeypatch.setattr(preflight_ctl, "ENV_FILE", tmp_path / ".env")
    monkeypatch.setattr(preflight_ctl, "ROOT", tmp_path)
    monkeypatch.setattr(preflight_ctl.shutil, "which", lambda _: "/usr/bin/node")

    class _P:
        stdout = "v20\n"
        stderr = ""

    monkeypatch.setattr(preflight_ctl.subprocess, "run", lambda *a, **kw: _P())
    monkeypatch.setattr(
        preflight_ctl,
        "_check_playwright_chromium",
        lambda: {"name": "playwright_chromium", "ok": True, "value": "x"},
    )
    monkeypatch.setattr(
        preflight_ctl,
        "_check_writable",
        lambda path, name: {
            "name": name,
            "ok": False,
            "value": str(path),
            "fix": "chmod the dir",
        },
    )
    with pytest.raises(SystemExit):
        preflight_ctl.cmd_check()
    assert captured["obj"]["ok"] is False
