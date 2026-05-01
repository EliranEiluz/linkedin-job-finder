"""Tests for backend/ctl/scheduler_ctl.py.

The script wraps the OS-native scheduler. Calling install / reload would
register a real launchd plist on macOS — we don't want that. Strategy:
- in-process import + monkeypatch the module-level _SCHEDULER instance to
  a dummy that records calls instead of touching launchctl.
- patch _emit to capture rather than sys.exit.
- still cover status / set-interval / set-mode bounds + state-file round-trip.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest


class _FakeSched:
    """Mimics the Scheduler ABC for assertion purposes. Tracks every call
    so tests can verify the right ones were made with the right args."""

    backend_name = "fake"
    native_id = "/tmp/fake.fake"
    LABEL = "com.fake"

    def __init__(self) -> None:
        self.installed = False
        self.loaded_state = False
        self.calls: list[tuple] = []
        self._state: tuple[int | None, str | None] = (None, None)

    def is_installed(self) -> bool:
        return self.installed

    def is_loaded(self) -> bool:
        return self.loaded_state

    def install(self, interval: int, mode: str, run_command: list[str]) -> None:
        self.calls.append(("install", interval, mode, run_command))
        self.installed = True
        self.loaded_state = True
        self._state = (interval, mode)

    def uninstall(self) -> None:
        self.calls.append(("uninstall",))
        self.installed = False
        self.loaded_state = False

    def reload(self, interval: int, mode: str, run_command: list[str]) -> None:
        self.calls.append(("reload", interval, mode, run_command))
        self._state = (interval, mode)

    def last_exit_status(self) -> int | None:
        return 0

    def installed_state(self) -> tuple[int | None, str | None]:
        return self._state


@pytest.fixture
def fake_sched_ctl(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> tuple:
    """Import scheduler_ctl, swap its _SCHEDULER for a fake, redirect state
    files into tmp_path. Returns (module, fake_sched, captured_emits)."""
    import scheduler_ctl

    fake = _FakeSched()
    monkeypatch.setattr(scheduler_ctl, "_SCHEDULER", fake)
    monkeypatch.setattr(scheduler_ctl, "SCHED_STATE_FILE", tmp_path / "scheduler_state.json")
    monkeypatch.setattr(scheduler_ctl, "RUN_LOG", tmp_path / "run.log")
    monkeypatch.setattr(scheduler_ctl, "LAUNCHD_OUT_LOG", tmp_path / "launchd.out.log")
    monkeypatch.setattr(scheduler_ctl, "LAUNCHD_ERR_LOG", tmp_path / "launchd.err.log")

    captured: list[dict] = []

    def _fake_emit(obj: dict, code: int = 0) -> None:
        captured.append({"obj": obj, "code": code})
        raise SystemExit(code)

    monkeypatch.setattr(scheduler_ctl, "_emit", _fake_emit)
    return scheduler_ctl, fake, captured


def test_scheduler_status_with_no_state_file(fake_sched_ctl) -> None:
    mod, fake, captured = fake_sched_ctl
    with pytest.raises(SystemExit) as ec:
        mod.cmd_status(None)
    assert ec.value.code == 0
    out = captured[-1]["obj"]
    assert out["ok"] is True
    assert out["installed"] is False
    assert out["loaded"] is False
    # Defaults: 12h interval, guest mode.
    assert out["interval_seconds"] == 43_200
    assert out["mode"] == "guest"
    assert out["backend"] == "fake"


def test_scheduler_status_reflects_installed(fake_sched_ctl) -> None:
    mod, fake, captured = fake_sched_ctl
    fake.installed = True
    fake.loaded_state = True
    fake._state = (3600, "loggedin")
    with pytest.raises(SystemExit):
        mod.cmd_status(None)
    out = captured[-1]["obj"]
    assert out["installed"] is True
    assert out["loaded"] is True
    assert out["interval_seconds"] == 3600
    assert out["mode"] == "loggedin"
    assert out["interval_label"] == "1 h"
    assert out["last_exit_status"] == 0


def test_scheduler_set_interval_validates_bounds(fake_sched_ctl) -> None:
    mod, fake, captured = fake_sched_ctl

    class _Args:
        seconds = 30  # < 60 → should fail

    with pytest.raises(SystemExit) as ec:
        mod.cmd_set_interval(_Args())
    assert ec.value.code == 1
    assert "interval must be" in captured[-1]["obj"]["error"]


def test_scheduler_set_interval_persists_to_state_file(fake_sched_ctl, tmp_path: Path) -> None:
    mod, fake, captured = fake_sched_ctl

    class _Args:
        seconds = 7200

    with pytest.raises(SystemExit) as ec:
        mod.cmd_set_interval(_Args())
    assert ec.value.code == 0
    state = json.loads((tmp_path / "scheduler_state.json").read_text())
    assert state["interval_seconds"] == 7200
    # Not installed → no reload was triggered.
    assert not any(c[0] == "reload" for c in fake.calls)


def test_scheduler_set_interval_reloads_when_installed(fake_sched_ctl) -> None:
    mod, fake, _captured = fake_sched_ctl
    fake.installed = True

    class _Args:
        seconds = 7200

    with pytest.raises(SystemExit):
        mod.cmd_set_interval(_Args())
    reloads = [c for c in fake.calls if c[0] == "reload"]
    assert len(reloads) == 1
    assert reloads[0][1] == 7200  # interval


def test_scheduler_set_mode_invalid(fake_sched_ctl) -> None:
    mod, _fake, captured = fake_sched_ctl

    class _Args:
        mode = "wifi"

    with pytest.raises(SystemExit) as ec:
        mod.cmd_set_mode(_Args())
    assert ec.value.code == 1
    assert "mode must be" in captured[-1]["obj"]["error"]


def test_scheduler_set_mode_persists(fake_sched_ctl, tmp_path: Path) -> None:
    mod, _fake, _captured = fake_sched_ctl

    class _Args:
        mode = "loggedin"

    with pytest.raises(SystemExit) as ec:
        mod.cmd_set_mode(_Args())
    assert ec.value.code == 0
    state = json.loads((tmp_path / "scheduler_state.json").read_text())
    assert state["mode"] == "loggedin"


def test_scheduler_install_persists_calls(fake_sched_ctl) -> None:
    mod, fake, _captured = fake_sched_ctl
    with pytest.raises(SystemExit) as ec:
        mod.cmd_install(None)
    assert ec.value.code == 0
    installs = [c for c in fake.calls if c[0] == "install"]
    assert len(installs) == 1


def test_scheduler_uninstall_idempotent(fake_sched_ctl) -> None:
    mod, fake, _captured = fake_sched_ctl
    with pytest.raises(SystemExit) as ec:
        mod.cmd_uninstall(None)
    assert ec.value.code == 0
    assert any(c[0] == "uninstall" for c in fake.calls)


def test_scheduler_reload_requires_installed(fake_sched_ctl) -> None:
    mod, fake, captured = fake_sched_ctl
    fake.installed = False
    with pytest.raises(SystemExit) as ec:
        mod.cmd_reload(None)
    assert ec.value.code == 1
    assert "not installed" in captured[-1]["obj"]["error"]


# ---------------------------------------------------------------------------
# Pure helpers — _last_run_iso / _next_run_iso / _log_tail.
# ---------------------------------------------------------------------------


def test_next_run_iso_adds_interval_to_last() -> None:
    import scheduler_ctl

    out = scheduler_ctl._next_run_iso("2026-04-15T10:00:00", 3600)
    assert out == "2026-04-15T11:00:00"


def test_next_run_iso_returns_none_on_invalid() -> None:
    import scheduler_ctl

    assert scheduler_ctl._next_run_iso(None, 3600) is None
    assert scheduler_ctl._next_run_iso("garbage", 3600) is None
    assert scheduler_ctl._next_run_iso("2026-04-15T10:00:00", None) is None


def test_log_tail_reads_last_lines(tmp_path: Path) -> None:
    import scheduler_ctl

    p = tmp_path / "log.txt"
    p.write_text("\n".join(f"line {i}" for i in range(100)) + "\n")
    out = scheduler_ctl._log_tail(p, max_lines=5)
    assert out.splitlines() == ["line 95", "line 96", "line 97", "line 98", "line 99"]


def test_log_tail_missing_file_returns_empty(tmp_path: Path) -> None:
    import scheduler_ctl

    assert scheduler_ctl._log_tail(tmp_path / "missing.log") == ""


def test_read_sched_state_returns_defaults_when_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import scheduler_ctl

    monkeypatch.setattr(scheduler_ctl, "SCHED_STATE_FILE", tmp_path / "missing.json")
    state = scheduler_ctl._read_sched_state()
    assert state == {"interval_seconds": 43_200, "mode": "guest"}


def test_read_sched_state_round_trip(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import scheduler_ctl

    f = tmp_path / "state.json"
    f.write_text(json.dumps({"interval_seconds": 60, "mode": "loggedin"}))
    monkeypatch.setattr(scheduler_ctl, "SCHED_STATE_FILE", f)
    assert scheduler_ctl._read_sched_state() == {
        "interval_seconds": 60,
        "mode": "loggedin",
    }
