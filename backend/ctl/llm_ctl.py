#!/usr/bin/env python3
"""
LLM-provider CLI for the welcome wizard. Three commands:

  list           — emit the 6 providers + metadata for the picker UI
  test           — {name} on stdin → calls backend.llm.test_provider()
  save-credential — {name, key} on stdin → atomic-writes the env-var line
                    into ~/.linkedin-jobs.env (chmod 600). Refuses for
                    providers without an env_var (claude_cli, ollama).

NEVER logs the key value (not even on error). Same stable JSON CLI style
as preflight_ctl.py / scheduler_ctl.py.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent  # backend/ctl/
ROOT = HERE.parent.parent
sys.path.insert(0, str(HERE.parent))    # → backend/
sys.path.insert(0, str(ROOT))           # so `from backend.llm` resolves

from backend.llm import test_provider, PROVIDERS  # noqa: E402

ENV_FILE = Path.home() / ".linkedin-jobs.env"

# Per-provider metadata for the wizard's picker. Order matters — drives the
# left-to-right card order in the UI grid.
PROVIDER_META = [
    {
        "name": "claude_cli",
        "label": "Claude Code (CLI)",
        "needs_key": False,
        "free_tier": False,
        "env_var": None,
        "help_url": "https://docs.claude.com/claude-code",
        "blurb": "Uses the `claude` command-line tool. Best quality. Requires "
                 "Claude Code installed and signed in (`npm i -g @anthropic-ai/claude-code`).",
    },
    {
        "name": "claude_sdk",
        "label": "Claude API (key)",
        "needs_key": True,
        "free_tier": False,
        "env_var": "ANTHROPIC_API_KEY",
        "help_url": "https://console.anthropic.com/settings/keys",
        "blurb": "Direct Anthropic API. Pay per call, fast, top quality.",
    },
    {
        "name": "gemini",
        "label": "Google Gemini",
        "needs_key": True,
        "free_tier": True,
        "env_var": "GEMINI_API_KEY",
        "help_url": "https://aistudio.google.com/apikey",
        "blurb": "Google's Gemini 2.5 Flash. Free tier available — recommended for fresh installs.",
    },
    {
        "name": "openai",
        "label": "OpenAI",
        "needs_key": True,
        "free_tier": False,
        "env_var": "OPENAI_API_KEY",
        "help_url": "https://platform.openai.com/api-keys",
        "blurb": "GPT-4o-mini. Reliable but no free tier — pay per call.",
    },
    {
        "name": "openrouter",
        "label": "OpenRouter",
        "needs_key": True,
        "free_tier": True,
        "env_var": "OPENROUTER_API_KEY",
        "help_url": "https://openrouter.ai/keys",
        "blurb": "Routes to many models including free Llama 3.3. Variable quality.",
    },
    {
        "name": "ollama",
        "label": "Ollama (local)",
        "needs_key": False,
        "free_tier": True,
        "env_var": None,
        "help_url": "https://ollama.com/download",
        "blurb": "Runs a local model (qwen2.5:32b default). Free, fully offline. "
                 "Requires `ollama serve` running with the model pulled.",
    },
]


def _emit(obj: dict, code: int = 0) -> None:
    print(json.dumps(obj, indent=2, ensure_ascii=False))
    sys.exit(code)


def _read_stdin_json() -> dict:
    raw = sys.stdin.read()
    if not raw.strip():
        raise ValueError("empty stdin")
    obj = json.loads(raw)
    if not isinstance(obj, dict):
        raise ValueError("stdin must be a JSON object")
    return obj


def cmd_list() -> None:
    _emit({"ok": True, "providers": PROVIDER_META})


def cmd_test() -> None:
    try:
        body = _read_stdin_json()
    except Exception as e:  # noqa: BLE001
        _emit({"ok": False, "error": f"bad stdin: {e}"}, code=1)
    name = body.get("name") or "auto"
    if not isinstance(name, str):
        _emit({"ok": False, "error": "name must be a string"}, code=1)
    # Re-load any creds the caller just saved into ~/.linkedin-jobs.env.
    _load_env_file()
    ok, message = test_provider(name)
    _emit({"ok": ok, "message": message, "name": name})


def _load_env_file() -> None:
    """Read ~/.linkedin-jobs.env (if exists) and set os.environ for any
    keys not already present in the parent shell. Lets a save-credential
    + test pair in the same wizard step actually see the new key."""
    if not ENV_FILE.exists():
        return
    try:
        for raw in ENV_FILE.read_text().splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            k = k.strip()
            v = v.strip().strip('"').strip("'")
            if k:
                os.environ[k] = v
    except Exception:
        # Refuse to crash the wizard over a malformed env file — just skip.
        pass


def _atomic_write_env(env_var: str, key_value: str) -> None:
    """Update or append `<env_var>=<key_value>` in ~/.linkedin-jobs.env.
    Atomic via temp + rename. chmod 600. Never logs the key value."""
    ENV_FILE.parent.mkdir(parents=True, exist_ok=True)
    existing_lines: list[str] = []
    if ENV_FILE.exists():
        try:
            existing_lines = ENV_FILE.read_text().splitlines()
        except Exception:
            existing_lines = []
    out_lines: list[str] = []
    replaced = False
    for line in existing_lines:
        stripped = line.strip()
        if stripped.startswith(f"{env_var}=") or stripped.startswith(f"export {env_var}="):
            if not replaced:
                out_lines.append(f"{env_var}={key_value}")
                replaced = True
            # drop subsequent duplicates
        else:
            out_lines.append(line)
    if not replaced:
        out_lines.append(f"{env_var}={key_value}")
    body = "\n".join(out_lines).rstrip("\n") + "\n"
    tmp = ENV_FILE.with_suffix(ENV_FILE.suffix + ".tmp")
    tmp.write_text(body)
    try:
        os.chmod(tmp, 0o600)
    except Exception:
        pass
    os.replace(tmp, ENV_FILE)
    try:
        os.chmod(ENV_FILE, 0o600)
    except Exception:
        pass


def cmd_save_credential() -> None:
    try:
        body = _read_stdin_json()
    except Exception as e:  # noqa: BLE001
        _emit({"ok": False, "error": f"bad stdin: {e}"}, code=1)
    name = body.get("name")
    key_value = body.get("key")
    if not isinstance(name, str) or not name:
        _emit({"ok": False, "error": "name must be a non-empty string"}, code=1)
    if not isinstance(key_value, str) or not key_value.strip():
        _emit({"ok": False, "error": "key must be a non-empty string"}, code=1)
    meta = next((m for m in PROVIDER_META if m["name"] == name), None)
    if meta is None:
        _emit({"ok": False, "error": f"unknown provider: {name}"}, code=1)
    env_var = meta.get("env_var")
    if not env_var:
        _emit({"ok": False,
               "error": f"provider '{name}' has no env_var — does not need a key"},
              code=1)
    try:
        _atomic_write_env(env_var, key_value.strip())
    except Exception as e:  # noqa: BLE001
        # Error message refers to the env_var name, NEVER the key value.
        _emit({"ok": False,
               "error": f"failed to write {ENV_FILE} ({env_var}): {type(e).__name__}: {e}"},
              code=1)
    # Make the new key visible to the same-process test() that follows.
    os.environ[env_var] = key_value.strip()
    _emit({"ok": True, "env_var": env_var, "env_file": str(ENV_FILE)})


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd")
    sub.add_parser("list")
    sub.add_parser("test")
    sub.add_parser("save-credential")
    args = parser.parse_args()
    if args.cmd == "list":
        cmd_list()
    if args.cmd == "test":
        cmd_test()
    if args.cmd == "save-credential":
        cmd_save_credential()
    parser.print_help()
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        _emit({"ok": False, "error": f"{type(e).__name__}: {e}"}, code=1)
