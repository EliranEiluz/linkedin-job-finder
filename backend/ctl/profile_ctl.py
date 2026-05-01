#!/usr/bin/env python3
"""
Profile (named config) control CLI for the LinkedIn jobs scraper. Mirrors the
stable-JSON-CLI style of scheduler_ctl.py and onboarding_ctl.py. The UI Vite
middleware shells to this instead of reimplementing file-system logic in JS.

Layout on disk (project root):

    <repo root>/
    ├── configs/
    │   ├── crypto.json
    │   ├── frontend.json
    │   └── ...
    ├── active_profile.txt   (single line: the active profile name)
    └── config.json          (symlink -> configs/<active>.json; backwards compat)

Commands (each emits a single JSON object on stdout; exit 0 on success, 1 on error):

  python3 profile_ctl.py list
      -> { ok, active, profiles: [...] }

  python3 profile_ctl.py activate <name>
      -> writes active_profile.txt and repoints config.json -> configs/<name>.json

  python3 profile_ctl.py create <name>
      stdin: {} or a full config dict
      -> writes configs/<name>.json (atomic); fails if name already exists

  python3 profile_ctl.py duplicate <src> <dst>
      -> copies configs/<src>.json to configs/<dst>.json

  python3 profile_ctl.py rename <old> <new>
      -> renames configs/<old>.json -> configs/<new>.json; if <old> was active,
         updates active_profile.txt + symlink to the new name.

  python3 profile_ctl.py delete <name>
      -> removes configs/<name>.json; refuses if it's the only profile; if it
         was active, activates any remaining one.

On the first `list` call with no configs/ directory, migrates the existing
config.json (if any) into configs/default.json, writes active_profile.txt,
and replaces config.json with a symlink pointing at the migrated file. If
there's no config.json to migrate, creates an empty-ish default from
defaults.json (or a minimal stub).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent  # backend/ctl/
ROOT = HERE.parent.parent               # project root (state lives here)
CONFIGS_DIR = ROOT / "configs"
ACTIVE_FILE = ROOT / "active_profile.txt"
CONFIG_SYMLINK = ROOT / "config.json"
DEFAULTS_FILE = ROOT / "defaults.json"

# Names that could collide with filesystem quirks or break the symlink logic.
# Keep the regex strict; users can rename later.
_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_\-]{0,63}$")


def _emit(obj: dict, code: int = 0) -> None:
    print(json.dumps(obj, indent=2, ensure_ascii=False))
    sys.exit(code)


def _validate_name(name: str) -> None:
    if not isinstance(name, str) or not _NAME_RE.match(name):
        raise ValueError(
            f"invalid profile name {name!r} — must match {_NAME_RE.pattern}"
        )


def _profile_path(name: str) -> Path:
    _validate_name(name)
    return CONFIGS_DIR / f"{name}.json"


def _read_active() -> str | None:
    if not ACTIVE_FILE.exists():
        return None
    try:
        name = ACTIVE_FILE.read_text(encoding="utf-8").strip()
    except Exception:
        return None
    if not name:
        return None
    try:
        _validate_name(name)
    except ValueError:
        return None
    return name


def _write_active(name: str) -> None:
    _validate_name(name)
    tmp = ACTIVE_FILE.with_suffix(ACTIVE_FILE.suffix + ".tmp")
    tmp.write_text(name + "\n", encoding="utf-8")
    tmp.replace(ACTIVE_FILE)


def _list_profiles() -> list[str]:
    if not CONFIGS_DIR.exists():
        return []
    out: list[str] = []
    for p in sorted(CONFIGS_DIR.iterdir()):
        if not p.is_file() or p.suffix != ".json":
            continue
        name = p.stem
        try:
            _validate_name(name)
        except ValueError:
            continue
        out.append(name)
    return out


def _atomic_write_json(path: Path, obj: object) -> None:
    """Write a JSON object atomically (temp+rename, same dir)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(
        json.dumps(obj, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    tmp.replace(path)


def _repoint_symlink(target_name: str) -> None:
    """Point CONFIG_SYMLINK at configs/<target_name>.json. If CONFIG_SYMLINK
    exists as a regular file, it's replaced with a symlink. Uses a relative
    target so the repo stays portable."""
    target = _profile_path(target_name)
    rel = os.path.relpath(target, CONFIG_SYMLINK.parent)
    # Can't atomically replace an existing symlink with another symlink via
    # os.symlink (it raises FileExistsError). Work around with a temp symlink
    # + rename, which IS atomic on POSIX.
    tmp_link = CONFIG_SYMLINK.parent / (CONFIG_SYMLINK.name + ".linktmp")
    if tmp_link.exists() or tmp_link.is_symlink():
        tmp_link.unlink()
    os.symlink(rel, tmp_link)
    os.replace(tmp_link, CONFIG_SYMLINK)


def _migrate_if_needed() -> None:
    """First-run migration: if `configs/` doesn't exist yet, create it and
    seed `configs/default.json` from the current `config.json` (or from
    defaults.json, or a minimal stub). Then write active_profile.txt and
    replace config.json with a symlink.

    Idempotent: a second call is a no-op. Callers may invoke this unconditionally
    before any other operation."""
    if CONFIGS_DIR.exists() and ACTIVE_FILE.exists():
        # Already migrated (or in a good state). Nothing to do.
        return

    CONFIGS_DIR.mkdir(parents=True, exist_ok=True)

    # Figure out what to put in configs/default.json.
    seed_obj: object | None = None

    # Case 1: config.json is a regular file with content — migrate it.
    if CONFIG_SYMLINK.exists() and not CONFIG_SYMLINK.is_symlink():
        try:
            seed_obj = json.loads(CONFIG_SYMLINK.read_text(encoding="utf-8"))
        except Exception:
            seed_obj = None

    # Case 2: config.json is a broken/valid symlink — read through it.
    elif CONFIG_SYMLINK.is_symlink():
        try:
            seed_obj = json.loads(CONFIG_SYMLINK.read_text(encoding="utf-8"))
        except Exception:
            seed_obj = None

    # Case 3: no config.json at all — fall back to defaults.json.
    if seed_obj is None and DEFAULTS_FILE.exists():
        try:
            seed_obj = json.loads(DEFAULTS_FILE.read_text(encoding="utf-8"))
        except Exception:
            seed_obj = None

    # Case 4: last resort — minimal stub.
    if seed_obj is None:
        seed_obj = {}

    default_path = CONFIGS_DIR / "default.json"
    if not default_path.exists():
        _atomic_write_json(default_path, seed_obj)

    # Write active_profile.txt if missing.
    if not ACTIVE_FILE.exists():
        _write_active("default")

    # Replace config.json with a symlink to the active profile. Preserve the
    # pre-existing file as a .premigrate backup in case anyone wants it.
    active = _read_active() or "default"
    if CONFIG_SYMLINK.exists() and not CONFIG_SYMLINK.is_symlink():
        backup = CONFIG_SYMLINK.with_suffix(CONFIG_SYMLINK.suffix + ".premigrate")
        try:
            shutil.copy2(CONFIG_SYMLINK, backup)
        except Exception:
            pass
        CONFIG_SYMLINK.unlink()
    _repoint_symlink(active)


# ---------- commands ------------------------------------------------------


def cmd_list(_args) -> None:
    _migrate_if_needed()
    profiles = _list_profiles()
    active = _read_active()
    # Defensive: if active_profile.txt points to a missing file, fall back to
    # the first profile (alphabetically) and surface both.
    if active not in profiles and profiles:
        active = profiles[0]
        _write_active(active)
        _repoint_symlink(active)
    # `cv_present` is one signal that the user has completed onboarding — a
    # default profile gets auto-created on first ctl call (see
    # _migrate_if_needed), so profiles.length always returns ≥1 even on a
    # fresh clone. The wizard's gate uses cv_present (OR a populated active
    # profile) to decide whether to hide the non-Setup tabs and force-show
    # the wizard.
    cv_path = ROOT / "cv.txt"
    try:
        cv_present = cv_path.exists() and cv_path.stat().st_size > 0
    except Exception:
        cv_present = False
    # Second signal: the active profile's `categories` has at least one
    # entry with a non-empty `queries` list. Domain-specific defaults were
    # stripped from search.py — an auto-init profile now has categories: [],
    # so a populated categories list is a real "user (or wizard) configured
    # this profile" signal. Cheap JSON read; falls open on any error so a
    # bad profile file never traps the user out of the rest of the UI.
    profile_configured = False
    if active:
        try:
            cfg_path = _profile_path(active)
            if cfg_path.exists():
                cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
                if isinstance(cfg, dict):
                    cats = cfg.get("categories") or []
                    if isinstance(cats, list):
                        for c in cats:
                            if isinstance(c, dict):
                                qs = c.get("queries") or []
                                if isinstance(qs, list) and any(
                                    isinstance(q, str) and q.strip() for q in qs
                                ):
                                    profile_configured = True
                                    break
        except Exception:
            profile_configured = False
    _emit({
        "ok": True,
        "active": active,
        "profiles": profiles,
        "cv_present": bool(cv_present or profile_configured),
    }, 0)


def cmd_activate(args) -> None:
    _migrate_if_needed()
    name = args.name
    _validate_name(name)
    if not _profile_path(name).exists():
        _emit({"ok": False, "error": f"profile {name!r} does not exist"}, 1)
    _write_active(name)
    _repoint_symlink(name)
    _emit({"ok": True, "active": name}, 0)


def _read_stdin_json_or_empty() -> dict:
    """Parse stdin JSON into a dict. Empty / whitespace-only stdin -> {}."""
    if sys.stdin.isatty():
        return {}
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    try:
        obj = json.loads(raw)
    except Exception as e:
        raise ValueError(f"stdin JSON invalid: {e}")
    if not isinstance(obj, dict):
        raise ValueError("stdin must be a JSON object (or empty)")
    return obj


def cmd_create(args) -> None:
    _migrate_if_needed()
    name = args.name
    _validate_name(name)
    path = _profile_path(name)
    if path.exists():
        _emit({"ok": False, "error": f"profile {name!r} already exists"}, 1)

    try:
        body = _read_stdin_json_or_empty()
    except ValueError as e:
        _emit({"ok": False, "error": str(e)}, 1)

    # If body is empty, seed from the currently-active profile (so "New profile"
    # from the UI gives the user something to edit, not a blank slate).
    if not body:
        active = _read_active()
        if active and _profile_path(active).exists():
            try:
                body = json.loads(
                    _profile_path(active).read_text(encoding="utf-8")
                )
                if not isinstance(body, dict):
                    body = {}
            except Exception:
                body = {}

    _atomic_write_json(path, body)
    _emit({"ok": True, "name": name, "path": str(path)}, 0)


def cmd_duplicate(args) -> None:
    _migrate_if_needed()
    src = args.src
    dst = args.dst
    _validate_name(src)
    _validate_name(dst)
    src_path = _profile_path(src)
    dst_path = _profile_path(dst)
    if not src_path.exists():
        _emit({"ok": False, "error": f"source profile {src!r} does not exist"}, 1)
    if dst_path.exists():
        _emit({"ok": False, "error": f"destination profile {dst!r} already exists"}, 1)
    shutil.copy2(src_path, dst_path)
    _emit({"ok": True, "name": dst, "path": str(dst_path)}, 0)


def cmd_rename(args) -> None:
    _migrate_if_needed()
    old = args.old
    new = args.new
    _validate_name(old)
    _validate_name(new)
    old_path = _profile_path(old)
    new_path = _profile_path(new)
    if not old_path.exists():
        _emit({"ok": False, "error": f"profile {old!r} does not exist"}, 1)
    if new_path.exists():
        _emit({"ok": False, "error": f"profile {new!r} already exists"}, 1)
    old_path.rename(new_path)
    # If the renamed profile was active, repoint the active file + symlink.
    if _read_active() == old:
        _write_active(new)
        _repoint_symlink(new)
    _emit({"ok": True, "old": old, "new": new}, 0)


def cmd_delete(args) -> None:
    _migrate_if_needed()
    name = args.name
    _validate_name(name)
    profiles = _list_profiles()
    if name not in profiles:
        _emit({"ok": False, "error": f"profile {name!r} does not exist"}, 1)
    if len(profiles) == 1:
        _emit({
            "ok": False,
            "error": f"cannot delete the only profile ({name!r})",
        }, 1)
    _profile_path(name).unlink()
    active = _read_active()
    if active == name:
        # Pick any remaining profile (alphabetically-first, from the refreshed list).
        remaining = _list_profiles()
        if not remaining:
            # Shouldn't happen given the len-check above, but defend anyway.
            _emit({"ok": False, "error": "no profiles left after delete"}, 1)
        new_active = remaining[0]
        _write_active(new_active)
        _repoint_symlink(new_active)
        _emit({"ok": True, "deleted": name, "active": new_active}, 0)
    _emit({"ok": True, "deleted": name, "active": active}, 0)


# ---------- main ----------------------------------------------------------


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list").set_defaults(func=cmd_list)
    pa = sub.add_parser("activate"); pa.add_argument("name")
    pa.set_defaults(func=cmd_activate)
    pc = sub.add_parser("create"); pc.add_argument("name")
    pc.set_defaults(func=cmd_create)
    pd = sub.add_parser("duplicate"); pd.add_argument("src"); pd.add_argument("dst")
    pd.set_defaults(func=cmd_duplicate)
    pr = sub.add_parser("rename"); pr.add_argument("old"); pr.add_argument("new")
    pr.set_defaults(func=cmd_rename)
    pdel = sub.add_parser("delete"); pdel.add_argument("name")
    pdel.set_defaults(func=cmd_delete)
    args = p.parse_args()
    try:
        args.func(args)
    except SystemExit:
        raise
    except ValueError as e:
        _emit({"ok": False, "error": str(e)}, 1)
    except Exception as e:  # noqa: BLE001
        _emit({"ok": False, "error": f"{type(e).__name__}: {e}"}, 1)


if __name__ == "__main__":
    main()
