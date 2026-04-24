#!/usr/bin/env python3
"""
Onboarding CLI for the LinkedIn jobs scraper. Wraps Claude CLI to bootstrap a
personalized config.json from a CV + a free-text intent paragraph. Same stable
JSON CLI style as scheduler_ctl.py — the Vite middleware shells to it.

Commands (each reads JSON from stdin, emits a single JSON object on stdout):

  python3 onboarding_ctl.py generate
      stdin: {"cv": "<raw cv text>", "intent": "<user's intent paragraph>"}
      -> { ok: true, config: {...new-schema config...}, raw: "<claude raw>" }
         or { ok: false, error: "...", raw: "<claude raw or ''>" } exit 1

  python3 onboarding_ctl.py save
      stdin: {"cv": "<raw cv text>", "config": {...}}
      -> { ok: true } (also writes cv.txt, config.json, config.json.backup)
         or { ok: false, error: "..." } exit 1
      Note: with the multi-profile system, config.json is a symlink to the
      ACTIVE profile, so this overwrites the active profile in place.

  python3 onboarding_ctl.py save-as-profile
      stdin: {"cv": "<raw cv text>", "config": {...}, "profile_name": "<name>",
              "overwrite": false}
      -> { ok: true, profile, path } and activates the new profile (writes
         active_profile.txt + repoints config.json symlink). cv.txt is shared
         across profiles so we still write it. Default refuses to clobber an
         existing profile; pass overwrite=true to allow.

Failures always emit a JSON envelope — never a traceback.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

# Reuse the scraper's own parsing + normalization so the generated config goes
# through the exact same path load_config() would apply on next scrape. After
# the 2026-04 backend/ reorg, search.py lives one level up at backend/search.py,
# so we add THAT directory to sys.path (HERE = backend/ctl).
HERE = Path(__file__).resolve().parent  # backend/ctl/
sys.path.insert(0, str(HERE.parent))    # → backend/

# We only need these three helpers; don't trigger the full load_config() pass
# at import time beyond what search.py already does (it loads the currently-
# live config.json as a side effect — harmless here).
from search import (  # noqa: E402 — path juggling above
    _parse_claude_json,
    _normalize_categories,
    _hardcoded_defaults,
)

CV_PATH = HERE / "cv.txt"
CONFIG_PATH = HERE / "config.json"
CONFIG_BACKUP_PATH = HERE / "config.json.backup"
CONFIGS_DIR = HERE / "configs"
ACTIVE_FILE = HERE / "active_profile.txt"

# Mirrors profile_ctl.py's _NAME_RE; spec calls for ^[a-zA-Z0-9_-]{1,40}$.
# The leading-char restriction in profile_ctl is slightly stricter; we
# enforce both (must start with alnum) so save-as-profile and profile_ctl
# accept the same set of names.
_PROFILE_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_\-]{0,39}$")

CLAUDE_BIN = shutil.which("claude") or "/opt/homebrew/bin/claude"
CLAUDE_MODEL = "claude-sonnet-4-5"
CLAUDE_TIMEOUT_S = 180

# Cap the CV text we send to Claude so a huge paste doesn't push the prompt
# over the model's context window. 30k chars ~= 7.5k tokens, plenty for any
# real CV.
CV_MAX_CHARS = 30_000
INTENT_MAX_CHARS = 4_000


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


# ---------- meta-prompt ---------------------------------------------------

META_PROMPT_TEMPLATE = """You are generating a starter config.json for a personalized \
LinkedIn jobs scraper. The scraper searches LinkedIn with the user's queries, \
then ranks each result against the user's CV using another Claude call. Your \
job here is to translate the user's CV + intent paragraph into that config.

<cv>
{cv}
</cv>

<intent>
{intent}
</intent>

Produce a JSON object with EXACTLY these top-level keys and nothing else:

{{
  "categories":              [ {{"id": "<snake_case>", "name": "<display>", "type": "keyword"|"company", "queries": ["..."]}} ],
  "max_pages":               3,
  "geo_id":                  "" | "101620260" (Israel) | "103644278" (US) | "92000000" (Worldwide) | custom LinkedIn geoId string,
  "location":                "" or a human-readable location string from the CV,
  "priority_companies":      ["lowercased", "company", "names"],
  "claude_scoring_prompt":   "<full prompt template with {{cv}} and {{jobs_json}} placeholders>",
  "fit_positive_patterns":   ["<regex>", ...],
  "fit_negative_patterns":   ["<regex>", ...],
  "offtopic_title_patterns": ["<regex>", ...]
}}

Requirements:

1. categories: 2-4 entries.
   - One MUST have type="keyword" and be named roughly "Keywords" (id "keywords"),
     containing 5-8 LinkedIn search terms for the user's primary target role(s).
     Prefer short phrases real recruiters post (e.g. "staff backend engineer",
     "applied cryptography", "ML platform engineer"). No boolean syntax.
   - One MUST have type="company" and be named "Companies" (id "companies"),
     containing 5-15 company names the CV/intent suggest are targets.
   - Optionally add a second type="keyword" category for an adjacent role
     bucket (e.g. "Security Researcher" if the primary is crypto eng).
   - Each query string is plain text, no quotes, no wildcards.

2. priority_companies: 15-30 lowercased names. These are companies the user
   would open an email for first. Derive from CV (past employers' peers,
   competitor set) + intent paragraph. Lowercase ASCII only, no duplicates.

3. claude_scoring_prompt: a full template string with {{cv}} and {{jobs_json}}
   placeholders that the scraper substitutes at runtime. It should:
   - Reference the user's CV via the {{cv}} placeholder.
   - Accept a JSON array of jobs under {{jobs_json}}.
   - Ask Claude to return a JSON array of scoring objects, one per job,
     with keys: id, fit ("good"|"ok"|"skip"), score (1-10), reasons[], red_flags[].
   - Include HARD FILTERS the user definitely wants to skip (e.g. intern, VP+,
     sales, specific tech stacks they reject). Derive these from the intent
     paragraph — be concrete.
   - Describe what "good" means in 1-3 lines, also derived from intent.
   - End with <jobs>{{jobs_json}}</jobs>.
   - Use DOUBLE BRACES for JSON example shapes inside the string (since the
     scraper runs .format() on this — single braces break formatting).

4. fit_positive_patterns: 15-25 regex strings (Python re, case-insensitive
   assumed). Phrases matching these get a positive-fit boost in the regex
   fallback scorer (used when Claude is unreachable). Keep them narrow —
   match role / skill signals, not generic words.

5. fit_negative_patterns: 15-25 regex strings. Hard filters that knock a job
   out of consideration (e.g. "\\bintern\\b", "head of", sales keywords,
   stack keywords the user rejects).

6. offtopic_title_patterns: 20-40 regex strings matched against job TITLE only
   to drop obvious non-starters before any scoring (e.g. "\\bsales\\b",
   "\\brecruit", "\\bhead of\\b", "\\bvp\\b", "\\bdirector\\b" if the user
   wants IC roles, specific anti-stack keywords). These save Claude calls.

7. geo_id: pick from CV location if obvious — Israel=101620260, USA=103644278,
   else "" (session default). location: free-text from CV, or "".

8. max_pages: 3.

OUTPUT FORMAT — CRITICAL:
- Return ONLY the JSON object. No markdown fences. No prose before or after.
- No trailing commas. Valid JSON.
- Regex strings: escape backslashes properly for JSON (\\\\b not \\b in the \
raw JSON, since JSON requires \\\\ to represent a literal backslash).
- Do NOT wrap the output in ```json ... ```.
"""


def _build_meta_prompt(cv: str, intent: str) -> str:
    cv = (cv or "").strip()[:CV_MAX_CHARS]
    intent = (intent or "").strip()[:INTENT_MAX_CHARS]
    return META_PROMPT_TEMPLATE.format(cv=cv, intent=intent)


def _call_claude_cli(prompt: str) -> tuple[int, str, str]:
    """Try the local `claude` CLI. rc=127 + empty stdout signals 'not installed'
    so the caller can fall through to the SDK path."""
    if not shutil.which(CLAUDE_BIN) and not Path(CLAUDE_BIN).exists():
        return 127, "", f"claude CLI not found at {CLAUDE_BIN}"
    try:
        proc = subprocess.run(
            [CLAUDE_BIN, "-p", prompt,
             "--output-format", "text",
             "--model", CLAUDE_MODEL],
            capture_output=True, text=True, timeout=CLAUDE_TIMEOUT_S,
        )
        return proc.returncode, proc.stdout, proc.stderr
    except subprocess.TimeoutExpired as e:
        return 124, e.stdout or "", f"claude CLI timeout after {CLAUDE_TIMEOUT_S}s"
    except Exception as e:  # noqa: BLE001 — surface anything as a JSON error
        return 1, "", f"{type(e).__name__}: {e}"


def _call_claude_sdk(prompt: str) -> tuple[int, str, str]:
    """Anthropic SDK fallback — same model, requires ANTHROPIC_API_KEY env var.
    Mirrors search.py:_score_batch_via_sdk(). Returns the same (rc, stdout,
    stderr) shape as the CLI path so the caller treats them symmetrically."""
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return 127, "", "ANTHROPIC_API_KEY not set"
    try:
        from anthropic import Anthropic  # type: ignore
    except Exception as e:  # noqa: BLE001
        return 127, "", f"anthropic SDK not installed: {e}"
    try:
        client = Anthropic()
        msg = client.messages.create(
            model=CLAUDE_MODEL,
            max_tokens=8192,
            messages=[{"role": "user", "content": prompt}],
        )
        text = "".join(
            b.text for b in msg.content if getattr(b, "type", "") == "text"
        )
        return 0, text, ""
    except Exception as e:  # noqa: BLE001
        return 1, "", f"{type(e).__name__}: {e}"


def _call_claude(prompt: str) -> tuple[int, str, str]:
    """CLI first, then SDK. If both fail, surface a helpful install hint.

    A CLI exit of 127 (or our synthetic 127 for 'binary missing') means
    "not installed" — fall through to the SDK. A CLI rc != 0 due to a
    real error (auth, network) also falls through, since the SDK might
    succeed via a different auth path."""
    rc, stdout, stderr = _call_claude_cli(prompt)
    if rc == 0 and stdout.strip():
        return rc, stdout, stderr

    sdk_rc, sdk_stdout, sdk_stderr = _call_claude_sdk(prompt)
    if sdk_rc == 0 and sdk_stdout.strip():
        return sdk_rc, sdk_stdout, sdk_stderr

    # Both failed — pick the most actionable error message.
    cli_missing = (rc == 127)
    sdk_missing = (sdk_rc == 127)
    if cli_missing and sdk_missing:
        hint = (
            "Neither the `claude` CLI nor the Anthropic SDK is usable. "
            "Install one of:\n"
            "  - npm i -g @anthropic-ai/claude-code  (then run `claude /login`)\n"
            "  - pip install anthropic  (then export ANTHROPIC_API_KEY=sk-ant-…)"
        )
        return 1, "", hint
    # Otherwise surface whichever path actually ran but failed.
    parts = []
    if not cli_missing:
        parts.append(f"CLI rc={rc}: {(stderr or '').strip()[:300]}")
    if not sdk_missing:
        parts.append(f"SDK: {(sdk_stderr or '').strip()[:300]}")
    return 1, "", " | ".join(parts) or "claude unavailable"


# ---------- config validation / shape-up ---------------------------------

_KNOWN_GEO_IDS = {
    "92000000",     # Worldwide
    "101620260",    # Israel
    "103644278",    # United States
    "101165590",    # United Kingdom
    "91000000",     # Europe
}


def _validate_geo_id(value: str) -> str:
    """LinkedIn silently falls back to worldwide on bogus geoIds (no HTTP 400),
    so a typo would flood the funnel with US/EU jobs. Accept empty or all-digit
    strings; warn-but-keep on unknown digit sequences (might be a legit custom
    URN); drop non-digit garbage entirely so it can't reach LinkedIn."""
    if not value:
        return ""
    s = value.strip()
    if not s:
        return ""
    if not s.isdigit():
        print(
            f"warning: geo_id {value!r} is not a digit string — dropping",
            file=sys.stderr,
        )
        return ""
    if s not in _KNOWN_GEO_IDS:
        print(
            f"warning: geo_id {s!r} is not a known LinkedIn URN — accepting "
            "but verify before scraping",
            file=sys.stderr,
        )
    return s


def _validate_and_shape(raw_cfg: dict) -> dict:
    """Normalize a Claude-produced config to the on-disk schema. Missing /
    malformed keys fall back to hardcoded defaults so we never save garbage."""
    defaults = _hardcoded_defaults()

    if not isinstance(raw_cfg, dict):
        raise ValueError("config must be a JSON object")

    def _str(key: str, fb: str) -> str:
        v = raw_cfg.get(key)
        return v if isinstance(v, str) else fb

    def _str_list(key: str, fb: list) -> list:
        v = raw_cfg.get(key)
        if isinstance(v, list) and all(isinstance(s, str) for s in v):
            return [s.strip() for s in v if s.strip()]
        return fb

    categories = _normalize_categories(raw_cfg.get("categories"), defaults["categories"])
    if not categories:
        raise ValueError("categories must be a non-empty array")

    mp = raw_cfg.get("max_pages")
    if isinstance(mp, int) and 1 <= mp <= 20:
        max_pages = mp
    else:
        max_pages = 3

    # priority_companies: lowercased, deduped, order-preserving.
    pc_raw = _str_list("priority_companies", [])
    seen: set[str] = set()
    priority_companies: list[str] = []
    for p in pc_raw:
        lo = p.lower().strip()
        if lo and lo not in seen:
            seen.add(lo)
            priority_companies.append(lo)

    return {
        "categories": categories,
        "location": _str("location", ""),
        "date_filter": _str("date_filter", "r604800"),
        "geo_id": _validate_geo_id(_str("geo_id", "")),
        "max_pages": max_pages,
        "priority_companies": priority_companies,
        "claude_scoring_prompt": _str(
            "claude_scoring_prompt", defaults["claude_scoring_prompt"]
        ),
        "fit_positive_patterns": _str_list(
            "fit_positive_patterns", defaults["fit_positive_patterns"]
        ),
        "fit_negative_patterns": _str_list(
            "fit_negative_patterns", defaults["fit_negative_patterns"]
        ),
        "offtopic_title_patterns": _str_list(
            "offtopic_title_patterns", defaults["offtopic_title_patterns"]
        ),
    }


# ---------- commands ------------------------------------------------------

def cmd_generate(_args) -> None:
    try:
        body = _read_stdin_json()
    except Exception as e:
        _emit({"ok": False, "error": f"bad stdin: {e}"}, 1)

    cv = str(body.get("cv") or "")
    intent = str(body.get("intent") or "")
    if len(cv.strip()) < 100:
        _emit({"ok": False, "error": "cv must be >= 100 chars"}, 1)
    if len(intent.strip()) < 20:
        _emit({"ok": False, "error": "intent must be >= 20 chars"}, 1)

    prompt = _build_meta_prompt(cv, intent)
    rc, stdout, stderr = _call_claude(prompt)
    raw = (stdout or "").strip()

    if rc != 0:
        _emit({
            "ok": False,
            "error": f"claude exit {rc}: {(stderr or '').strip()[:400]}",
            "raw": raw,
        }, 1)

    parsed = _parse_claude_json(raw)
    if not isinstance(parsed, dict):
        _emit({
            "ok": False,
            "error": "could not parse Claude output as a JSON object",
            "raw": raw,
        }, 1)

    try:
        config = _validate_and_shape(parsed)
    except Exception as e:
        _emit({
            "ok": False,
            "error": f"generated config failed validation: {e}",
            "raw": raw,
        }, 1)

    _emit({"ok": True, "config": config, "raw": raw}, 0)


def _atomic_write(path: Path, data: str) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(data, encoding="utf-8")
    tmp.replace(path)


def _validate_profile_name(name: str) -> None:
    if not isinstance(name, str) or not _PROFILE_NAME_RE.match(name):
        raise ValueError(
            f"invalid profile_name {name!r} — must match {_PROFILE_NAME_RE.pattern}"
        )


def _repoint_config_symlink(profile_name: str) -> None:
    """Point config.json at configs/<profile_name>.json. Mirrors
    profile_ctl._repoint_symlink to keep the symlink-vs-symlink atomic
    swap behavior consistent across both CLIs."""
    target = CONFIGS_DIR / f"{profile_name}.json"
    rel = os.path.relpath(target, CONFIG_PATH.parent)
    tmp_link = CONFIG_PATH.parent / (CONFIG_PATH.name + ".linktmp")
    if tmp_link.exists() or tmp_link.is_symlink():
        tmp_link.unlink()
    os.symlink(rel, tmp_link)
    os.replace(tmp_link, CONFIG_PATH)


def _activate_profile(profile_name: str) -> None:
    """Write active_profile.txt and repoint config.json -> configs/<name>.json."""
    _validate_profile_name(profile_name)
    _atomic_write(ACTIVE_FILE, profile_name + "\n")
    _repoint_config_symlink(profile_name)


def cmd_save(_args) -> None:
    try:
        body = _read_stdin_json()
    except Exception as e:
        _emit({"ok": False, "error": f"bad stdin: {e}"}, 1)

    cv = body.get("cv")
    cfg = body.get("config")
    if not isinstance(cv, str) or not cv.strip():
        _emit({"ok": False, "error": "cv must be a non-empty string"}, 1)
    if not isinstance(cfg, dict):
        _emit({"ok": False, "error": "config must be an object"}, 1)

    try:
        shaped = _validate_and_shape(cfg)
    except Exception as e:
        _emit({"ok": False, "error": f"config validation failed: {e}"}, 1)

    # Safety net: if config.json already exists, copy it to config.json.backup
    # BEFORE we overwrite. Second-level backup (the user also has a full
    # source backup elsewhere).
    try:
        if CONFIG_PATH.exists():
            shutil.copy2(CONFIG_PATH, CONFIG_BACKUP_PATH)
    except Exception as e:
        _emit({"ok": False, "error": f"failed to write backup: {e}"}, 1)

    # Write cv.txt first (atomic). If config write fails, we've at least
    # captured the CV and the user can retry.
    try:
        _atomic_write(CV_PATH, cv)
    except Exception as e:
        _emit({"ok": False, "error": f"failed to write cv.txt: {e}"}, 1)

    try:
        _atomic_write(
            CONFIG_PATH,
            json.dumps(shaped, indent=2, ensure_ascii=False) + "\n",
        )
    except Exception as e:
        _emit({"ok": False, "error": f"failed to write config.json: {e}"}, 1)

    _emit({
        "ok": True,
        "cv_path": str(CV_PATH),
        "config_path": str(CONFIG_PATH),
        "backup_path": str(CONFIG_BACKUP_PATH) if CONFIG_BACKUP_PATH.exists() else None,
    }, 0)


def cmd_save_as_profile(_args) -> None:
    try:
        body = _read_stdin_json()
    except Exception as e:
        _emit({"ok": False, "error": f"bad stdin: {e}"}, 1)

    cv = body.get("cv")
    cfg = body.get("config")
    profile_name = body.get("profile_name")
    overwrite = bool(body.get("overwrite") or False)

    if not isinstance(cv, str) or not cv.strip():
        _emit({"ok": False, "error": "cv must be a non-empty string"}, 1)
    if not isinstance(cfg, dict):
        _emit({"ok": False, "error": "config must be an object"}, 1)
    if not isinstance(profile_name, str):
        _emit({"ok": False, "error": "profile_name must be a string"}, 1)
    try:
        _validate_profile_name(profile_name)
    except ValueError as e:
        _emit({"ok": False, "error": str(e)}, 1)

    try:
        shaped = _validate_and_shape(cfg)
    except Exception as e:
        _emit({"ok": False, "error": f"config validation failed: {e}"}, 1)

    # Make sure configs/ exists. Don't trigger a full migration here — that's
    # profile_ctl.py's job, and by the time the UI calls save-as-profile the
    # symlink should already be in place.
    CONFIGS_DIR.mkdir(parents=True, exist_ok=True)
    profile_path = CONFIGS_DIR / f"{profile_name}.json"
    if profile_path.exists() and not overwrite:
        _emit({
            "ok": False,
            "error": (
                f"profile {profile_name!r} already exists; "
                "pass overwrite=true to replace it"
            ),
        }, 1)

    # Write CV first (shared across profiles). If the profile write fails we
    # at least kept the user's CV.
    try:
        _atomic_write(CV_PATH, cv)
    except Exception as e:
        _emit({"ok": False, "error": f"failed to write cv.txt: {e}"}, 1)

    # Write the new profile config atomically.
    try:
        _atomic_write(
            profile_path,
            json.dumps(shaped, indent=2, ensure_ascii=False) + "\n",
        )
    except Exception as e:
        _emit({"ok": False, "error": f"failed to write {profile_path}: {e}"}, 1)

    # Activate it (active_profile.txt + symlink retarget).
    try:
        _activate_profile(profile_name)
    except Exception as e:
        _emit({"ok": False, "error": f"failed to activate profile: {e}"}, 1)

    _emit({
        "ok": True,
        "profile": profile_name,
        "path": str(profile_path),
        "cv_path": str(CV_PATH),
    }, 0)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("generate").set_defaults(func=cmd_generate)
    sub.add_parser("save").set_defaults(func=cmd_save)
    sub.add_parser("save-as-profile").set_defaults(func=cmd_save_as_profile)
    args = p.parse_args()
    try:
        args.func(args)
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        _emit({"ok": False, "error": f"{type(e).__name__}: {e}"}, 1)


if __name__ == "__main__":
    main()
