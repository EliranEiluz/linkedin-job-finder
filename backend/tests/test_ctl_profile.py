"""Tests for backend/ctl/profile_ctl.py.

Each command is exercised by spawning the ctl as a real subprocess (matches
the Vite middleware's runCtl path) with a tmp_path-backed cwd so the test
never writes into the real `configs/` directory.

Why subprocess + cwd swap rather than importing cmd_* directly:
- The script does `_emit() -> sys.exit()` from inside every cmd handler;
  importing it into-process would crash the test runner.
- The script's first action is `_migrate_if_needed()` which mutates the
  cwd's `configs/` and `active_profile.txt`. Subprocess + cwd is the only
  way to keep that side-effecting logic confined.
"""

from __future__ import annotations

import json
from pathlib import Path


def test_profile_list_creates_default_on_empty_dir(run_ctl, tmp_path: Path) -> None:
    rc, out, _err = run_ctl("profile_ctl.py", ["list"])
    assert rc == 0
    assert out["ok"] is True
    assert out["active"] == "default"
    assert "default" in out["profiles"]
    # Side effects in cwd: configs/default.json + active_profile.txt
    assert (tmp_path / "configs" / "default.json").exists()
    assert (tmp_path / "active_profile.txt").read_text().strip() == "default"


def test_profile_list_reports_cv_present(run_ctl, tmp_path: Path) -> None:
    (tmp_path / "cv.txt").write_text("Senior engineer.")
    rc, out, _err = run_ctl("profile_ctl.py", ["list"])
    assert rc == 0
    assert out["cv_present"] is True


def test_profile_list_cv_absent(run_ctl, tmp_path: Path) -> None:
    rc, out, _err = run_ctl("profile_ctl.py", ["list"])
    assert rc == 0
    assert out["cv_present"] is False


def test_profile_create_then_activate_then_list(run_ctl, tmp_path: Path) -> None:
    rc1, out1, _ = run_ctl("profile_ctl.py", ["create", "frontend"], stdin_payload={})
    assert rc1 == 0, out1
    assert out1["ok"] is True
    assert (tmp_path / "configs" / "frontend.json").exists()

    rc2, out2, _ = run_ctl("profile_ctl.py", ["activate", "frontend"])
    assert rc2 == 0
    assert out2["active"] == "frontend"

    rc3, out3, _ = run_ctl("profile_ctl.py", ["list"])
    assert out3["active"] == "frontend"
    assert set(out3["profiles"]) >= {"frontend", "default"}


def test_profile_create_seeds_from_active_when_stdin_empty(run_ctl, tmp_path: Path) -> None:
    """If stdin is empty/{}, the new profile copies the active one."""
    # Seed default with a known shape via a write through `create`.
    rc, _, _ = run_ctl("profile_ctl.py", ["create", "src"], stdin_payload={"location": "Tel Aviv"})
    assert rc == 0
    # Activate the seeded profile so it's the source for the next create.
    rc2, _, _ = run_ctl("profile_ctl.py", ["activate", "src"])
    assert rc2 == 0
    rc3, out3, _ = run_ctl("profile_ctl.py", ["create", "dst"])  # no stdin
    assert rc3 == 0, out3
    body = json.loads((tmp_path / "configs" / "dst.json").read_text())
    assert body["location"] == "Tel Aviv"


def test_profile_create_duplicate_fails(run_ctl, tmp_path: Path) -> None:  # noqa: ARG001
    run_ctl("profile_ctl.py", ["create", "x"], stdin_payload={})
    rc, out, _ = run_ctl("profile_ctl.py", ["create", "x"], stdin_payload={})
    assert rc == 1
    assert out["ok"] is False
    assert "already exists" in out["error"]


def test_profile_invalid_name_rejected(run_ctl, tmp_path: Path) -> None:  # noqa: ARG001
    rc, out, _ = run_ctl("profile_ctl.py", ["create", "bad name with space"], stdin_payload={})
    assert rc == 1
    assert "invalid profile name" in out["error"]


def test_profile_rename_updates_active(run_ctl, tmp_path: Path) -> None:
    run_ctl("profile_ctl.py", ["create", "old"], stdin_payload={})
    run_ctl("profile_ctl.py", ["activate", "old"])
    rc, out, _ = run_ctl("profile_ctl.py", ["rename", "old", "new"])
    assert rc == 0, out
    assert out["new"] == "new"
    assert (tmp_path / "configs" / "new.json").exists()
    assert not (tmp_path / "configs" / "old.json").exists()
    assert (tmp_path / "active_profile.txt").read_text().strip() == "new"


def test_profile_rename_to_existing_fails(run_ctl, tmp_path: Path) -> None:  # noqa: ARG001
    run_ctl("profile_ctl.py", ["create", "a"], stdin_payload={})
    run_ctl("profile_ctl.py", ["create", "b"], stdin_payload={})
    rc, out, _ = run_ctl("profile_ctl.py", ["rename", "a", "b"])
    assert rc == 1
    assert "already exists" in out["error"]


def test_profile_delete(run_ctl, tmp_path: Path) -> None:
    run_ctl("profile_ctl.py", ["create", "throwaway"], stdin_payload={})
    rc, out, _ = run_ctl("profile_ctl.py", ["delete", "throwaway"])
    assert rc == 0, out
    assert out["deleted"] == "throwaway"
    assert not (tmp_path / "configs" / "throwaway.json").exists()


def test_profile_delete_only_profile_refused(run_ctl, tmp_path: Path) -> None:  # noqa: ARG001
    run_ctl("profile_ctl.py", ["list"])  # ensure default exists
    rc, out, _ = run_ctl("profile_ctl.py", ["delete", "default"])
    assert rc == 1
    assert "only profile" in out["error"]


def test_profile_delete_active_falls_back(run_ctl, tmp_path: Path) -> None:
    run_ctl("profile_ctl.py", ["create", "alt"], stdin_payload={})
    run_ctl("profile_ctl.py", ["activate", "alt"])
    rc, out, _ = run_ctl("profile_ctl.py", ["delete", "alt"])
    assert rc == 0, out
    # default should auto-activate as the alphabetically-first remaining one.
    assert out["active"] == "default"
    assert (tmp_path / "active_profile.txt").read_text().strip() == "default"


def test_profile_duplicate(run_ctl, tmp_path: Path) -> None:
    run_ctl("profile_ctl.py", ["create", "src"], stdin_payload={"location": "Berlin"})
    rc, out, _ = run_ctl("profile_ctl.py", ["duplicate", "src", "copy"])
    assert rc == 0, out
    assert (tmp_path / "configs" / "copy.json").exists()
    assert json.loads((tmp_path / "configs" / "copy.json").read_text())["location"] == "Berlin"
