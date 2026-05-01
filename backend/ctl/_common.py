"""Shared helpers for the JSON-CLI scripts under backend/ctl/.

Every ctl/*.py exposes the same contract to the Vite middleware:
  - read JSON from stdin (or no stdin),
  - emit a single JSON object on stdout,
  - exit 0 on success, 1 on validation/IO errors.

The repetitive boilerplate (stdin parsing, stdout JSON emission with
sys.exit, atomic temp+rename writes) used to live duplicated in every
file. This module is the single home for it. Each ctl script imports
the helpers it needs and stays focused on its own command logic.

NOTE on imports: ctl scripts insert `backend/` and the repo root into
sys.path before they import this module — see e.g. preflight_ctl.py's
header — so `from _common import ...` resolves from the bare-name
import path AND `from backend.ctl._common import ...` works too.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import NoReturn


def emit(obj: dict, code: int = 0) -> NoReturn:
    """Print `obj` as a single indented JSON envelope, then exit with `code`.

    The Vite middleware reads the last JSON document on stdout, so we always
    emit exactly one object — no logging interleaved before/after. Use
    `print(..., file=sys.stderr)` from the caller for any progress noise.
    """
    print(json.dumps(obj, indent=2, ensure_ascii=False))
    sys.exit(code)


def read_stdin_json(*, allow_empty: bool = False) -> dict:
    """Parse a single JSON object from stdin.

    Raises `ValueError` on empty stdin (unless `allow_empty=True`, which
    returns `{}` instead — useful for commands like config_suggest_ctl
    that take no params today but reserve the stdin shape for future use).
    Raises `TypeError` if the parsed payload is not a JSON object.
    """
    raw = sys.stdin.read()
    if not raw.strip():
        if allow_empty:
            return {}
        raise ValueError("empty stdin")
    obj = json.loads(raw)
    if not isinstance(obj, dict):
        raise TypeError("stdin must be a JSON object")
    return obj


def atomic_write_text(path: Path, data: str, *, encoding: str = "utf-8") -> None:
    """Write `data` to `path` via temp-file + rename for crash safety.

    The rename is atomic on POSIX and on NTFS for same-volume targets
    (caller's responsibility to keep tmp + dest on the same filesystem;
    `with_suffix` does so by default).
    """
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(data, encoding=encoding)
    tmp.replace(path)


def atomic_write_json(path: Path, obj: object, *, encoding: str = "utf-8") -> None:
    """Pretty-print `obj` as JSON and write it atomically to `path`.

    Trailing newline added so editors that strip-on-save don't churn the
    file. Mirrors the conventional Python tool output style.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(obj, indent=2, ensure_ascii=False) + "\n"
    atomic_write_text(path, payload, encoding=encoding)
