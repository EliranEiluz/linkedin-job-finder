#!/usr/bin/env python3
"""
Config-suggester CLI for the LinkedIn jobs scraper. Reads the user's feedback
signals from results.json (manual-adds, ratings, kanban progress), pairs them
with the live config.json, and asks Claude to propose config tweaks:

    - new search queries (per category)
    - new priority_companies
    - off-topic title regex tweaks (titles to drop pre-scoring)

The Vite middleware at /api/config/suggest shells to this script; the UI
renders the structured suggestions as a checkbox modal so the user can
opt-in per item before the existing /api/config save endpoint persists them.

Usage (single command — read JSON from stdin, emit a single JSON object on
stdout):

    python3 config_suggest_ctl.py
        stdin: {} (currently no params; placeholder for future filters)
        -> { ok: true, suggestions: {add_queries, add_companies,
                                     regex_tweaks, reasoning},
             signal_count, raw }
           or { ok: false, error: "...", raw: "..." } exit 1

Failures always emit a JSON envelope — never a traceback.

Routes through the backend.llm provider abstraction so any configured
provider (claude_cli / claude_sdk / gemini / openrouter / ollama) works.
If no provider is set up we surface a structured error.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import NoReturn

# Reuse the scraper's existing feedback-signal classifier + recency sort
# (search.py owns the canonical definitions of "what counts as feedback").
# Spec calls this out explicitly: do NOT reimplement signal classification.
HERE = Path(__file__).resolve().parent  # backend/ctl/
ROOT = HERE.parent.parent  # project root (two levels up)
sys.path.insert(0, str(HERE.parent))  # → backend/
sys.path.insert(0, str(ROOT))  # → project root, so `from backend.llm` resolves

# Route LLM calls through the provider abstraction so users on Gemini /
# OpenRouter / Ollama can run the suggester without a Claude account.
from backend.llm import complete as llm_complete  # noqa: E402  (sys.path shim above)
from backend.llm import get_provider  # noqa: E402  (sys.path shim above)
from backend.search import (  # noqa: E402  (sys.path shim above)
    _classify_feedback_row,
    _clean_title,
    _example_recency_key,
    _parse_claude_json,
)

RESULTS_PATH = ROOT / "results.json"
CONFIG_PATH = ROOT / "config.json"

# Threshold below which we refuse to call Claude — too few signals would
# produce noise, not insight. Mirrored as a constant in the UI so the
# button-disabled state matches the backend's refusal exactly.
MIN_SIGNALS_FOR_SUGGEST = 5

# Cap on signal rows we send to Claude. Stratified 15 newest pos + 15 newest
# neg (recency-sorted). Keeps the prompt under a few thousand tokens.
SAMPLE_CAP = 30
PER_BUCKET_CAP = 15

LLM_MAX_TOKENS = 4096

# Per-row text caps — keeps any single example from blowing the prompt.
TITLE_CAP = 80
COMPANY_CAP = 40
COMMENT_CAP = 120


def _emit(obj: dict, code: int = 0) -> NoReturn:
    print(json.dumps(obj, indent=2, ensure_ascii=False))
    sys.exit(code)


def _read_stdin_json() -> dict:
    raw = sys.stdin.read()
    if not raw.strip():
        return {}  # no params required; empty stdin is valid
    obj = json.loads(raw)
    if not isinstance(obj, dict):
        raise TypeError("stdin must be a JSON object")
    return obj


def _truncate(s: str, n: int) -> str:
    s = (s or "").strip()
    if len(s) <= n:
        return s
    return s[: max(0, n - 1)].rstrip() + "…"


def _format_row_for_prompt(row: dict, summary: str) -> dict:
    """Strip a corpus row to the fields Claude needs to reason about config
    tweaks. Drops URLs, descriptions, ids, history — privacy + token budget."""
    return {
        "title": _truncate(_clean_title(row.get("title", "")), TITLE_CAP),
        "company": _truncate((row.get("company") or "").strip(), COMPANY_CAP),
        "category": (row.get("category") or "").strip(),
        "query": (row.get("query") or "").strip(),
        "fit": (row.get("fit") or "").strip(),
        "source": (row.get("source") or "").strip(),
        "signal": _truncate(summary, COMMENT_CAP + 40),
    }


def _gather_signals() -> tuple[list[dict], list[dict]]:
    """Return (positive_rows, negative_rows), each pre-formatted for the prompt
    and capped to PER_BUCKET_CAP newest-first. Empty lists on missing /
    unparseable corpus."""
    if not RESULTS_PATH.exists():
        return [], []
    try:
        corpus = json.loads(RESULTS_PATH.read_text())
    except Exception:
        return [], []
    if not isinstance(corpus, list):
        return [], []

    pos: list[tuple[str, dict, str]] = []
    neg: list[tuple[str, dict, str]] = []
    for row in corpus:
        sentiment, summary = _classify_feedback_row(row)
        if not sentiment:
            continue
        key = _example_recency_key(row)
        bucket = pos if sentiment == "pos" else neg
        bucket.append((key, row, summary))

    # Newest first.
    pos.sort(key=lambda t: t[0], reverse=True)
    neg.sort(key=lambda t: t[0], reverse=True)

    pos_take = [_format_row_for_prompt(r, s) for _, r, s in pos[:PER_BUCKET_CAP]]
    neg_take = [_format_row_for_prompt(r, s) for _, r, s in neg[:PER_BUCKET_CAP]]
    return pos_take, neg_take


def _load_config_summary() -> dict:
    """Project the live config.json down to the fields Claude needs to spot
    gaps. We send the categories + priority_companies + offtopic patterns so
    Claude can avoid suggesting items already present."""
    if not CONFIG_PATH.exists():
        return {
            "categories": [],
            "priority_companies": [],
            "offtopic_title_patterns": [],
        }
    try:
        cfg = json.loads(CONFIG_PATH.read_text())
    except Exception:
        return {
            "categories": [],
            "priority_companies": [],
            "offtopic_title_patterns": [],
        }
    cats = cfg.get("categories") if isinstance(cfg, dict) else None
    cats_out: list[dict] = []
    if isinstance(cats, list):
        for c in cats:
            if not isinstance(c, dict):
                continue
            cats_out.append(
                {
                    "id": str(c.get("id") or ""),
                    "name": str(c.get("name") or ""),
                    "type": str(c.get("type") or ""),
                    "queries": [str(q) for q in (c.get("queries") or []) if isinstance(q, str)],
                }
            )
    pc = cfg.get("priority_companies") if isinstance(cfg, dict) else None
    pc_out = [str(p) for p in (pc or []) if isinstance(p, str)]
    ot = cfg.get("offtopic_title_patterns") if isinstance(cfg, dict) else None
    ot_out = [str(p) for p in (ot or []) if isinstance(p, str)]
    return {
        "categories": cats_out,
        "priority_companies": pc_out,
        "offtopic_title_patterns": ot_out,
    }


# ---------- Claude meta-prompt -------------------------------------------

META_PROMPT_TEMPLATE = """You suggest tweaks to a personal LinkedIn job-scraper \
config based on the user's recent feedback. The user rates jobs, drags them \
across a kanban (interview / take-home / offer / rejected / withdrew), and \
sometimes manually adds jobs they found elsewhere. Each of those is a signal \
about what they actually want — read them carefully.

CURRENT CONFIG (the parts you can suggest changes to):
<current_config>
{config_json}
</current_config>

USER FEEDBACK SIGNALS — recent first, stratified positive vs negative.
The "signal" field on each row encodes what the user did: "rated 5/5", \
"reached 'interview' in pipeline", "manually added by user", "ended in \
'rejected'", etc. Treat 'interview'/'take-home'/'offer' and manual-adds \
as the strongest positive evidence — the user actually engaged with that \
job. 1-2 star ratings and 'rejected'/'withdrew' are negative.

<positive_signals>
{pos_json}
</positive_signals>

<negative_signals>
{neg_json}
</negative_signals>

YOUR JOB — propose config changes that would surface MORE jobs like the \
positive signals and FEWER like the negative ones. Specifically:

1. add_queries: new LinkedIn search terms to add to an EXISTING category.
   - Pick the right category_id from current_config.categories. If a positive \
     signal cluster doesn't fit any existing category, skip it (don't \
     hallucinate a new category — the user can add one manually).
   - Don't suggest a query already present in that category.queries.
   - Keep queries short, real recruiter-language phrases (no boolean ops, \
     no quotes). 1-5 suggestions max.

2. add_companies: new entries for priority_companies (lowercased).
   - Skip any company already in priority_companies (case-insensitive).
   - Strong source: companies the user manually added or interviewed with. \
     Companies merely scraped + ignored are NOT a signal.
   - 0-5 suggestions max.

3. regex_tweaks: regex patterns to add to offtopic_title_patterns (titles \
   matching these get dropped before scoring).
   - Only suggest when the user clearly down-rated multiple jobs of the same \
     off-topic flavor (e.g. several 1/5 sales-engineer rejects). Don't fish.
   - Use Python re syntax with (?i) prefix for case-insensitivity. Escape \
     backslashes properly for JSON (\\\\b not \\b in raw JSON).
   - 0-3 suggestions max. Action is always "add_to_off_topic".

4. reasoning: ONE short paragraph (2-4 sentences) summarizing the overall \
   pattern you saw. Plain English, no markdown.

Each suggestion needs a 1-sentence "reason" citing specific signals \
("user rated 3 sales-engineer jobs ≤2/5"). No vague rationale.

If a category has nothing to suggest, return an empty array for it. If \
ALL arrays would be empty, still return the JSON shape with the reasoning \
filled in.

OUTPUT FORMAT — CRITICAL:
Return ONLY the JSON object below. No markdown fences. No prose before or \
after. Valid JSON, no trailing commas.

{{
  "add_queries": [
    {{"query": "<text>", "category_id": "<id from current_config>", \
"reason": "<short>"}}
  ],
  "add_companies": [
    {{"name": "<lowercased>", "reason": "<short>"}}
  ],
  "regex_tweaks": [
    {{"pattern": "<regex>", "action": "add_to_off_topic", "reason": "<short>"}}
  ],
  "reasoning": "<one paragraph>"
}}
"""


def _build_prompt(pos: list[dict], neg: list[dict], cfg_summary: dict) -> str:
    return META_PROMPT_TEMPLATE.format(
        config_json=json.dumps(cfg_summary, indent=2, ensure_ascii=False),
        pos_json=json.dumps(pos, indent=2, ensure_ascii=False),
        neg_json=json.dumps(neg, indent=2, ensure_ascii=False),
    )


# ---------- LLM invocation (via provider abstraction) --------------------


def _call_llm(prompt: str) -> tuple[int, str, str]:
    """Route through backend.llm.complete so any configured provider works
    (claude_cli / claude_sdk / gemini / openrouter / ollama). Same (rc, out,
    err) shape callers already expect. rc=0 success, rc=1 any failure."""
    provider = get_provider()
    if provider is None:
        return (
            1,
            "",
            (
                "No LLM provider available. Set ANTHROPIC_API_KEY, GEMINI_API_KEY, "
                "or OPENROUTER_API_KEY (in ~/.linkedin-jobs.env), install the "
                "`claude` CLI (npm i -g @anthropic-ai/claude-code), or run "
                "`ollama serve` locally with a model pulled."
            ),
        )
    try:
        text = llm_complete(prompt, max_tokens=LLM_MAX_TOKENS, json_mode=True)
    except Exception as e:
        return 1, "", f"[{provider.name}] {type(e).__name__}: {e}"
    if not text or not text.strip():
        return 1, "", f"[{provider.name}] empty response"
    return 0, text, ""


# ---------- shape validation ---------------------------------------------


def _shape_suggestions(parsed: dict) -> dict:
    """Coerce Claude's output into the expected shape. Missing/garbage fields
    become empty lists / empty strings — never raise. The UI is the only
    consumer, and it tolerates empty arrays gracefully."""
    if not isinstance(parsed, dict):
        return {
            "add_queries": [],
            "add_companies": [],
            "regex_tweaks": [],
            "reasoning": "",
        }

    def _list_of_dicts(key: str, required_keys: tuple[str, ...]) -> list[dict]:
        v = parsed.get(key)
        if not isinstance(v, list):
            return []
        out: list[dict] = []
        for item in v:
            if not isinstance(item, dict):
                continue
            if not all(isinstance(item.get(k), str) and item.get(k) for k in required_keys):
                continue
            out.append(
                {
                    k: str(item.get(k) or "").strip()
                    for k in (*required_keys, "reason")
                    if k in required_keys or k == "reason"
                }
            )
        return out

    add_queries = []
    for item in parsed.get("add_queries") or []:
        if not isinstance(item, dict):
            continue
        q = (item.get("query") or "").strip()
        cid = (item.get("category_id") or "").strip()
        reason = (item.get("reason") or "").strip()
        if q and cid:
            add_queries.append({"query": q, "category_id": cid, "reason": reason})

    add_companies = []
    seen_co: set[str] = set()
    for item in parsed.get("add_companies") or []:
        if not isinstance(item, dict):
            continue
        name = (item.get("name") or "").strip().lower()
        reason = (item.get("reason") or "").strip()
        if name and name not in seen_co:
            seen_co.add(name)
            add_companies.append({"name": name, "reason": reason})

    regex_tweaks = []
    for item in parsed.get("regex_tweaks") or []:
        if not isinstance(item, dict):
            continue
        pat = (item.get("pattern") or "").strip()
        action = (item.get("action") or "add_to_off_topic").strip()
        reason = (item.get("reason") or "").strip()
        if pat:
            regex_tweaks.append(
                {
                    "pattern": pat,
                    "action": action or "add_to_off_topic",
                    "reason": reason,
                }
            )

    reasoning = parsed.get("reasoning")
    if not isinstance(reasoning, str):
        reasoning = ""

    return {
        "add_queries": add_queries,
        "add_companies": add_companies,
        "regex_tweaks": regex_tweaks,
        "reasoning": reasoning.strip(),
    }


# ---------- main ---------------------------------------------------------


def main() -> None:
    try:
        _ = _read_stdin_json()
    except Exception as e:
        _emit({"ok": False, "error": f"bad stdin: {e}"}, 1)

    pos, neg = _gather_signals()
    signal_count = len(pos) + len(neg)
    if signal_count < MIN_SIGNALS_FOR_SUGGEST:
        _emit(
            {
                "ok": False,
                "error": (
                    f"need at least {MIN_SIGNALS_FOR_SUGGEST} feedback signals "
                    f"(rated/applied/manual-added jobs); have {signal_count}"
                ),
                "signal_count": signal_count,
            },
            1,
        )

    cfg_summary = _load_config_summary()
    prompt = _build_prompt(pos, neg, cfg_summary)

    rc, stdout, stderr = _call_llm(prompt)
    raw = (stdout or "").strip()

    if rc != 0:
        _emit(
            {
                "ok": False,
                "error": f"llm error: {(stderr or '').strip()[:400]}",
                "raw": raw,
                "signal_count": signal_count,
            },
            1,
        )

    parsed = _parse_claude_json(raw)
    if not isinstance(parsed, dict):
        _emit(
            {
                "ok": False,
                "error": "could not parse Claude output as a JSON object",
                "raw": raw,
                "signal_count": signal_count,
            },
            1,
        )

    suggestions = _shape_suggestions(parsed)
    _emit(
        {
            "ok": True,
            "suggestions": suggestions,
            "signal_count": signal_count,
            "raw": raw,
        },
        0,
    )


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        _emit({"ok": False, "error": f"{type(e).__name__}: {e}"}, 1)
