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

import contextlib
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


def atomic_write_env_var(env_file: Path, env_var: str, value: str) -> None:
    """Update or append `<env_var>=<value>` in a dotenv-style file.

    Atomic via temp + rename. chmod 0o600 (best-effort on Windows / restrictive
    umasks). Both ``KEY=...`` and ``export KEY=...`` lines are recognized as
    the same variable; duplicate lines are collapsed. NEVER logs ``value`` —
    callers should refer to the env-var name only in error messages.

    Used by both llm_ctl (LLM API keys) and notifications_ctl (SMTP creds)
    so the env-write logic lives in exactly one place.
    """
    env_file.parent.mkdir(parents=True, exist_ok=True)
    existing_lines: list[str] = []
    if env_file.exists():
        try:
            existing_lines = env_file.read_text().splitlines()
        except Exception:
            existing_lines = []
    out_lines: list[str] = []
    replaced = False
    for line in existing_lines:
        stripped = line.strip()
        if stripped.startswith(f"{env_var}=") or stripped.startswith(f"export {env_var}="):
            if not replaced:
                out_lines.append(f"{env_var}={value}")
                replaced = True
            # drop subsequent duplicates
        else:
            out_lines.append(line)
    if not replaced:
        out_lines.append(f"{env_var}={value}")
    body = "\n".join(out_lines).rstrip("\n") + "\n"
    tmp = env_file.with_suffix(env_file.suffix + ".tmp")
    tmp.write_text(body)
    with contextlib.suppress(OSError):
        tmp.chmod(0o600)
    tmp.replace(env_file)
    with contextlib.suppress(OSError):
        env_file.chmod(0o600)


def load_env_file(env_file: Path) -> None:
    """Load `KEY=value` lines from `env_file` into os.environ (no override).

    Lets a save-credential + test pair in the same wizard step actually see
    the new key. Quietly skips a malformed env file rather than crashing the
    wizard. ``export KEY=value`` lines are accepted; comments and blank
    lines are ignored. Surrounding single/double quotes are stripped.
    """
    import os

    if not env_file.exists():
        return
    try:
        for raw in env_file.read_text().splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            if line.startswith("export "):
                line = line[len("export ") :].lstrip()
            k, _, v = line.partition("=")
            k = k.strip()
            v = v.strip().strip('"').strip("'")
            if k:
                os.environ[k] = v
    except Exception:
        # Refuse to crash the wizard over a malformed env file — just skip.
        pass
