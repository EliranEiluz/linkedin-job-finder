"""Tests for the launchd / systemd-user / schtasks scheduler backends.

Strategy:
- We never call `launchctl`, `systemctl`, or `schtasks`. Each backend's
  `_run` helper is patched to return canned (rc, stdout, stderr) tuples.
- We DO write real plist / unit / xml strings to tmp_path-backed locations
  so the generators are exercised end-to-end. Each backend has hardcoded
  install paths under $HOME — we patch those too.
- The dispatcher in `__init__.get_scheduler` is platform-driven; covered
  with monkeypatch on `platform.system()` + `shutil.which`.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from backend.ctl.scheduler import get_scheduler
from backend.ctl.scheduler import launchd as launchd_mod
from backend.ctl.scheduler import schtasks as schtasks_mod
from backend.ctl.scheduler import systemd_user as systemd_mod
from backend.ctl.scheduler.launchd import LaunchdScheduler, _build_plist
from backend.ctl.scheduler.schtasks import SchtasksScheduler, _format_tr
from backend.ctl.scheduler.systemd_user import (
    SystemdUserScheduler,
    _service_unit,
    _timer_unit,
)

# ---------------------------------------------------------------------------
# get_scheduler dispatcher
# ---------------------------------------------------------------------------


def test_get_scheduler_darwin_returns_launchd(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr("platform.system", lambda: "Darwin")
    s = get_scheduler(tmp_path, tmp_path / "out.log", tmp_path / "err.log")
    assert s.backend_name == "launchd"


def test_get_scheduler_linux_with_systemctl_returns_systemd(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr("platform.system", lambda: "Linux")
    monkeypatch.setattr("shutil.which", lambda _: "/usr/bin/systemctl")
    s = get_scheduler(tmp_path, tmp_path / "out.log", tmp_path / "err.log")
    assert s.backend_name == "systemd-user"


def test_get_scheduler_linux_without_systemctl_raises(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr("platform.system", lambda: "Linux")
    monkeypatch.setattr("shutil.which", lambda _: None)
    with pytest.raises(RuntimeError, match="systemd"):
        get_scheduler(tmp_path, tmp_path / "out.log", tmp_path / "err.log")


def test_get_scheduler_windows_returns_schtasks(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr("platform.system", lambda: "Windows")
    s = get_scheduler(tmp_path, tmp_path / "out.log", tmp_path / "err.log")
    assert s.backend_name == "schtasks"


def test_get_scheduler_unsupported_raises(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr("platform.system", lambda: "Plan9")
    with pytest.raises(RuntimeError, match="Unsupported platform"):
        get_scheduler(tmp_path, tmp_path / "out.log", tmp_path / "err.log")


# ---------------------------------------------------------------------------
# launchd plist generator + scheduler ops (no real launchctl).
# ---------------------------------------------------------------------------


def test_launchd_build_plist_contains_required_keys(tmp_path: Path) -> None:
    plist = _build_plist(
        interval_seconds=3600,
        mode="guest",
        run_command=["/usr/bin/python3", "/path/to/run.py"],
        working_dir=tmp_path,
        out_log=tmp_path / "out.log",
        err_log=tmp_path / "err.log",
    )
    # Top-level boilerplate
    assert "<?xml" in plist
    assert "<plist" in plist
    # Label key is the launchd identifier; the LinkedIn jobs scraper uses
    # com.linkedinjobs as a stable identifier across reinstalls.
    assert "com.linkedinjobs" in plist
    # ProgramArguments — every element of run_command should appear.
    assert "<string>/usr/bin/python3</string>" in plist
    assert "<string>/path/to/run.py</string>" in plist
    # StartInterval is a literal integer.
    assert "<integer>3600</integer>" in plist
    # Mode is shipped via env var so search.py can read --mode.
    assert "<string>guest</string>" in plist
    # WorkingDirectory + log paths
    assert str(tmp_path) in plist
    assert "<string>" + str(tmp_path / "out.log") + "</string>" in plist
    assert "<string>" + str(tmp_path / "err.log") + "</string>" in plist


def test_launchd_install_writes_plist_and_loads(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """install() writes the plist + calls launchctl load. We patch the
    INSTALLED_PLIST path into tmp_path and stub `_run` to a success tuple."""
    fake_plist = tmp_path / "test.plist"
    monkeypatch.setattr(launchd_mod, "INSTALLED_PLIST", fake_plist)
    calls: list[tuple] = []

    def _stub(*argv: str, timeout: int = 8) -> tuple[int, str, str]:
        calls.append(argv)
        return 0, "", ""

    monkeypatch.setattr(launchd_mod, "_run", _stub)

    s = LaunchdScheduler(tmp_path, tmp_path / "out.log", tmp_path / "err.log")
    s.install(interval_seconds=3600, mode="guest", run_command=["python3", "run.py"])

    assert fake_plist.exists()
    txt = fake_plist.read_text()
    assert "<integer>3600</integer>" in txt
    # First call should be `launchctl list` (probe), but install only loads.
    # Either way the args must contain "load" with the plist path.
    assert any("load" in a for a in calls)


def test_launchd_install_propagates_load_failure(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(launchd_mod, "INSTALLED_PLIST", tmp_path / "x.plist")
    monkeypatch.setattr(launchd_mod, "_run", lambda *a, **kw: (1, "", "boom"))
    s = LaunchdScheduler(tmp_path, tmp_path / "out.log", tmp_path / "err.log")
    with pytest.raises(RuntimeError, match="launchctl load failed"):
        s.install(3600, "guest", ["python3", "run.py"])


def test_launchd_uninstall_removes_plist(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    fake = tmp_path / "x.plist"
    fake.write_text("<plist/>")
    monkeypatch.setattr(launchd_mod, "INSTALLED_PLIST", fake)
    monkeypatch.setattr(launchd_mod, "_run", lambda *a, **kw: (0, "", ""))
    s = LaunchdScheduler(tmp_path, tmp_path / "out.log", tmp_path / "err.log")
    s.uninstall()
    assert not fake.exists()


def test_launchd_uninstall_idempotent_when_missing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    fake = tmp_path / "missing.plist"
    monkeypatch.setattr(launchd_mod, "INSTALLED_PLIST", fake)
    monkeypatch.setattr(launchd_mod, "_run", lambda *a, **kw: (0, "", ""))
    LaunchdScheduler(tmp_path, tmp_path / "o", tmp_path / "e").uninstall()  # no raise


def test_launchd_installed_state_parses_existing_plist(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    fake = tmp_path / "x.plist"
    plist = _build_plist(7200, "loggedin", ["python3"], tmp_path, tmp_path, tmp_path)
    fake.write_text(plist)
    monkeypatch.setattr(launchd_mod, "INSTALLED_PLIST", fake)
    s = LaunchdScheduler(tmp_path, tmp_path / "o", tmp_path / "e")
    interval, mode = s.installed_state()
    assert interval == 7200
    assert mode == "loggedin"


def test_launchd_installed_state_returns_none_when_missing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(launchd_mod, "INSTALLED_PLIST", tmp_path / "missing.plist")
    s = LaunchdScheduler(tmp_path, tmp_path / "o", tmp_path / "e")
    assert s.installed_state() == (None, None)


def test_launchd_last_exit_status_parses_launchctl_list(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    fake_output = """{
\t"LastExitStatus" = 0;
\t"PID" = 12345;
}"""
    monkeypatch.setattr(launchd_mod, "_run", lambda *a, **kw: (0, fake_output, ""))
    s = LaunchdScheduler(tmp_path, tmp_path / "o", tmp_path / "e")
    assert s.last_exit_status() == 0


def test_launchd_last_exit_status_negative_value(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    fake_output = '"LastExitStatus" = -15;'
    monkeypatch.setattr(launchd_mod, "_run", lambda *a, **kw: (0, fake_output, ""))
    s = LaunchdScheduler(tmp_path, tmp_path / "o", tmp_path / "e")
    assert s.last_exit_status() == -15


# ---------------------------------------------------------------------------
# systemd-user generator + scheduler ops.
# ---------------------------------------------------------------------------


def test_systemd_service_unit_includes_required_directives(tmp_path: Path) -> None:
    unit = _service_unit(
        working_dir=tmp_path,
        run_command=["/usr/bin/python3", "/path with spaces/run.py"],
        mode="guest",
        log_path=tmp_path / "run.log",
    )
    assert "[Service]" in unit
    assert "Type=oneshot" in unit
    assert f"WorkingDirectory={tmp_path}" in unit
    # Path with spaces should be shell-quoted.
    assert "'/path with spaces/run.py'" in unit
    # Mode -> env var (for search.py argv resolution)
    assert "Environment=LINKEDINJOBS_MODE=guest" in unit
    assert f"StandardOutput=append:{tmp_path / 'run.log'}" in unit


def test_systemd_timer_unit_uses_seconds(tmp_path: Path) -> None:
    unit = _timer_unit(interval_seconds=3600)
    assert "[Timer]" in unit
    assert "OnUnitActiveSec=3600s" in unit
    assert "Persistent=true" in unit
    assert "WantedBy=timers.target" in unit


def test_systemd_install_writes_units_and_enables(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    svc = tmp_path / "linkedinjobs.service"
    tim = tmp_path / "linkedinjobs.timer"
    monkeypatch.setattr(systemd_mod, "SERVICE_PATH", svc)
    monkeypatch.setattr(systemd_mod, "TIMER_PATH", tim)
    monkeypatch.setattr(systemd_mod, "UNITS_DIR", tmp_path)

    calls: list[tuple] = []
    monkeypatch.setattr(systemd_mod, "_run", lambda *argv, **_kw: calls.append(argv) or (0, "", ""))
    s = SystemdUserScheduler(tmp_path, tmp_path / "out.log", tmp_path / "err.log")
    s.install(3600, "guest", ["python3", "run.py"])
    assert svc.exists()
    assert tim.exists()
    assert "OnUnitActiveSec=3600s" in tim.read_text()
    # Should call daemon-reload + enable --now
    flat = " ".join(" ".join(c) for c in calls)
    assert "daemon-reload" in flat
    assert "enable --now linkedinjobs.timer" in flat


def test_systemd_install_propagates_failure(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    svc = tmp_path / "x.service"
    tim = tmp_path / "x.timer"
    monkeypatch.setattr(systemd_mod, "SERVICE_PATH", svc)
    monkeypatch.setattr(systemd_mod, "TIMER_PATH", tim)
    monkeypatch.setattr(systemd_mod, "UNITS_DIR", tmp_path)
    monkeypatch.setattr(systemd_mod, "_run", lambda *a, **kw: (1, "", "permission denied"))
    s = SystemdUserScheduler(tmp_path, tmp_path / "o", tmp_path / "e")
    with pytest.raises(RuntimeError, match="daemon-reload"):
        s.install(3600, "guest", ["python3"])


def test_systemd_installed_state_parses_units(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    svc = tmp_path / "x.service"
    tim = tmp_path / "x.timer"
    monkeypatch.setattr(systemd_mod, "SERVICE_PATH", svc)
    monkeypatch.setattr(systemd_mod, "TIMER_PATH", tim)
    svc.write_text(_service_unit(tmp_path, ["python3"], "loggedin", tmp_path / "run.log"))
    tim.write_text(_timer_unit(7200))
    s = SystemdUserScheduler(tmp_path, tmp_path / "o", tmp_path / "e")
    assert s.installed_state() == (7200, "loggedin")


def test_systemd_installed_state_missing_units(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(systemd_mod, "SERVICE_PATH", tmp_path / "missing.service")
    monkeypatch.setattr(systemd_mod, "TIMER_PATH", tmp_path / "missing.timer")
    s = SystemdUserScheduler(tmp_path, tmp_path / "o", tmp_path / "e")
    assert s.installed_state() == (None, None)


# ---------------------------------------------------------------------------
# schtasks generator + scheduler ops.
# ---------------------------------------------------------------------------


def test_schtasks_format_tr_quotes_paths_with_spaces() -> None:
    assert _format_tr(["C:\\Path With Space\\python.exe"]) == '"C:\\Path With Space\\python.exe"'
    assert _format_tr(["python.exe"]) == "python.exe"
    assert (
        _format_tr(["C:\\Python\\python.exe", "C:\\proj with space\\run.py"])
        == 'C:\\Python\\python.exe "C:\\proj with space\\run.py"'
    )


def test_schtasks_install_calls_create(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    captured: list[tuple] = []

    def _stub(*argv: str, timeout: int = 8) -> tuple[int, str, str]:
        captured.append(argv)
        return 0, "", ""

    monkeypatch.setattr(schtasks_mod, "_run", _stub)
    s = SchtasksScheduler(tmp_path, tmp_path / "o", tmp_path / "e")
    s.install(3600, "guest", ["python.exe", "run.py"])
    assert captured, "install() should call schtasks _run"
    args = captured[0]
    assert "schtasks" in args
    assert "/Create" in args
    assert "/F" in args
    assert "/TN" in args
    # 3600 seconds rounds up to 60 minutes
    assert "60" in args
    assert "/SC" in args
    assert "MINUTE" in args


def test_schtasks_install_rounds_seconds_up(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Sub-minute (or non-multiple) intervals should round up — schtasks
    /MO MINUTE only accepts integer minutes. 90s -> 2 minutes."""
    captured: list[tuple] = []
    monkeypatch.setattr(schtasks_mod, "_run", lambda *a, **kw: captured.append(a) or (0, "", ""))
    SchtasksScheduler(tmp_path, tmp_path / "o", tmp_path / "e").install(90, "guest", ["python.exe"])
    assert "2" in captured[0]


def test_schtasks_install_failure_raises(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(schtasks_mod, "_run", lambda *a, **kw: (1, "", "access denied"))
    with pytest.raises(RuntimeError, match="schtasks /Create failed"):
        SchtasksScheduler(tmp_path, tmp_path / "o", tmp_path / "e").install(
            3600, "guest", ["python.exe"]
        )


def test_schtasks_last_exit_status_parses_query_output(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    fake = "TaskName: linkedinjobs\nLast Result: 0\nNext Run Time: ..."
    monkeypatch.setattr(schtasks_mod, "_run", lambda *a, **kw: (0, fake, ""))
    assert SchtasksScheduler(tmp_path, tmp_path / "o", tmp_path / "e").last_exit_status() == 0


def test_schtasks_last_exit_status_negative(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    fake = "Last Result: -2147023836"
    monkeypatch.setattr(schtasks_mod, "_run", lambda *a, **kw: (0, fake, ""))
    assert (
        SchtasksScheduler(tmp_path, tmp_path / "o", tmp_path / "e").last_exit_status()
        == -2147023836
    )


def test_schtasks_installed_state_returns_none() -> None:
    """schtasks doesn't expose interval/mode via CLI — falls back to the
    state file. Documented behavior; assert it stays that way."""
    s = SchtasksScheduler(Path("/tmp"), Path("/tmp/o"), Path("/tmp/e"))
    assert s.installed_state() == (None, None)
