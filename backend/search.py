#!/usr/bin/env python3
"""
LinkedIn job search — Playwright + persistent browser session.

Setup:
  pip install playwright && playwright install chromium

First run:
  python search.py
  A visible browser will open to the LinkedIn login page. Log in manually
  (use a throwaway account — LinkedIn may flag automation). Once you see
  your feed, return to the terminal and press Enter. The session is saved
  to linkedin_session.json so subsequent runs skip the login step.

Subsequent runs:
  python search.py
  The saved session is loaded automatically.

If the session expires, the script deletes the session file and asks you
to re-run to log in fresh.

Results saved to results.json. Re-runs skip already-seen jobs.
Pass --all to also show previously seen jobs.
Pass --no-enrich to skip description fetching (faster).
"""

import json
import os
import sys
import time
import argparse
import re
import random
import shutil
import traceback
from datetime import datetime
from pathlib import Path
from urllib.parse import quote_plus

# When run as `python3 backend/search.py`, sys.path[0] is backend/ — so
# `from backend.llm import ...` would 404. Prepend the repo root so the
# `backend` namespace package is importable in both script and `-m` modes.
_REPO_ROOT = str(Path(__file__).resolve().parent.parent)
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)
# Playwright is the engine for --mode=loggedin. Imported lazily so that
# --mode=guest can run on a stripped-down Python install (e.g. the one
# launchd picks up from a minimal PATH) without playwright present.
# `_require_playwright()` materializes the imports on demand and surfaces
# a clean install command if it's missing.

sync_playwright = None  # type: ignore[assignment]
PlaywrightTimeout = Exception  # placeholder until we resolve the real one


def _require_playwright():
    """Import playwright on demand; cache results in module globals.
    Raises a clean-message ImportError if the package isn't available."""
    global sync_playwright, PlaywrightTimeout
    if sync_playwright is not None and PlaywrightTimeout is not Exception:
        return
    try:
        from playwright.sync_api import (
            sync_playwright as _sp,
            TimeoutError as _PT,
        )
    except ImportError as e:
        raise ImportError(
            "Playwright is required for --mode=loggedin but isn't installed.\n"
            "Install it into THIS Python with:\n"
            f"  {sys.executable} -m pip install playwright\n"
            f"  {sys.executable} -m playwright install chromium\n"
            "(--mode=guest does NOT need playwright and works without it.)"
        ) from e
    sync_playwright = _sp
    PlaywrightTimeout = _PT

# Line-buffered stdout so long runs stream progress.
try:
    sys.stdout.reconfigure(line_buffering=True)
except Exception:
    pass

# ---------- CONFIG ----------

# Trimmed from 30 → 6. Stemming overlap collapsed (recruiters hit the same
# postings across "cryptography engineer" vs "applied cryptography engineer"
# vs "cryptography research engineer"). LinkedIn's keyword match is already
# fuzzy.
SEARCH_QUERIES = [
    "cryptography engineer",
    "applied cryptography",
    "zero knowledge engineer",
    "MPC engineer",
    "confidential computing",
    "protocol engineer cryptography",
]

# Security researcher track — trimmed from 10 → 3.
SECURITY_RESEARCHER_QUERIES = [
    "security researcher",
    "vulnerability researcher",
    "detection engineer",
]

# Top target companies — hit these directly instead of relying on keyword search.
COMPANY_QUERIES = [
    # — Existing targets —
    "Fireblocks",
    "StarkWare",
    "Ingonyama",
    "Fortanix",
    "Zama",
    # — Added 2026-04 — Israeli crypto R&D (top signal) —
    "Fhenix",
    "Chain Reaction",
    "Sodot",
    "Lattica",
    "Soda Labs",
    # — Added 2026-04 — Global crypto-first w/ active hiring —
    "Irreducible",
    "Mysten Labs",
    "Arcium",
]

# Generic category schema (introduced 2026-04-22 in Phase A of the genericisation
# refactor). Each category groups related queries and tags them with a TYPE that
# controls scraper behavior:
#   - "keyword": runs the term through LinkedIn search; applies token-relevance
#                filtering against title+company.
#   - "company": runs the term as a company-name search; requires the company
#                name to literally appear in the result's company field.
# Module-level CATEGORIES is the single source of truth at runtime. The legacy
# SEARCH_QUERIES / SECURITY_RESEARCHER_QUERIES / COMPANY_QUERIES lists above
# seed the defaults so existing config.json files (and old behavior) keep
# working through migration.
CATEGORIES: list[dict] = [
    {"id": "crypto", "name": "Crypto", "type": "keyword",
     "queries": list(SEARCH_QUERIES)},
    {"id": "security_researcher", "name": "Security Researcher",
     "type": "keyword", "queries": list(SECURITY_RESEARCHER_QUERIES)},
    {"id": "company", "name": "Companies", "type": "company",
     "queries": list(COMPANY_QUERIES)},
]

LOCATION = ""  # empty = worldwide/no filter, "Israel" or "Tel Aviv" to narrow
DATE_FILTER = "r604800"  # r86400=1d, r604800=7d, r2592000=30d

# LinkedIn logged-in sessions silently home-filter to the account's
# registered location — keyword searches are implicitly scoped to your
# account's home country. If you want to widen scope, set this to one
# of: Worldwide=92000000, United States=103644278, Israel=101620260.
# Leaving it empty keeps the session's home-geo behavior.
GEO_ID = ""

# Optional LinkedIn filter codes (empty string = off). Verified April 2026.
#   f_E  : seniority (2=entry, 3=assoc, 4=mid-senior, 5=director, 6=exec).
#          "3,4" = mid-senior IC without Director; "4" alone = pure mid-senior.
#   f_JT : job type (F=full-time, P=part-time, C=contract, T=temp, I=internship)
#   f_WT : workplace (1=on-site, 2=remote, 3=hybrid); combine e.g. "2,3".
# We leave these off by default so we don't narrow the funnel prematurely —
# Claude's fit-scoring filters seniority/contract type from the description.
EXPERIENCE_FILTER = ""   # e.g. "3,4"
JOB_TYPE_FILTER = ""     # e.g. "F"
WORKPLACE_FILTER = ""    # e.g. "2,3"

# Jobs at these companies are always highlighted
PRIORITY_COMPANIES = {
    # Existing
    "fireblocks", "starkware", "ingonyama", "fortanix", "opaque",
    "aztec", "scroll", "consensys", "zama", "a16z", "paradigm",
    # ZK proving systems
    "risc zero", "risc0", "succinct", "succinct labs",
    "polygon", "polygon zero", "polygon labs",
    "matter labs", "zksync", "taiko", "espresso systems",
    "nil foundation", "lagrange", "lagrange labs",
    "o1 labs", "mina", "aleo", "aleph zero",
    # MPC / threshold / wallet infra
    "coinbase", "anchorage", "copper", "silence laboratories",
    "partisia", "nillion",
    # FHE / confidential computing
    "duality technologies", "enveil", "anjuna", "edgeless systems",
    # Israeli ecosystem
    "qedit", "qed-it", "coti", "zengo", "kzen",
    "wiz", "pillar security", "prompt security",
    "aim security", "noma security",
    # AI security
    "protect ai", "lakera", "hiddenlayer",

    # ==== Added 2026-04 from targeted crypto-company research ====
    # Criteria: crypto-first product OR published cryptographer on staff OR
    # IACR paper output. Big-co generalists (MS/NVIDIA/Google) intentionally
    # NOT added — too noisy; their crypto jobs will be caught by keyword
    # queries like "cryptography engineer" on their own.

    # — Israeli crypto R&D shops —
    "fhenix", "chain reaction", "chain-reaction",
    "sodot", "lattica", "lattica ai",
    "soda labs", "sodalabs",
    "gk8", "hub security", "hub cyber security",
    "pentera", "cyberark", "dfns",

    # — ZK proving systems / zkVMs / ZK coprocessors (global) —
    "inco network", "inco",
    "sunscreen", "cysic",
    "irreducible", "ulvetanna",
    "nexus", "nexus xyz",
    "mysten labs", "mysten", "sui",
    "brevis network", "brevis",
    "axiom", "herodotus", "pragma",
    "geometry research", "geometry",
    "modulus labs", "ezkl", "zkonduit",

    # — MPC / threshold / wallet infra (global) —
    "arcium", "elusiv",
    "turnkey", "blyss",

    # — Audit / research shops with strong cryptographers —
    "trail of bits", "zksecurity", "veridise",

    # — Crypto-first L2s / decentralized inference / niche —
    "ritual", "manta network",
    "chainway labs", "chainway", "citrea",
    "zircuit", "gevulot",
    "ten protocol", "obscuro",

    # — Foundations / research orgs —
    "ethereum foundation", "pse",
}

# MSc requirement signals in job descriptions
MSC_PATTERNS = [
    r"\bm\.?sc\b", r"\bmaster[\'']?s?\b", r"\bmaster of science\b",
    r"\bgraduate degree\b", r"\bpostgraduate\b", r"\bm\.?s\. in\b",
]

# Security researcher fit keywords
FIT_POSITIVE = [
    "cryptograph", "zero.knowledge", r"\bzk\b", r"\bmpc\b", "protocol",
    "vulnerability research", r"\bcve\b", "reverse engineer", "malware",
    "network security", "intrusion detection", r"\bids\b", r"\bips\b",
    "exploit", "binary analysis", "threat research", "snort", "pcap",
    "oblivious", "secure computation", "privacy.preserving",
    # Added from CV analysis
    r"\bfhe\b", "homomorphic", "threshold", r"\btss\b",
    r"\bzkp\b", "snark", "stark", r"\bplonk\b",
    "privacy preserving", "applied cryptography",
    "detection engineering", "signature",
    r"\bllm\b", "generative ai", "fastapi", "celery",
    "peer.reviewed", "publication", "published", r"\bccs\b", "eurocrypt",
]

FIT_NEGATIVE = [
    "devSecOps", "compliance", "soc analyst", "incident response",
    "siem", "cloud security posture", "grc", "governance", "audit",
    "application security", "sast", "dast", "penetration test",
    "red team", "bug bounty",
    # Added from CV analysis
    "solidity", "smart contract developer", "defi", "nft", "tokenomics",
    "node operator", "validator operations",
    "sales engineer", "solutions architect", "pre-sales",
    "community manager", "developer relations", "devrel", "evangelist",
    r"\bintern\b", "internship", "entry level", "entry-level",
    r"\bjunior\b", "graduate program",
    r"\bdirector\b", r"\bvp \b", "head of", "chief",
    "penetration tester", "red team operator",
    "ruby on rails", r"\bphp\b", "wordpress", "salesforce",
]

# ---------- CLAUDE-BASED FIT SCORING ----------
#
# Order of preference:
#   1. `claude` CLI (Claude Code subscription) — no API key needed.
#      Install:  npm install -g @anthropic-ai/claude-code
#      Then:     claude  (follow /login flow once in the terminal)
#   2. Anthropic SDK with ANTHROPIC_API_KEY env var.
#   3. Regex fallback (check_fit/check_msc below).

CV_FILE = Path(__file__).parent.parent / "cv.txt"  # at project root
BATCH_SIZE = 8                # jobs per Claude call — big enough to rank, small enough to fit
DESC_CHAR_LIMIT = 3500        # per-job description truncation inside a batch

# Default cap on user-feedback few-shot examples injected into the scoring
# prompt. Overridable via config.json["feedback_examples_max"]. See
# DESIGN_FEW_SHOT.md §2 for the rationale (Anthropic recommends 3-5,
# over-prompting research caps at ~6, leaves room for stratified pos/neg).
FEEDBACK_EXAMPLES_MAX_DEFAULT = 6
FEEDBACK_EXAMPLE_CHAR_CAP = 700            # per-example line max length
FEEDBACK_COMMENT_CHAR_CAP = 500            # truncate user comments to this
# app_status values that count as STRONG positive signal — the user moved a
# card past one-click apply, real human-human exchange.
FEEDBACK_POSITIVE_STATUSES = {"interview", "take-home", "screening", "offer"}
# app_status values that count as negative signal (currently rare; forward-compat).
FEEDBACK_NEGATIVE_STATUSES = {"rejected", "withdrew"}

CLAUDE_BATCH_SCORING_PROMPT = """You rank LinkedIn jobs for fit against the candidate's CV.

<cv>
{cv}
</cv>
{feedback_block}
You will receive a JSON array of jobs under <jobs>. For each job, return one
scoring object. Keep your response tight — no prose outside JSON.

Scoring:
- "good"  = clear match against target roles (crypto / ZK / MPC / FHE /
            confidential computing research engineer, protocol engineer,
            or detection/vuln research with LLM-driven tooling). Score 7-10.
- "ok"    = adjacent or partial match (e.g. generic backend at a crypto
            company, AI security role without crypto depth). Score 4-6.
- "skip"  = off-profile OR hits a hard filter (intern, junior, entry-level,
            director+, VP, Head of, sales / SDR / pre-sales, DevRel,
            evangelist, pure Solidity / smart-contract dev, DeFi product,
            GRC / audit / compliance, SOC analyst, SIEM ops, CSPM, red team,
            penetration tester, bug bounty, PHP / Rails / WordPress / Salesforce).
            Score 1-3.

Rules:
- One object per input job, in the same order, same "id" field.
- Each reason under 8 words. At most 4 reasons per job.
- "msc_required" = true if the posting requires or strongly prefers a master's.
- The candidate HAS an M.Sc. — never treat it as a blocker.
- "red_flags" surface hard-filter hits in plain language.
- "priority": true means the company is on the user's high-interest list.
  Bump the fit one notch up (skip→ok, ok→good) and bump the score by 1
  UNLESS the role hits a hard red flag (intern/junior/sales/director+/etc).

Return ONLY a JSON array with this exact shape (no markdown fences, no prose):
[
  {{"id": "<job id>", "fit": "good"|"ok"|"skip", "score": <int 1-10>,
    "reasons": ["short reason", ...], "msc_required": true|false,
    "red_flags": ["..."]}},
  ...
]

<jobs>
{jobs_json}
</jobs>"""


def _load_cv_text() -> str:
    if CV_FILE.exists():
        return CV_FILE.read_text()
    return ""


# ---------------------------------------------------------------------------
# Few-shot user-feedback loop. See DESIGN_FEW_SHOT.md for the full rationale.
#
# Reads the persisted corpus (results.json) and surfaces a small, stratified,
# recency-sorted, interleaved set of examples showing how the user has
# actually rated / progressed past jobs. Injected into the scoring prompt
# between the CV block and the rules so Claude sees the user's empirical
# calibration evidence right after their identity.
#
# Signals (curated; see DESIGN_FEW_SHOT.md §1 for what was rejected and why):
#   - explicit `rating` (1-5) + optional `comment`
#   - `app_status` ∈ {interview, take-home, screening, offer}  → strong positive
#   - `app_status` ∈ {rejected, withdrew}                       → strong negative
#   - `source == "manual"` (manual-add, future feature)         → positive
#
# Degrades to "" on empty corpus / missing file / zero signals — caller can
# safely concatenate it into the prompt unconditionally.
# ---------------------------------------------------------------------------


def _truncate(s: str, n: int) -> str:
    s = (s or "").strip()
    if len(s) <= n:
        return s
    return s[: max(0, n - 1)].rstrip() + "…"


def _example_recency_key(row: dict) -> str:
    """Pick the freshest timestamp available on a corpus row for ordering.
    Falls back through rated_at → app_status_at → last app_status_history
    entry → found_at → empty string."""
    if row.get("rated_at"):
        return str(row["rated_at"])
    if row.get("app_status_at"):
        return str(row["app_status_at"])
    hist = row.get("app_status_history")
    if isinstance(hist, list) and hist:
        last = hist[-1]
        if isinstance(last, dict) and last.get("at"):
            return str(last["at"])
    return str(row.get("found_at") or "")


def _classify_feedback_row(row: dict) -> tuple[str | None, str]:
    """Return (sentiment, summary) for a corpus row, or (None, '') if the row
    carries no usable feedback signal.

    sentiment ∈ {"pos", "neg"} drives stratification.
    summary is the human-readable signal phrase used in the example line.
    """
    if not isinstance(row, dict):
        return None, ""

    rating = row.get("rating")
    comment = (row.get("comment") or "").strip()
    status = (row.get("app_status") or "").strip().lower()
    source = (row.get("source") or "").strip().lower()

    # Highest-priority signal: explicit star rating with optional comment.
    if isinstance(rating, (int, float)):
        r = int(rating)
        if 1 <= r <= 5:
            sentiment = "pos" if r >= 4 else ("neg" if r <= 2 else "pos")
            # 3 stars treated as weak positive (the user bothered to rate it,
            # didn't dismiss it). Comment, when present, is the most
            # information-dense signal — surface it.
            if comment:
                summary = (
                    f"rated {r}/5 — \"{_truncate(comment, FEEDBACK_COMMENT_CHAR_CAP)}\""
                )
            else:
                summary = f"rated {r}/5"
            return sentiment, summary

    # Second-priority: kanban progress past one-click apply.
    if status in FEEDBACK_POSITIVE_STATUSES:
        return "pos", f"reached '{status}' in pipeline"
    if status in FEEDBACK_NEGATIVE_STATUSES:
        return "neg", f"ended in '{status}'"

    # Third-priority: manual-add (future feature; harmless if never set).
    if source == "manual":
        return "pos", "manually added by user"

    return None, ""


def _format_feedback_example(row: dict, summary: str) -> str:
    """Render one corpus row as a single sanitized line for the prompt.
    Strips URLs, ids, location, descriptions, notes, and history (see
    DESIGN_FEW_SHOT.md §4). Hard-capped at FEEDBACK_EXAMPLE_CHAR_CAP chars."""
    title = _truncate(_clean_title(row.get("title", "")), 80)
    company = _truncate((row.get("company") or "").strip(), 40)
    category = _truncate((row.get("category") or "").strip(), 30)
    fit = (row.get("fit") or "").strip()

    parts = [f"- \"{title}\" @ {company}"]
    if category:
        parts.append(f"[{category}]")
    if fit:
        parts.append(f"(prior model fit: {fit})")
    parts.append(f"→ {summary}")

    line = " ".join(parts)
    return _truncate(line, FEEDBACK_EXAMPLE_CHAR_CAP)


def _build_user_feedback_examples(
    corpus_path: Path | None = None,
    cap: int | None = None,
) -> str:
    """Return a `<user_feedback_examples>...</user_feedback_examples>` block
    (with leading + trailing newlines) summarizing the user's past
    ratings / kanban progress, OR "" if there's nothing to show.

    Stratified pos/neg, recency-sorted, interleaved. See
    DESIGN_FEW_SHOT.md §2 for the ordering rationale.
    """
    path = corpus_path or RESULTS_FILE
    try:
        if not path.exists():
            return ""
        corpus = json.loads(path.read_text())
        if not isinstance(corpus, list):
            return ""
    except Exception:
        return ""

    # Resolve cap. Prefer caller's value; else look at the active config;
    # else fall back to the module-level default. Clamp to [0, 20].
    if cap is None:
        cfg_cap = None
        try:
            cfg_cap = _ACTIVE_CONFIG.get("feedback_examples_max")  # type: ignore[name-defined]
        except Exception:
            cfg_cap = None
        cap = cfg_cap if isinstance(cfg_cap, int) else FEEDBACK_EXAMPLES_MAX_DEFAULT
    cap = max(0, min(int(cap), 20))
    if cap == 0:
        return ""

    pos: list[tuple[str, dict, str]] = []  # (recency_key, row, summary)
    neg: list[tuple[str, dict, str]] = []
    for row in corpus:
        sentiment, summary = _classify_feedback_row(row)
        if not sentiment:
            continue
        key = _example_recency_key(row)
        bucket = pos if sentiment == "pos" else neg
        bucket.append((key, row, summary))

    if not pos and not neg:
        return ""

    # Recency-sort each bucket newest-first.
    pos.sort(key=lambda t: t[0], reverse=True)
    neg.sort(key=lambda t: t[0], reverse=True)

    # Stratify: try for half + half. If one side is shorter than `half`,
    # let the other side take the leftover slots so we always fill `cap`
    # when enough total signals exist.
    half = cap // 2
    pos_quota = min(len(pos), max(half, cap - min(half, len(neg))))
    neg_quota = min(len(neg), cap - pos_quota)
    # Edge case: pos_quota was so generous it left 0 for neg even though
    # neg has rows and pos exceeds quota. Re-balance toward neg.
    if neg_quota < min(len(neg), cap - half) and pos_quota > half:
        slack = pos_quota - half
        give = min(slack, min(len(neg), cap - half) - neg_quota)
        pos_quota -= give
        neg_quota += give
    pos_take = pos[:pos_quota]
    neg_take = neg[:neg_quota]

    # Interleave (P, N, P, N, ...) to dodge LLM recency/majority bias —
    # neither sentiment dominates the tail of the example list.
    interleaved: list[tuple[str, dict, str]] = []
    for i in range(max(len(pos_take), len(neg_take))):
        if i < len(pos_take):
            interleaved.append(pos_take[i])
        if i < len(neg_take):
            interleaved.append(neg_take[i])
        if len(interleaved) >= cap:
            break
    interleaved = interleaved[:cap]

    if not interleaved:
        return ""

    lines = [_format_feedback_example(row, summary) for _, row, summary in interleaved]
    body = "\n".join(lines)
    return (
        "\n<user_feedback_examples>\n"
        "Past jobs the user explicitly rated or progressed in their pipeline. "
        "Use these as calibration evidence for what the user *actually* "
        "considers a good vs poor fit — they override generic priors when "
        "they conflict.\n"
        f"{body}\n"
        "</user_feedback_examples>\n"
    )


def _parse_claude_json(raw: str):
    """Extract the first balanced JSON object or array from Claude's reply.
    Tries the bracket type that appears FIRST in the stripped text, so an
    array-prefixed response (`[...]` — batch job scoring) and an
    object-prefixed response (`{...}` — onboarding config generation)
    are both handled correctly. Previously we always tried `[` first which
    falsely picked the first array inside an object value."""
    if not raw:
        return None
    raw = raw.strip()
    # Strip common code fences.
    raw = re.sub(r"^```(?:json)?\s*", "", raw)
    raw = re.sub(r"\s*```\s*$", "", raw)

    # Pick the bracket that appears first in the stripped text so we parse
    # the right top-level structure, not an inner array/object.
    array_at = raw.find("[")
    object_at = raw.find("{")
    if object_at == -1 and array_at == -1:
        return None
    if object_at == -1:
        order = (("[", "]"),)
    elif array_at == -1:
        order = (("{", "}"),)
    elif object_at < array_at:
        order = (("{", "}"), ("[", "]"))
    else:
        order = (("[", "]"), ("{", "}"))

    for opener, closer in order:
        start = raw.find(opener)
        if start == -1:
            continue
        depth = 0
        in_str = False
        esc = False
        for i in range(start, len(raw)):
            ch = raw[i]
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
                continue
            if ch == '"':
                in_str = True
            elif ch == opener:
                depth += 1
            elif ch == closer:
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(raw[start:i + 1])
                    except Exception:
                        break
        # Fall through to try the next opener.
    return None


def _build_batch_prompt(cv_text: str, batch: list[dict]) -> str:
    items = [
        {
            "id": j["id"],
            "title": _clean_title(j.get("title", "")),
            "company": j.get("company", ""),
            "location": j.get("location", ""),
            # `priority` flags companies on the user's pre-curated high-interest
            # list (config.priority_companies). The prompt rules below tell the
            # model to bump the fit one notch unless a hard red flag fires.
            "priority": bool(j.get("priority", False)),
            "description": (j.get("_desc", "") or "")[:DESC_CHAR_LIMIT],
        }
        for j in batch
    ]
    feedback_block = _build_user_feedback_examples()
    # Defensive: a user-edited prompt template might have dropped the
    # {feedback_block} placeholder. Tolerate that — ship the prompt without
    # the few-shot block rather than crashing.
    try:
        return CLAUDE_BATCH_SCORING_PROMPT.format(
            cv=cv_text,
            feedback_block=feedback_block,
            jobs_json=json.dumps(items, ensure_ascii=False),
        )
    except KeyError:
        # Old/custom template missing {feedback_block} — try without it.
        return CLAUDE_BATCH_SCORING_PROMPT.format(
            cv=cv_text,
            jobs_json=json.dumps(items, ensure_ascii=False),
        )


def claude_batch_score(cv_text: str, batch: list[dict]) -> dict | None:
    """Return {job_id: scoring_dict}. None = caller should use regex fallback.

    Stage 2: delegates to the LLM provider abstraction in backend/llm/.
    Resolves the active provider (claude_cli, claude_sdk, gemini, openrouter,
    or ollama) from config.llm_provider; defaults to 'auto'."""
    if not cv_text or not batch:
        return None
    from backend.llm import score_batch as _llm_score_batch
    arr = _llm_score_batch(cv_text, batch)
    if not arr:
        return None
    out = {}
    for entry in arr:
        if isinstance(entry, dict) and entry.get("id"):
            out[str(entry["id"])] = entry
    return out or None


# Fast title-based pre-filter. Runs before we spend browser time fetching
# descriptions — LinkedIn search results include a lot of garbage and this
# cuts the enrichment queue by ~60-80% cheaply and reliably.
OFFTOPIC_TITLE_PATTERNS = [
    r"\bintern\b", r"\binternship\b",
    r"\bjunior\b", r"\bentry[\s-]?level\b", r"\bgraduate program\b",
    r"\bdirector\b", r"\bvp\b", r"\bvice[\s-]president\b",
    r"\bhead of\b", r"\bchief\b",
    r"\bsales\b", r"\bsdr\b", r"\baccount executive\b", r"\baccount manager\b",
    r"\bpre[\s-]?sales\b", r"\bsolutions architect\b", r"\bsolution architect\b",
    r"\bdevrel\b", r"\bdeveloper relations\b", r"\bevangelist\b",
    r"\bcommunity manager\b",
    r"\bmarketing\b", r"\brecruit(er|ing)\b", r"\btalent\b",
    r"\bproduct manager\b", r"\bpm\b",
    r"\bfinance\b", r"\baccountant\b", r"\bclerk\b", r"\bpayable\b",
    r"\blegal\b", r"\bparalegal\b", r"\bcompliance officer\b", r"\baudit\b",
    r"\bhr\b", r"\bhuman resources\b", r"\bpeople partner\b",
    r"\bcustomer support\b", r"\btech support\b", r"\bhelp desk\b",
    r"\bnoc\b", r"\bsoc analyst\b", r"\bsiem\b",
    r"\bpenetration tester\b", r"\bpentest\b", r"\bred team\b",
    r"\bbug bounty\b",
    r"\bwordpress\b", r"\bphp\b", r"\bruby on rails\b", r"\bsalesforce\b",
    r"\bsolidity\b", r"\bsmart contract developer\b", r"\bdefi\b",
    r"\bnode operator\b", r"\bvalidator operations\b",
    r"\bunity developer\b", r"\bgame developer\b", r"\bunreal engine\b",
    r"\bfront[\s-]?end\b", r"\bfrontend developer\b",
    r"\bmobile developer\b", r"\bios developer\b", r"\bandroid developer\b",
    r"\bmechanical engineer\b", r"\bavionic", r"\boptic\b", r"\btechnician\b",
    r"\bbuyer\b", r"\bprocurement\b", r"\blogistics\b", r"\bsupply chain\b",
    r"\bdata analyst\b", r"\bbusiness analyst\b", r"\bbi analyst\b",
    r"\bscrum master\b", r"\bproject manager\b", r"\bprogram manager\b",
]

# Hebrew patterns — a lot of LI's Israel results are Hebrew-titled.
OFFTOPIC_HEBREW = [
    "מהנדס מערכת", "מהנדס אוויוניקה", "הנדסאי", "טכנאי",
    "רכז", "מנהל מוצר", "מנהלת מוצר", "אנליסט",
    "רכש", "חשב", "משאבי אנוש", "תמיכה", "שירות לקוחות",
]


def _clean_title(title: str) -> str:
    """LinkedIn renders the title twice (once visible, once for screen readers),
    separated by \\n. Also strips noise like 'with verification' badges."""
    if not title:
        return ""
    # Split on newlines — take the first non-empty chunk.
    parts = [p.strip() for p in title.split("\n") if p.strip()]
    if not parts:
        return title.strip()
    t = parts[0]
    # If the second line starts with the first and adds "with verification", keep first.
    # Strip trailing badge phrases even if they made it into the visible title.
    t = re.sub(r"\s+with verification\s*$", "", t, flags=re.IGNORECASE)
    t = re.sub(r"\s+\(verified\)\s*$", "", t, flags=re.IGNORECASE)
    return t.strip()


def is_obviously_offtopic(title: str) -> str | None:
    """Return the pattern that matched, or None if the title looks plausibly on-topic."""
    t = (title or "").lower()
    for pat in OFFTOPIC_TITLE_PATTERNS:
        if re.search(pat, t):
            return pat
    for hb in OFFTOPIC_HEBREW:
        if hb in title:
            return hb
    return None


# ---------- END CLAUDE SCORING ----------

# JS injected into every page to hide automation fingerprints.
# The critical fix: navigator.webdriver leaks were the main detection signal.
# navigator.languages is parameterized so the injected value matches the
# detected/configured locale (LinkedIn fingerprints language vs. timezone vs.
# session geo for consistency).
STEALTH_JS_TEMPLATE = """
Object.defineProperty(navigator, 'webdriver', {{get: () => undefined}});
Object.defineProperty(navigator, 'plugins', {{get: () => [1,2,3,4,5]}});
Object.defineProperty(navigator, 'languages', {{get: () => {languages_json}}});
window.chrome = {{runtime: {{}}}};
"""


# Minimal Windows-zone-ID → IANA map. Covers ~30 highest-population zones.
# Source: CLDR windowsZones.xml (https://github.com/unicode-org/cldr).
# Fallback for any Windows zone not listed is UTC. Users can override via
# config.playwright_timezone if they live somewhere uncommon.
_WINDOWS_TO_IANA: dict[str, str] = {
    "Israel Standard Time": "Asia/Jerusalem",
    "Pacific Standard Time": "America/Los_Angeles",
    "Eastern Standard Time": "America/New_York",
    "Central Standard Time": "America/Chicago",
    "Mountain Standard Time": "America/Denver",
    "Alaskan Standard Time": "America/Anchorage",
    "Hawaiian Standard Time": "Pacific/Honolulu",
    "Atlantic Standard Time": "America/Halifax",
    "GMT Standard Time": "Europe/London",
    "W. Europe Standard Time": "Europe/Berlin",
    "Central European Standard Time": "Europe/Warsaw",
    "Central Europe Standard Time": "Europe/Budapest",
    "E. Europe Standard Time": "Europe/Bucharest",
    "FLE Standard Time": "Europe/Helsinki",
    "Romance Standard Time": "Europe/Paris",
    "Russian Standard Time": "Europe/Moscow",
    "Turkey Standard Time": "Europe/Istanbul",
    "Egypt Standard Time": "Africa/Cairo",
    "South Africa Standard Time": "Africa/Johannesburg",
    "Arab Standard Time": "Asia/Riyadh",
    "Arabian Standard Time": "Asia/Dubai",
    "Iran Standard Time": "Asia/Tehran",
    "India Standard Time": "Asia/Kolkata",
    "China Standard Time": "Asia/Shanghai",
    "Tokyo Standard Time": "Asia/Tokyo",
    "Korea Standard Time": "Asia/Seoul",
    "Singapore Standard Time": "Asia/Singapore",
    "Taipei Standard Time": "Asia/Taipei",
    "AUS Eastern Standard Time": "Australia/Sydney",
    "AUS Central Standard Time": "Australia/Adelaide",
    "W. Australia Standard Time": "Australia/Perth",
    "New Zealand Standard Time": "Pacific/Auckland",
    "SA Pacific Standard Time": "America/Bogota",
    "E. South America Standard Time": "America/Sao_Paulo",
    "Argentina Standard Time": "America/Buenos_Aires",
    "UTC": "UTC",
    "GMT": "UTC",
}


def _detect_windows_timezone() -> str | None:
    """Windows-only: read TimeZoneKeyName from the registry, map via
    _WINDOWS_TO_IANA. Returns None if not on Windows or registry path fails."""
    import sys
    if not sys.platform.startswith("win"):
        return None
    try:
        import winreg  # type: ignore[import-not-found]
        path = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\TimeZoneInformation"
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, path) as key:
            value, _ = winreg.QueryValueEx(key, "TimeZoneKeyName")
        if isinstance(value, str) and value.strip():
            return _WINDOWS_TO_IANA.get(value.strip())
    except Exception:
        pass
    return None


def _detect_system_timezone() -> str:
    """Best-effort system IANA timezone detection. stdlib only — no tzlocal
    dep. We deliberately skip POSIX abbreviations (`PST`/`IST` etc.) —
    Playwright accepts them but LinkedIn's fingerprint check prefers IANA
    and a wrong abbrev looks more suspicious than a generic UTC.

    Resolution order:
      1) `/etc/localtime` symlink target (works on macOS + most Linux distros).
         macOS: `/var/db/timezone/zoneinfo/Asia/Jerusalem`
         Linux: `/usr/share/zoneinfo/Asia/Jerusalem`
      2) `TZ` env var if it looks like an IANA name (Docker / k8s pattern).
      3) Windows registry → CLDR Windows-to-IANA map (~30 common zones).
      4) `datetime.now().astimezone().tzinfo` if it has an IANA `.key` or stringifies to one.
      5) UTC."""
    # 1) /etc/localtime symlink → IANA name
    try:
        from pathlib import Path
        link = Path("/etc/localtime")
        if link.exists():
            target = str(link.resolve())
            for marker in ("/zoneinfo/", "/zoneinfo.default/"):
                idx = target.rfind(marker)
                if idx >= 0:
                    iana = target[idx + len(marker):]
                    if "/" in iana:
                        return iana
    except Exception:
        pass
    # 2) TZ env var (containers / explicit override)
    try:
        from os import environ
        tz_env = (environ.get("TZ") or "").strip()
        if tz_env and "/" in tz_env:
            return tz_env
    except Exception:
        pass
    # 3) Windows registry (covers ~30 highest-population zones)
    win_tz = _detect_windows_timezone()
    if win_tz:
        return win_tz
    # 4) Python's local-zone object (rarely IANA, but try anyway)
    try:
        from datetime import datetime
        tz = datetime.now().astimezone().tzinfo
        name = getattr(tz, "key", None) or (str(tz) if tz else None)
        if name and "/" in name:
            return name
    except Exception:
        pass
    return "UTC"


def _detect_system_locale() -> str:
    """Read locale from LANG / LC_ALL env. Returns BCP-47ish (e.g. 'en-US')
    Playwright accepts. Falls back to en-US if nothing parseable."""
    raw = os.environ.get("LC_ALL") or os.environ.get("LANG") or ""
    # Strip codeset / modifier (e.g. 'en_US.UTF-8' -> 'en_US').
    head = raw.split(".")[0].split("@")[0].strip()
    if head and head not in ("C", "POSIX"):
        return head.replace("_", "-")
    return "en-US"


def _resolved_browser_locale_tz() -> tuple[str, str]:
    """Return (locale, timezone_id) for the Playwright context.
    Config overrides (playwright_locale / playwright_timezone) win; otherwise
    we auto-detect from the system. Centralized so first-run loggedin and
    every later session use the same values."""
    cfg = _ACTIVE_CONFIG if isinstance(_ACTIVE_CONFIG, dict) else {}
    loc = cfg.get("playwright_locale")
    tz = cfg.get("playwright_timezone")
    if not (isinstance(loc, str) and loc.strip()):
        loc = _detect_system_locale()
    if not (isinstance(tz, str) and tz.strip()):
        tz = _detect_system_timezone()
    return loc.strip(), tz.strip()


def _build_stealth_js(locale: str) -> str:
    """Render STEALTH_JS_TEMPLATE with the languages array derived from locale.
    e.g. 'en-US' -> ['en-US','en']; 'fr-FR' -> ['fr-FR','fr','en']."""
    primary = (locale or "en-US").strip() or "en-US"
    base = primary.split("-")[0]
    langs = [primary]
    if base and base != primary:
        langs.append(base)
    if "en" not in langs:
        langs.append("en")
    return STEALTH_JS_TEMPLATE.format(languages_json=json.dumps(langs))

# ---------- END CONFIG ----------

# `HERE` points at backend/. All persistent state files live at the
# project ROOT (one level up) so the layout stays familiar and external
# tooling — README walkthroughs, manual edits, the Vite dev server's
# symlinks — all reference plain filenames at the repo root.
HERE = Path(__file__).parent
ROOT = HERE.parent
SEEN_FILE = ROOT / "seen_jobs.json"
RESULTS_FILE = ROOT / "results.json"
SESSION_FILE = ROOT / "linkedin_session.json"
CONFIG_FILE = ROOT / "config.json"
RUN_HISTORY_FILE = ROOT / "run_history.json"
DEFAULTS_FILE = ROOT / "defaults.json"

# Keys editable from the UI. Order matters for `--print-defaults` output.
_CONFIGURABLE_KEYS = (
    "search_queries",
    "security_researcher_queries",
    "company_queries",
    "location",
    "date_filter",
    "geo_id",
    "max_pages",
    "priority_companies",
)


def _hardcoded_defaults() -> dict:
    """Returns the *current effective* defaults — i.e. the in-file constants
    as potentially mutated by load_config() if a config.json is present. On a
    fresh clone with no config.json the returned values are the true hardcoded
    defaults. The UI uses this to populate the Crawler Config page on first
    load and on 'Reset to defaults'.

    Schema (introduced 2026-04-22 in Phase A genericisation):
      categories[]            — user-defined category groups, each with
                                {id, name, type: keyword|company, queries[]}
      claude_scoring_prompt   — full prompt template (uses {cv}, {jobs_json})
      fit_positive_patterns   — regex strings for the regex fallback scorer
      fit_negative_patterns   — regex strings (negative weight)
      offtopic_title_patterns — regex strings; cards matching are pre-skipped
      priority_companies      — array of lowercased substrings; jobs whose
                                company contains one get the priority flag
    """
    return {
        "categories": [dict(c) for c in CATEGORIES],
        "location": LOCATION,
        "date_filter": DATE_FILTER,
        "geo_id": GEO_ID,
        "max_pages": 3,
        "priority_companies": sorted(PRIORITY_COMPANIES),
        "claude_scoring_prompt": CLAUDE_BATCH_SCORING_PROMPT,
        "fit_positive_patterns": list(FIT_POSITIVE),
        "fit_negative_patterns": list(FIT_NEGATIVE),
        "offtopic_title_patterns": list(OFFTOPIC_TITLE_PATTERNS),
        "feedback_examples_max": FEEDBACK_EXAMPLES_MAX_DEFAULT,
        # Stage 2 LLM provider abstraction. "auto" = resolver picks the first
        # working provider (claude_cli -> claude_sdk -> gemini -> openrouter
        # -> ollama). Specific names use only that provider. Optional `model`
        # field overrides the provider's default.
        "llm_provider": {"name": "auto"},
        # Stage 3 — wizard picks this; used as the scheduler / scrape default.
        # "guest" if missing so existing configs without the field stay unchanged.
        "default_mode": "guest",
    }


def _migrate_legacy_config(user_cfg: dict) -> dict:
    """If user_cfg has the OLD `search_queries`/`security_researcher_queries`/
    `company_queries` keys (pre-2026-04-22 schema), build an equivalent
    `categories[]` array. Returns the (possibly modified) cfg dict in place."""
    if "categories" in user_cfg and isinstance(user_cfg["categories"], list):
        return user_cfg  # already on the new schema
    legacy_map = [
        ("search_queries", "crypto", "Crypto", "keyword"),
        ("security_researcher_queries", "security_researcher", "Security Researcher", "keyword"),
        ("company_queries", "company", "Companies", "company"),
    ]
    rebuilt: list[dict] = []
    for key, cid, cname, ctype in legacy_map:
        v = user_cfg.get(key)
        if isinstance(v, list) and all(isinstance(s, str) for s in v):
            rebuilt.append({
                "id": cid, "name": cname, "type": ctype,
                "queries": [s.strip() for s in v if s.strip()],
            })
    if rebuilt:
        user_cfg["categories"] = rebuilt
    return user_cfg


def _normalize_categories(raw, fallback: list[dict]) -> list[dict]:
    """Validate + clean a categories[] payload. Drops malformed entries.
    Falls back wholesale to `fallback` if nothing valid remains."""
    if not isinstance(raw, list):
        return fallback
    out: list[dict] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        cid = str(entry.get("id") or "").strip()
        name = str(entry.get("name") or "").strip() or cid
        ctype = entry.get("type") or "keyword"
        if ctype not in ("keyword", "company"):
            ctype = "keyword"
        queries = entry.get("queries") or []
        if not (isinstance(queries, list) and all(isinstance(s, str) for s in queries)):
            queries = []
        queries = [s.strip() for s in queries if s.strip()]
        if not cid:
            # Synthesize an id from the name.
            cid = re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_") or f"cat_{len(out)}"
        out.append({"id": cid, "name": name, "type": ctype, "queries": queries})
    return out or fallback


_VALID_LLM_PROVIDER_NAMES = {
    "auto", "claude_cli", "claude_sdk", "gemini", "openrouter", "ollama",
}


def _normalize_llm_provider(raw, fallback: dict) -> dict:
    """Validate the llm_provider config block. Drops malformed payloads back
    to the fallback (defaults to {'name': 'auto'}). Optional `model` is kept
    only if it's a non-empty string."""
    if not isinstance(raw, dict):
        return dict(fallback)
    name = str(raw.get("name") or "").strip().lower()
    if name not in _VALID_LLM_PROVIDER_NAMES:
        return dict(fallback)
    out: dict = {"name": name}
    model = raw.get("model")
    if isinstance(model, str) and model.strip():
        out["model"] = model.strip()
    return out


def load_config() -> dict:
    """Load config.json if present; merge over the hardcoded defaults.

    Hardcoded constants stay as the source-of-truth fallback. If a key is
    present and well-typed in config.json, it overrides the module-level
    constant. Missing or invalid keys fall back to the hardcoded value
    (a malformed config NEVER stops the scraper from running).

    Accepts BOTH the new schema (categories[], claude_scoring_prompt, etc.)
    and the legacy schema (search_queries, security_researcher_queries,
    company_queries) — legacy is migrated to new on read.
    """
    global SEARCH_QUERIES, SECURITY_RESEARCHER_QUERIES, COMPANY_QUERIES
    global LOCATION, DATE_FILTER, GEO_ID, PRIORITY_COMPANIES, CATEGORIES
    global CLAUDE_BATCH_SCORING_PROMPT, FIT_POSITIVE, FIT_NEGATIVE
    global OFFTOPIC_TITLE_PATTERNS

    defaults = _hardcoded_defaults()
    if not CONFIG_FILE.exists():
        return defaults

    try:
        user_cfg = json.loads(CONFIG_FILE.read_text())
        if not isinstance(user_cfg, dict):
            print(f"⚠ config.json must be a JSON object — using hardcoded defaults")
            return defaults
    except Exception as e:
        print(f"⚠ config.json invalid ({e}) — using hardcoded defaults")
        return defaults

    user_cfg = _migrate_legacy_config(user_cfg)

    def _str_list(key: str, fallback: list[str]) -> list[str]:
        v = user_cfg.get(key)
        if isinstance(v, list) and all(isinstance(s, str) for s in v):
            return [s.strip() for s in v if s.strip()]
        # Tolerate comma-separated strings for priority_companies.
        if key == "priority_companies" and isinstance(v, str):
            return [s.strip() for s in v.split(",") if s.strip()]
        return fallback

    def _str(key: str, fallback: str) -> str:
        v = user_cfg.get(key)
        return v if isinstance(v, str) else fallback

    merged = {
        "categories": _normalize_categories(
            user_cfg.get("categories"), defaults["categories"]
        ),
        "location": _str("location", defaults["location"]),
        "date_filter": _str("date_filter", defaults["date_filter"]),
        "geo_id": _str("geo_id", defaults["geo_id"]),
        "max_pages": (
            int(user_cfg["max_pages"])
            if isinstance(user_cfg.get("max_pages"), int)
            and 1 <= user_cfg["max_pages"] <= 20
            else defaults["max_pages"]
        ),
        "priority_companies": _str_list(
            "priority_companies", defaults["priority_companies"]
        ),
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
        # Few-shot feedback cap. Clamp to [0, 20]; 0 disables the feature.
        "feedback_examples_max": (
            max(0, min(int(user_cfg["feedback_examples_max"]), 20))
            if isinstance(user_cfg.get("feedback_examples_max"), int)
            else defaults["feedback_examples_max"]
        ),
        # Stage 2 LLM provider selector. Validate name against known providers;
        # silently fall back to "auto" on anything malformed.
        "llm_provider": _normalize_llm_provider(
            user_cfg.get("llm_provider"), defaults["llm_provider"]
        ),
        # Stage 3 — wizard-picked default scrape mode. Accept only the two
        # known values; anything else (including missing) falls back to the
        # default ("guest").
        "default_mode": (
            user_cfg["default_mode"]
            if user_cfg.get("default_mode") in ("guest", "loggedin")
            else defaults["default_mode"]
        ),
    }

    # Mutate module-level constants in place so the rest of the file
    # transparently picks up overrides via its existing references.
    CATEGORIES = merged["categories"]
    # Keep the legacy lists in sync for any code path still reading them.
    SEARCH_QUERIES = next(
        (c["queries"] for c in CATEGORIES if c["id"] == "crypto"),
        list(SEARCH_QUERIES),
    )
    SECURITY_RESEARCHER_QUERIES = next(
        (c["queries"] for c in CATEGORIES if c["id"] == "security_researcher"),
        list(SECURITY_RESEARCHER_QUERIES),
    )
    COMPANY_QUERIES = next(
        (c["queries"] for c in CATEGORIES if c["id"] == "company"),
        list(COMPANY_QUERIES),
    )
    LOCATION = merged["location"]
    DATE_FILTER = merged["date_filter"]
    GEO_ID = merged["geo_id"]
    PRIORITY_COMPANIES = {p.lower() for p in merged["priority_companies"]}
    CLAUDE_BATCH_SCORING_PROMPT = merged["claude_scoring_prompt"]
    FIT_POSITIVE = merged["fit_positive_patterns"]
    FIT_NEGATIVE = merged["fit_negative_patterns"]
    OFFTOPIC_TITLE_PATTERNS = merged["offtopic_title_patterns"]
    return merged


# Apply config at import time so module-level constants reflect user overrides
# before main() runs. Done as a no-op if config.json is missing.
_ACTIVE_CONFIG = load_config()


def _category_name_for_id(cat_id: str) -> str:
    """Resolve a category id to its human-readable name from the active
    config. Returns the id itself if not found — caller should write that
    on the corpus row regardless, so display falls back gracefully.
    Each new corpus row stores this NAME at scrape time; that's what
    keeps badges readable across later config rewrites (wizard overwrite,
    AI-generated config paste, profile switch — none of those migrate
    existing rows, so freezing the name on the row itself is the fix)."""
    for c in _ACTIVE_CONFIG.get("categories", []) or []:
        if c.get("id") == cat_id:
            return c.get("name") or cat_id
    return cat_id


# ---------------------------------------------------------------------------
# Cross-platform exclusive file lock so multiple scraper processes (e.g.
# running --mode=guest and --mode=loggedin in parallel) never clobber each
# other's state. filelock uses fcntl on POSIX and msvcrt.locking on Windows
# under the hood — same semantics on all three OSes, no try/except dance.
# ---------------------------------------------------------------------------
from filelock import FileLock


def _atomic_merge_json(path: Path, mutator):
    """Cross-platform exclusive-locked read-modify-write. `mutator(current)`
    returns the new value to persist. `current` is None if the file doesn't
    exist yet. The temp+rename ensures the write itself is atomic even if the
    lock fails."""
    lock_path = Path(str(path) + ".lock")
    with FileLock(str(lock_path)):
        current = None
        if path.exists():
            try:
                current = json.loads(path.read_text())
            except json.JSONDecodeError:
                current = None
        new_data = mutator(current)
        tmp = Path(str(path) + ".tmp")
        tmp.write_text(json.dumps(new_data, indent=2, ensure_ascii=False))
        tmp.replace(path)


def load_seen() -> set:
    if SEEN_FILE.exists():
        return set(json.loads(SEEN_FILE.read_text()))
    return set()


def save_seen(seen: set):
    """Merge `seen` into the on-disk set under fcntl lock."""
    def _mut(current):
        existing = set(current or [])
        existing |= seen
        return sorted(existing)
    _atomic_merge_json(SEEN_FILE, _mut)


def load_results() -> list:
    if RESULTS_FILE.exists():
        return json.loads(RESULTS_FILE.read_text())
    return []


def save_results_merge(new_jobs: list):
    """Merge `new_jobs` into results.json under fcntl lock. Dedup by id —
    if a job_id already exists, the existing record wins (we don't re-score
    a job just because the other mode also found it)."""
    def _mut(current):
        existing = current if isinstance(current, list) else []
        seen_ids = {j.get("id") for j in existing if isinstance(j, dict)}
        for j in new_jobs:
            if j.get("id") and j["id"] not in seen_ids:
                existing.append(j)
                seen_ids.add(j["id"])
        return existing
    _atomic_merge_json(RESULTS_FILE, _mut)


# Backward-compat alias — older code paths may still call save_results(list)
# expecting a wholesale overwrite. Route them through the safe merge instead.
def save_results(results: list):
    save_results_merge(results)


def _append_run_history(entry: dict, cap: int = 100) -> None:
    """Append a run record to run_history.json (capped at the last `cap`).
    File format: {"runs": [...]} with newest entries at the END so chronological
    order matches typical log appending. The UI sorts client-side."""
    def _mut(current):
        if not isinstance(current, dict) or not isinstance(current.get("runs"), list):
            current = {"runs": []}
        runs = current["runs"]
        runs.append(entry)
        if len(runs) > cap:
            current["runs"] = runs[-cap:]
        return current
    try:
        _atomic_merge_json(RUN_HISTORY_FILE, _mut)
    except Exception as e:
        # Best-effort; don't crash a successful run because history append failed.
        print(f"⚠ run_history append failed: {e}")


# ---------------------------------------------------------------------------
# Guest mode — unauthenticated HTTP scraping via LinkedIn's public job-search
# endpoints. No browser, no account, no fingerprinting concerns. Tested
# 2026-04 to return ~5x more results than the logged-in dummy account
# (pulls in NVIDIA / Google / Apple / Intel / Amazon postings the personalized
# search hides).
# ---------------------------------------------------------------------------

GUEST_SEARCH_URL = (
    "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search"
)
GUEST_DETAIL_URL = (
    "https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/{job_id}"
)
# Empty = no &geoId= param sent → LinkedIn returns its worldwide default.
# Strongly recommended to set an explicit geo_id in config (Israel=101620260,
# US=103644278, Worldwide=92000000, etc) — the worldwide feed is noisier and
# may not match the user's locale. Was hardcoded to Israel pre-2026-04;
# changed to empty so a fresh clone doesn't silently get only Israeli jobs.
GUEST_GEO_DEFAULT = ""

GUEST_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.linkedin.com/jobs/search/",
}


def _guest_session():
    """Build a single requests.Session for the whole run (connection reuse +
    consistent headers). Imports are local so logged-in mode doesn't pay
    the startup cost of pulling in requests/bs4 if guest mode isn't used."""
    import requests  # noqa: F401  (kept here to defer import)
    s = requests.Session()
    s.headers.update(GUEST_HEADERS)
    return s


def _strip_html(s: str) -> str:
    s = re.sub(r"<[^>]+>", " ", s or "")
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _parse_guest_cards(html: str, query: str, category: str) -> list[dict]:
    """Parse the guest search HTML response into job dicts compatible with
    the rest of the pipeline (same shape as _extract_jobs_from_cards)."""
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(html, "html.parser")
    out = []
    seen_local = set()
    for li in soup.select("li"):
        link = li.select_one("a[href*='/jobs/view/']")
        if not link:
            continue
        href = (link.get("href") or "")
        if "/jobs/view/" not in href:
            continue
        # The guest URL embeds a slug + numeric ID like "/jobs/view/foo-bar-1234567890".
        slug = href.split("/jobs/view/")[1].split("?")[0].rstrip("/")
        job_id = slug.rsplit("-", 1)[-1] if "-" in slug else slug
        if not job_id.isdigit() or job_id in seen_local:
            continue
        seen_local.add(job_id)

        title_el = li.select_one(
            ".base-search-card__title, h3, .full-link, .sr-only"
        )
        title = _clean_title(title_el.get_text(strip=True) if title_el else "")
        co_el = li.select_one(
            ".base-search-card__subtitle a, .base-search-card__subtitle, h4"
        )
        company = (co_el.get_text(strip=True) if co_el else "").strip()
        loc_el = li.select_one(".job-search-card__location")
        location = (loc_el.get_text(strip=True) if loc_el else "").strip()
        date_el = li.select_one("time")
        # date_posted comes from the public listing — preserve as a hint
        date_posted = (date_el.get("datetime") if date_el else "") or ""

        out.append({
            "id": job_id,
            "title": title,
            "company": company,
            "location": location,
            "url": f"https://www.linkedin.com/jobs/view/{job_id}/",
            "query": query,
            "category": category,
            # Human-readable category name resolved at scrape time. Survives
            # config rewrites (wizard overwrite / AI-generated config / profile
            # switch) so old rows always display correctly even when their
            # `category` id is no longer in the active config. Source of truth
            # for the badge label; the id is retained for back-compat.
            "category_name": _category_name_for_id(category),
            "found_at": datetime.now().isoformat(),
            "date_posted": date_posted,  # extra field; UI ignores if absent
            "priority": any(p in company.lower() for p in PRIORITY_COMPANIES),
            "msc_required": None,
            "fit": None,
            "fit_reasons": [],
            "source": "guest",  # tag origin so downstream / UI can distinguish
        })
    return out


def scrape_query_guest(session, query: str, category: str = "crypto",
                       max_pages: int = 3, date_filter: str | None = None,
                       geo_id: str | None = None,
                       category_type: str = "keyword") -> list[dict]:
    """Guest-mode equivalent of scrape_query(). Same return contract.

    No JYMBII filler from this endpoint (verified 2026-04), so the only
    relevance defense we apply is the company-name + token-relevance check
    that catches noise like "QA Engineer" matches for "cryptography engineer".
    """
    geo = geo_id or GUEST_GEO_DEFAULT
    tpr = DATE_FILTER if date_filter is None else date_filter

    # Behavior is driven by category_type, not the literal `category` string.
    # Legacy callers passing only `category="company"` still work because of
    # the default fall-back at the iteration site.
    is_company_query = (category_type == "company") or (category == "company")
    q_lower = (query or "").lower()
    query_tokens = [] if is_company_query else _query_tokens(query)

    all_jobs: list[dict] = []
    seen_ids: set[str] = set()
    stats = {"real": 0, "jymbii": 0, "unknown": 0,
             "dropped_jymbii": [], "dropped_offtarget": []}

    for page_idx in range(max_pages):
        start = page_idx * 25
        params = {"keywords": query, "start": str(start)}
        if geo:
            # Omit geoId entirely when empty — LinkedIn falls back to its
            # worldwide default, which is what we want for an unconfigured
            # install (was hardcoded to Israel pre-2026-04).
            params["geoId"] = geo
        if tpr:
            params["f_TPR"] = tpr

        try:
            r = session.get(GUEST_SEARCH_URL, params=params, timeout=20)
        except Exception as e:
            print(f"  GET error on page {page_idx+1}: {str(e)[:120]}")
            break

        if r.status_code == 429:
            print(f"  rate-limited (429) on page {page_idx+1}, cooling 30s...")
            time.sleep(30)
            continue
        if r.status_code != 200:
            print(f"  HTTP {r.status_code} on page {page_idx+1}, stopping.")
            break

        cards = _parse_guest_cards(r.text, query, category)

        new_on_page = 0
        for job in cards:
            if job["id"] in seen_ids:
                continue

            # Stage A: company-mode relevance.
            if is_company_query and q_lower and q_lower not in job["company"].lower():
                stats["jymbii"] += 1
                stats["dropped_offtarget"].append(
                    f'{job["title"][:40]} @ {job["company"][:24]}'
                )
                continue

            # Stage B: keyword-mode token relevance.
            if query_tokens and not _card_matches_tokens(
                    job["title"], job["company"], query_tokens):
                stats["jymbii"] += 1
                stats["dropped_offtarget"].append(
                    f'{job["title"][:40]} @ {job["company"][:24]}'
                )
                continue

            stats["real"] += 1
            seen_ids.add(job["id"])
            all_jobs.append(job)
            new_on_page += 1

        if not cards or len(cards) == 0:
            break
        if new_on_page == 0 and page_idx > 0:
            # Saw cards but kept none — and prior pages contributed something.
            # Keep going one more page to be safe; if still nothing, bail.
            pass

        time.sleep(random.uniform(1.0, 2.0))  # be polite

    if stats["jymbii"]:
        print(f"  ↳ guest classification: real={stats['real']} "
              f"dropped={stats['jymbii']}")
    return all_jobs


def _parse_retry_after(header_val: str | None) -> float | None:
    """Parse a Retry-After header. Accepts either integer seconds or an
    HTTP-date. Returns seconds-to-wait (float) or None if unparseable."""
    if not header_val:
        return None
    header_val = header_val.strip()
    # Integer seconds form.
    try:
        return max(0.0, float(header_val))
    except ValueError:
        pass
    # HTTP-date form — RFC 7231.
    from email.utils import parsedate_to_datetime
    try:
        dt = parsedate_to_datetime(header_val)
        if dt is None:
            return None
        wait = (dt.timestamp() - time.time())
        return max(0.0, wait)
    except Exception:
        return None


def fetch_description_guest(
    session, job_id: str, max_retries: int = 2,
) -> tuple[str, str]:
    """Guest-mode equivalent of fetch_description(). Returns (text_lower, diag).

    diag ∈ {ok, http-<code>, empty, error, rate-limited}.

    Rate-limit handling (added 2026-04-23 after observing HTTP 429 on the
    /jobs-guest/jobs/api/jobPosting/<id> endpoint during burst description
    fetches):
      1) On 429, read the `Retry-After` response header if present — it's
         the authoritative signal. Parse either an int-seconds value or an
         HTTP-date.
      2) If no Retry-After, use exponential backoff: 30s, 60s (capped).
      3) Retry up to `max_retries` times before giving up.
      4) Return diag='rate-limited' on persistent 429 so the caller can log
         it distinctly from other failures.
    """
    if not job_id:
        return "", "empty"
    url = GUEST_DETAIL_URL.format(job_id=job_id)

    attempt = 0
    while True:
        try:
            r = session.get(url, timeout=15)
        except Exception as e:
            return "", f"error:{str(e)[:60]}"

        if r.status_code == 429 and attempt < max_retries:
            wait = _parse_retry_after(r.headers.get("Retry-After"))
            if wait is None:
                wait = 30.0 * (2 ** attempt)  # 30s, 60s
            wait = min(wait, 120.0)
            print(f"    ⏸  429 on {job_id}, waiting {wait:.0f}s "
                  f"(attempt {attempt+1}/{max_retries})…")
            time.sleep(wait)
            attempt += 1
            continue

        if r.status_code == 429:
            return "", "rate-limited"
        if r.status_code != 200:
            return "", f"http-{r.status_code}"
        if not r.text.strip():
            return "", "empty"
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(r.text, "html.parser")
        desc_el = (soup.select_one(".description__text") or
                   soup.select_one(".show-more-less-html__markup") or
                   soup.select_one("[class*='description__text']") or
                   soup.select_one("[class*='show-more-less-html']"))
        if desc_el:
            text = _strip_html(desc_el.decode_contents())
        else:
            text = _strip_html(r.text)
        if len(text) < 80:
            return text.lower(), "empty"
        return text.lower(), "ok"


# ---------------------------------------------------------------------------
# End guest mode.
# ---------------------------------------------------------------------------


def jiggle_mouse(page):
    """Small random mouse movement to look less robotic."""
    try:
        x = random.randint(100, 1100)
        y = random.randint(100, 700)
        page.mouse.move(x, y, steps=random.randint(3, 8))
    except Exception:
        pass


def scroll_and_load(page, passes=4):
    for _ in range(passes):
        amount = random.randint(600, 1100)
        page.evaluate(f"window.scrollBy(0, {amount})")
        time.sleep(random.uniform(0.5, 1.1))
    jiggle_mouse(page)


def safe_goto(page, url: str, retries=2):
    for attempt in range(retries + 1):
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=20000)
            return True
        except PlaywrightTimeout:
            if attempt < retries:
                print(f"  Timeout — retrying...")
                time.sleep(random.uniform(3, 5))
                continue
            return False
        except Exception as e:
            msg = str(e)
            if "ERR_TOO_MANY_REDIRECTS" in msg or "ERR_ABORTED" in msg:
                if attempt < retries:
                    print(f"  Redirect loop — cooling down 8s...")
                    time.sleep(8)
                    try:
                        page.goto("https://www.linkedin.com/feed/", wait_until="domcontentloaded", timeout=15000)
                        time.sleep(3)
                    except Exception:
                        pass
                else:
                    return False
            else:
                print(f"  Navigation error: {msg[:120]}")
                return False
    return False


CARD_SELECTORS = [
    # Current LI layout (2026). The ...occludable-job-id... variant is the
    # narrowest — it matches only real job cards, not the surrounding
    # "People also viewed" / JYMBII shells — so prefer it.
    "li.scaffold-layout__list-item[data-occludable-job-id]",
    "li.scaffold-layout__list-item",
    # Legacy paths kept as fallback while LI A/Bs layout revisions.
    "li.jobs-search-results__list-item",
    ".job-card-container",
    "div.job-search-card",
    "[data-job-id]",
]

# Containers that host the inner scroll list. You must scroll THESE (not the
# window) for LinkedIn to lazy-load pages 2+ of results on the logged-in SPA.
# Fix discovered April 2026 after queries were capping at ~21-25 hits.
RESULTS_PANE_SELECTORS = [
    ".scaffold-layout__list-container",
    ".jobs-search-results-list",
    "main .scaffold-layout__list",
    ".jobs-search-results",
]

# LinkedIn injects "Jobs you may be interested in" (JYMBII) filler when a
# query has zero real hits — same ~7 cards repeat across unrelated queries.
#
# Discovered 2026-04 by diffing two live queries (see debug_query.py notes):
#   - trk=flagship3_search_srp_jobs is carried by BOTH real and filler cards,
#     so trk is NOT a reliable discriminator (what the pre-flight research
#     claimed about JOB_SEARCH_PAGE_JOB_CARD vs JYMBII prefixes was wrong
#     for the logged-in SPA LinkedIn is serving in 2026).
#   - The canonical signals are:
#       1) .jobs-search-no-results-banner presence → every card is filler.
#       2) The `eBP` query param on each card's anchor:
#            NON_CHARGEABLE_CHANNEL / C / CHARGEABLE_CHANNEL → real hit
#            NOT_ELIGIBLE_FOR_CHARGING                       → JYMBII filler
EBP_REAL = {"NON_CHARGEABLE_CHANNEL", "C", "CHARGEABLE_CHANNEL"}
EBP_JYMBII = {"NOT_ELIGIBLE_FOR_CHARGING"}


def _classify_card(ebp: str, banner_present: bool) -> str:
    """Return 'real', 'jymbii', or 'unknown'. Banner overrides everything."""
    if banner_present:
        return "jymbii"
    if not ebp:
        return "unknown"
    if ebp in EBP_JYMBII:
        return "jymbii"
    if ebp in EBP_REAL:
        return "real"
    return "unknown"


def _href_params(href: str) -> tuple[str, str]:
    """Return (trk, eBP). Either may be ''."""
    from urllib.parse import urlparse, parse_qs
    try:
        q = parse_qs(urlparse(href).query)
        return (q.get("trk") or [""])[0], (q.get("eBP") or [""])[0]
    except Exception:
        return "", ""


# Token-relevance filter for keyword queries — added 2026-04 after a full
# run showed phrase-quoting ("security researcher") over-restricted and
# missed most real hits (NVIDIA / MSFT / etc titled "Security Research
# Engineer"). We drop the phrase quotes so LinkedIn does its standard
# AND-with-relevance match, then cull cards whose title+company don't
# contain ANY distinctive token from the query.
KEYWORD_STOPWORDS = {
    "engineer", "engineering", "developer", "senior", "staff", "principal",
    "lead", "manager", "director", "analyst", "architect", "specialist",
    "expert", "professional", "role", "job", "position", "junior", "mid",
    "level", "applied",
}
# Short acronyms worth keeping (len<4).
KEYWORD_KEEP_SHORT = {"mpc", "zk", "fhe", "tss", "hsm", "kms", "pqc", "zkp"}


def _query_tokens(query: str) -> list[str]:
    """Distinctive lowercased tokens: len>=4 OR in KEYWORD_KEEP_SHORT,
    minus KEYWORD_STOPWORDS. Deduped, order-preserving."""
    raw = re.findall(r"[a-zA-Z]+", (query or "").lower())
    seen: set[str] = set()
    out: list[str] = []
    for t in raw:
        if t in KEYWORD_KEEP_SHORT or (len(t) >= 4 and t not in KEYWORD_STOPWORDS):
            if t not in seen:
                seen.add(t)
                out.append(t)
    return out


def _card_matches_tokens(title: str, company: str, tokens: list[str]) -> bool:
    """Return True if the card looks on-topic for the query tokens.
    Empty token list => pass-through (can't filter).

    For each token, also try a "drop trailing y" stem so the filter accepts
    morphological variants. Examples: a "cryptography" query must accept
    "Senior Cryptographer" titles (cryptography→cryptograph is a stem of
    both forms); "security" → "securit" matches "secure" / "security" /
    "securing". The rule is intentionally tiny and conservative — Claude
    scoring is still the second line of defense.
    """
    if not tokens:
        return True
    blob = f"{title} {company}".lower()
    for tok in tokens:
        if tok in blob:
            return True
        # Strip trailing "y" / "er" for tokens long enough that a 2-char
        # truncation still has signal.
        if len(tok) > 5 and tok.endswith("y") and tok[:-1] in blob:
            return True
        if len(tok) > 6 and tok.endswith("er") and tok[:-2] in blob:
            return True
    return False


def _page_has_no_results_banner(page) -> bool:
    """LinkedIn shows .jobs-search-no-results-banner (among a few variants) when
    a query truly has zero hits. When present, every card on screen is filler."""
    try:
        return bool(page.evaluate(
            """() => Boolean(
              document.querySelector('.jobs-search-no-results-banner') ||
              document.querySelector('.jobs-search-two-pane__no-results-banner') ||
              document.querySelector('[class*="no-results-banner"]')
            )"""
        ))
    except Exception:
        return False


def _query_cards(page):
    """Return the first non-empty card list across the known selector patterns."""
    for sel in CARD_SELECTORS:
        cards = page.query_selector_all(sel)
        if cards:
            return cards, sel
    return [], None


def _count_populated_cards(page) -> int:
    """Count cards that have a populated /jobs/view/ anchor — not just empty
    occludable shells. LinkedIn creates <li data-occludable-job-id> nodes in
    bulk during scroll but only hydrates the ones near the viewport. Counting
    raw shells makes `_load_all_cards` think the page is fully loaded when
    most cards are still empty placeholders."""
    try:
        return page.evaluate(
            """() => document.querySelectorAll(
                 "li.scaffold-layout__list-item a[href*='/jobs/view/'], " +
                 "li.jobs-search-results__list-item a[href*='/jobs/view/'], " +
                 "div.job-card-container a[href*='/jobs/view/']"
               ).length"""
        )
    except Exception:
        return 0


def _wait_for_cards(page, timeout_ms=10000):
    """Wait until at least one job card selector matches."""
    deadline = time.time() + (timeout_ms / 1000.0)
    while time.time() < deadline:
        for sel in CARD_SELECTORS:
            try:
                el = page.query_selector(sel)
                if el:
                    return sel
            except Exception:
                pass
        time.sleep(0.25)
    return None


def _load_all_cards(page, max_cards=25, max_scrolls=40, stable_needed=3):
    """
    Lazy-load every card on this page by scrolling the INNER results pane
    (not the window). On the logged-in LinkedIn SPA, scrolling the window
    does nothing — the results list is an overflow:auto container and only
    scrolling it triggers the Voyager XHR for batch start+25…start+49.

    Counts POPULATED cards (with /jobs/view/ anchor) — NOT raw occludable
    shells. LinkedIn pre-creates `<li data-occludable-job-id>` placeholders
    during scroll and only hydrates them near the viewport, so counting
    shells falsely plateaus at 25 when most are empty.
    """
    stable_rounds = 0
    last_count = 0
    pane_selectors_json = json.dumps(RESULTS_PANE_SELECTORS)

    for _ in range(max_scrolls):
        count = _count_populated_cards(page)
        if count >= max_cards:
            break
        if count == last_count:
            stable_rounds += 1
            if stable_rounds >= stable_needed:
                break
        else:
            stable_rounds = 0
            last_count = count

        try:
            page.evaluate(
                f"""() => {{
                  const sels = {pane_selectors_json};
                  for (const s of sels) {{
                    const el = document.querySelector(s);
                    if (el && el.scrollHeight > el.clientHeight) {{
                      el.scrollTop = el.scrollHeight;
                      return true;
                    }}
                  }}
                  // Fallback: scroll the window in case the layout has
                  // reverted to guest-style (no inner overflow container).
                  window.scrollBy(0, window.innerHeight * 0.9);
                  return false;
                }}"""
            )
        except Exception:
            pass
        # Slightly longer sleep — content hydration takes ~400-700ms per batch.
        time.sleep(random.uniform(0.8, 1.3))

    # Return the raw card nodes — downstream extractor skips unpopulated ones.
    cards, _ = _query_cards(page)
    return cards


def _extract_jobs_from_cards(cards, query, category, banner_present=False,
                             category_type: str = "keyword"):
    """
    Extract job dicts, dropping any card classified as JYMBII filler.
    Classification order:
      1) no-results banner present → every card is filler (all dropped)
      2) eBP=NOT_ELIGIBLE_FOR_CHARGING → JYMBII filler
      3) company-mode relevance: query string must appear in the card's
         company field. For company queries, LinkedIn silently falls back
         to region-sorted-by-date when the company has no postings, with
         NO banner — and stamps the filler with eBP=NON_CHARGEABLE_CHANNEL,
         identical to real hits. Without this relevance guard, 7 unrelated
         jobs would be treated as real Ingonyama hits.
      4) keyword-mode token relevance: for non-company queries, at least one
         distinctive token from the query (len>=4 or known acronym, minus
         stopwords) must appear in title+company. Catches mixed-filler
         cases where LinkedIn returns some real hits + region-sorted padding
         without firing the banner.
    Returns (jobs, stats).
    """
    jobs = []
    stats = {"real": 0, "jymbii": 0, "unknown": 0,
             "dropped_jymbii": [], "dropped_offtarget": []}
    q_lower = (query or "").lower()
    # Behavior is driven by category_type, not the literal `category` string —
    # legacy fall-through keeps "company" id working too.
    is_company_query = (category_type == "company") or (category == "company")
    query_tokens = [] if is_company_query else _query_tokens(query)

    for card in cards:
        try:
            link_el = card.query_selector("a[href*='/jobs/view/']")
            if not link_el:
                continue
            href = link_el.get_attribute("href") or ""
            if "/jobs/view/" not in href:
                continue
            job_id = href.split("/jobs/view/")[1].split("/")[0].split("?")[0]

            # Stage 1: eBP / banner classification.
            trk, ebp = _href_params(href)
            klass = _classify_card(ebp, banner_present)
            if klass == "jymbii":
                aria = (link_el.get_attribute("aria-label") or "").strip()
                stats["jymbii"] += 1
                stats["dropped_jymbii"].append(_clean_title(aria)[:60])
                continue

            # Prefer aria-label on the link — it's the single clean title string
            # (LinkedIn's visible title has a duplicated screen-reader span).
            aria = (link_el.get_attribute("aria-label") or "").strip()

            title_el = card.query_selector(
                ".job-card-list__title--link, .job-card-list__title, "
                ".base-card__full-link, .artdeco-entity-lockup__title a, "
                ".artdeco-entity-lockup__title"
            )
            raw_title = aria or (title_el.inner_text() if title_el else link_el.inner_text())
            title = _clean_title(raw_title)

            company_el = card.query_selector(
                ".job-card-container__company-name, .base-search-card__subtitle, "
                ".artdeco-entity-lockup__subtitle"
            )
            company = _clean_title(company_el.inner_text()) if company_el else ""

            loc_el = card.query_selector(
                ".job-card-container__metadata-item, .base-search-card__metadata, "
                ".artdeco-entity-lockup__caption"
            )
            location = _clean_title(loc_el.inner_text()) if loc_el else ""

            # Stage 3a: company-mode relevance. See docstring — Ingonyama
            # query returned 7 unrelated jobs (MyHeritage, Apple, Google...)
            # all tagged eBP=NON_CHARGEABLE_CHANNEL with no banner. This is
            # the canonical silent-fallback failure mode LinkedIn triggers
            # when a company-name keyword has 0 matches.
            if is_company_query and q_lower and q_lower not in company.lower():
                stats["jymbii"] += 1
                stats["dropped_offtarget"].append(
                    f"{title[:40]} @ {company[:24]}"
                )
                continue

            # Stage 3b: keyword-mode token relevance. With phrase-quoting
            # removed, an unquoted "cryptography engineer" search can return
            # unrelated recent postings as filler. Require at least one
            # distinctive query token to appear in title+company.
            if query_tokens and not _card_matches_tokens(title, company, query_tokens):
                stats["jymbii"] += 1
                stats["dropped_offtarget"].append(
                    f"{title[:40]} @ {company[:24]}"
                )
                continue

            stats[klass] += 1
            jobs.append({
                "id": job_id,
                "title": title,
                "company": company,
                "location": location,
                "url": f"https://www.linkedin.com/jobs/view/{job_id}/",
                "query": query,
                "category": category,
                # See note in scrape_query_guest's job dict — category_name
                # is the stable human label, written at scrape time so it
                # survives any later config rewrites.
                "category_name": _category_name_for_id(category),
                "found_at": datetime.now().isoformat(),
                "priority": any(p in company.lower() for p in PRIORITY_COMPANIES),
                "msc_required": None,
                "fit": None,
                "fit_reasons": [],
                "source": "loggedin",
            })
        except Exception:
            continue
    return jobs, stats


def _build_search_url(query: str, start: int = 0, date_filter: str | None = None) -> str:
    # Send queries UNQUOTED so LinkedIn runs its default AND-with-relevance
    # match instead of strict phrase match. Phrase-quoting caused a 2026-04
    # full-run to miss most real hits (e.g. "security researcher" quoted
    # skipped "Security Research Engineer" titles entirely). JYMBII filler
    # from no-match keyword queries is now caught downstream via:
    #   1) the no-results banner check
    #   2) the eBP=NOT_ELIGIBLE_FOR_CHARGING filter
    #   3) the token-relevance check in _extract_jobs_from_cards
    keyword_value = query

    # Resolve the date filter. `date_filter=""` → drop f_TPR entirely
    # (any date). None → use module-level DATE_FILTER default (7 days).
    tpr = DATE_FILTER if date_filter is None else date_filter
    parts = [
        "https://www.linkedin.com/jobs/search/",
        f"?keywords={quote_plus(keyword_value)}",
        "&sortBy=DD",
    ]
    if tpr:
        parts.insert(2, f"&f_TPR={tpr}")
    if GEO_ID:
        parts.append(f"&geoId={GEO_ID}")
    if LOCATION:
        parts.insert(2, f"&location={quote_plus(LOCATION)}")
    if EXPERIENCE_FILTER:
        parts.append(f"&f_E={EXPERIENCE_FILTER}")
    if JOB_TYPE_FILTER:
        parts.append(f"&f_JT={JOB_TYPE_FILTER}")
    if WORKPLACE_FILTER:
        parts.append(f"&f_WT={WORKPLACE_FILTER}")
    if start:
        parts.append(f"&start={start}")
    return "".join(parts)


def scrape_query(page, query: str, category: str = "crypto",
                 max_pages: int = 3, date_filter: str | None = None,
                 stats_out: dict | None = None,
                 category_type: str = "keyword") -> list[dict]:
    """
    Fetch up to `max_pages` pages (25 jobs each) for a query, paginating via
    &start=. For each page: wait for cards to appear, scroll the INNER
    results pane until the card count stabilizes, then extract — filtering
    out any JYMBII / "you may be interested in" filler cards.

    If LinkedIn shows a "no results" banner on page 1, we treat the whole
    query as a zero-hit query and discard everything (the cards rendered
    below the banner are always filler).
    """
    all_jobs = []
    seen_ids = set()
    total_stats = {"real": 0, "jymbii": 0, "unknown": 0}
    banner_hit = False

    for page_idx in range(max_pages):
        start = page_idx * 25
        url = _build_search_url(query, start=start, date_filter=date_filter)
        if not safe_goto(page, url):
            break
        time.sleep(random.uniform(1.5, 2.8))

        # Wait for the results list to actually render before we start counting.
        if _wait_for_cards(page, timeout_ms=10000) is None:
            # No cards on this page — stop paginating.
            break

        # Detect the "no results" banner. If present, every card on this
        # page is recommendation filler — abort the whole query.
        banner = _page_has_no_results_banner(page)
        if page_idx == 0 and banner:
            print("  ↳ LinkedIn shows no-results banner — query has 0 real hits.")
            banner_hit = True
            break

        cards = _load_all_cards(page, max_cards=25)
        page_jobs, stats = _extract_jobs_from_cards(
            cards, query, category, banner, category_type=category_type,
        )
        for k in ("real", "jymbii", "unknown"):
            total_stats[k] += stats[k]

        new_on_page = 0
        for job in page_jobs:
            if job["id"] in seen_ids:
                continue
            seen_ids.add(job["id"])
            all_jobs.append(job)
            new_on_page += 1

        # If this page returned nothing new (end of results or LinkedIn looping),
        # don't bother requesting further pages.
        if new_on_page == 0:
            break

        # If we're only seeing JYMBII cards on page 1, the keyword has no real
        # hits — LinkedIn is just paging the recommendation carousel. Stop.
        if page_idx == 0 and stats["real"] == 0 and stats["jymbii"] > 0:
            print(f"  ↳ page 1 is all JYMBII ({stats['jymbii']} filler cards) — "
                  f"skipping pagination.")
            break

        jiggle_mouse(page)
        time.sleep(random.uniform(1.5, 3.0))

    if banner_hit:
        if stats_out is not None:
            stats_out.update({
                "real": 0, "jymbii": 0, "unknown": 0, "banner": True,
            })
        return []

    if total_stats["jymbii"] or total_stats["unknown"]:
        print(f"  ↳ card classification: real={total_stats['real']} "
              f"jymbii={total_stats['jymbii']} unknown={total_stats['unknown']}")
    if stats_out is not None:
        stats_out.update({
            "real": total_stats["real"],
            "jymbii": total_stats["jymbii"],
            "unknown": total_stats["unknown"],
            "banner": False,
        })
    return all_jobs


# Ordered by specificity — first match wins. Pruned 2026-04: dropped overly
# broad ancestors (.jobs-description, .job-view-layout) and the chained
# article-prefix selector that's been deprecated in recent LinkedIn rollouts.
DESC_SELECTORS = [
    "#job-details",                                # canonical logged-in container
    ".jobs-description-content__text--stretch",    # current inner-text wrapper
    ".jobs-description-content__text",
    ".jobs-box__html-content",                     # legacy A/B variant
    ".jobs-description__content",                  # older logged-in fallback
    ".show-more-less-html__markup",                # public/anonymous page
]

AUTHWALL_MARKERS = ("authwall", "/login", "/checkpoint", "uas/login")


def _page_is_authwall(page) -> bool:
    url = (page.url or "").lower()
    return any(m in url for m in AUTHWALL_MARKERS)


def _click_see_more(page):
    """Expand truncated description if LinkedIn collapsed it."""
    for sel in [
        "button.jobs-description__footer-button",
        "button.show-more-less-html__button",
        "button:has-text('See more')",
    ]:
        try:
            btn = page.query_selector(sel)
            if btn and btn.is_visible():
                btn.click(timeout=1500)
                time.sleep(0.4)
                return
        except Exception:
            continue


def fetch_description(page, url: str, job_id: str = "") -> tuple[str, str]:
    """
    Returns (description_text_lower, diagnosis).
    diagnosis ∈ {'ok', 'empty-dom', 'authwall', 'nav-failed', 'error'}.

    IMPORTANT: when logged in, navigating directly to /jobs/view/<id>/ shows a
    Premium-promo layout with obfuscated CSS-in-JS class names — none of the
    stable .jobs-description-* selectors work there. The reliable URL is
    /jobs/search/?currentJobId=<id>, which loads the jobs results page with
    the requested job in the side pane (where #job-details and the
    .jobs-description-content__text* family all work). We override the URL
    here so callers don't have to know.

    Note (2026-04-23): the JSON-LD JobPosting fallback was removed — LinkedIn
    has dropped the <script type="application/ld+json"> block from public job
    pages, so the fallback was silently returning "" and masquerading as a
    working code path. CSS selectors are now the sole description source.
    """
    if job_id:
        fetch_url = f"https://www.linkedin.com/jobs/search/?currentJobId={job_id}"
    else:
        fetch_url = url
    try:
        if not safe_goto(page, fetch_url):
            return "", "nav-failed"
        time.sleep(random.uniform(1.0, 1.8))

        if _page_is_authwall(page):
            return "", "authwall"

        # Wait for at least one of the known description containers to appear.
        deadline = time.time() + 6
        found = None
        while time.time() < deadline and not found:
            for sel in DESC_SELECTORS:
                try:
                    el = page.query_selector(sel)
                    if el:
                        text = (el.inner_text() or "").strip()
                        if len(text) >= 80:
                            found = el
                            break
                except Exception:
                    pass
            if not found:
                time.sleep(0.3)

        if not found:
            return "", "empty-dom"

        # Expand "See more" and re-read.
        _click_see_more(page)
        time.sleep(0.3)
        text = ""
        for sel in DESC_SELECTORS:
            try:
                el = page.query_selector(sel)
                if el:
                    t = (el.inner_text() or "").strip()
                    if len(t) > len(text):
                        text = t
            except Exception:
                continue

        return text.lower(), "ok"
    except Exception as e:
        return "", f"error:{str(e)[:60]}"


def check_msc(desc: str) -> bool:
    return any(re.search(p, desc, re.IGNORECASE) for p in MSC_PATTERNS)


def check_fit(desc: str) -> tuple[str, list[str]]:
    pos = [p for p in FIT_POSITIVE if re.search(p, desc, re.IGNORECASE)]
    neg = [p for p in FIT_NEGATIVE if re.search(p, desc, re.IGNORECASE)]
    score = len(pos) - len(neg) * 2
    label = "good" if score >= 2 else ("ok" if score >= 0 else "skip")
    reasons = [f"+{p}" for p in pos] + [f"-{p}" for p in neg]
    return label, reasons


def _apply_regex_fallback(job: dict, desc: str):
    job["msc_required"] = check_msc(desc)
    job["fit"], job["fit_reasons"] = check_fit(desc)
    job["scored_by"] = "regex"
    job["scored_at"] = datetime.now().isoformat()


def _apply_claude_scoring(job: dict, scored: dict):
    job["fit"] = scored.get("fit")
    job["score"] = scored.get("score")
    job["msc_required"] = scored.get("msc_required")
    reasons = list(scored.get("reasons", []) or [])
    for flag in scored.get("red_flags", []) or []:
        reasons.append(f"flag: {flag}")
    job["fit_reasons"] = reasons
    job["scored_by"] = "claude"
    job["scored_at"] = datetime.now().isoformat()


def score_jobs_in_batches(jobs: list[dict], cv_text: str):
    """Send jobs to Claude in batches. Mutates each job in-place. Falls back
    to regex for any job Claude didn't score."""
    if not jobs:
        return

    scored_anything = False
    for i in range(0, len(jobs), BATCH_SIZE):
        batch = jobs[i:i + BATCH_SIZE]
        batch_num = i // BATCH_SIZE + 1
        total_batches = (len(jobs) + BATCH_SIZE - 1) // BATCH_SIZE
        print(f"  Scoring batch {batch_num}/{total_batches} ({len(batch)} jobs)...")
        scored_map = claude_batch_score(cv_text, batch) if cv_text else None
        if scored_map:
            scored_anything = True
            for job in batch:
                scoring = scored_map.get(str(job["id"]))
                if scoring:
                    _apply_claude_scoring(job, scoring)
                else:
                    _apply_regex_fallback(job, job.get("_desc", ""))
        else:
            for job in batch:
                _apply_regex_fallback(job, job.get("_desc", ""))

    # Clean up transient desc fields.
    for job in jobs:
        job.pop("_desc", None)

    return scored_anything


def print_job(job: dict, label: str = ""):
    prefix = "🔥 " if job.get("priority") else "   "
    tag = f" [{label}]" if label else ""

    flags = []
    if job.get("score") is not None:
        flags.append(f"score {job['score']}/10")
    if job.get("fit"):
        fit_map = {"good": "✓ good", "ok": "~ ok", "skip": "✗ skip"}
        flags.append(fit_map.get(job["fit"], job["fit"]))
    if job.get("msc_required"):
        flags.append("MSc")
    flag_str = f"  ({', '.join(flags)})" if flags else ""

    print(f"\n{prefix}{job['title']} @ {job['company']}{tag}{flag_str}")
    print(f"   {job['location']}")
    print(f"   {job['url']}")
    if job.get("fit_reasons"):
        print(f"   signals: {', '.join(job['fit_reasons'][:6])}")


def new_page_with_stealth(ctx, stealth_js: str | None = None):
    """Create a new page and inject the stealth init script on every navigation.
    `stealth_js` should be the locale-resolved STEALTH_JS_TEMPLATE rendering
    (use _build_stealth_js); if omitted we fall back to detecting from the
    active config / system at call time."""
    page = ctx.new_page()
    if stealth_js is None:
        loc, _ = _resolved_browser_locale_tz()
        stealth_js = _build_stealth_js(loc)
    page.add_init_script(stealth_js)
    return page


# ---------------------------------------------------------------------------
# Pipeline runners — one per backend mode. Both have the same signature and
# the same side-effects on the shared accumulator dicts/lists, so main()
# just dispatches based on --mode.
#
# Returns: (prefilter_skipped: int, diagnosis_counts: dict)
# ---------------------------------------------------------------------------


def process_one_job(
    job: dict,
    *,
    cv_text: str,
    fetch_one,
    persist: bool = True,
    already_scored: bool = False,
) -> dict:
    """Run the per-job pipeline for ONE already-parsed job dict.

    Mutates `job` in place and returns it. This is the single source-of-truth
    entry point for everything downstream of "we know about this LinkedIn
    job ID and have a stub dict for it":

      Stage 1 — title pre-filter (`is_obviously_offtopic`); priority-marked
                jobs bypass the filter so high-interest companies always
                enrich + score.
      Stage 2 — description fetch via the injected `fetch_one(job)` callable.
                The callable is mode-specific:
                  guest    → `fetch_description_guest(session, job_id)`
                  loggedin → `fetch_description(page, url, job_id)`
                  manual   → guest fetcher (no browser, single-job CLI use).
                Returns (text_lower, diag).
      Stage 3 — Claude single-item batch scoring via `claude_batch_score`,
                UNLESS `already_scored=True` — the scraper main loop pre-
                batches Claude across the whole new_jobs queue for throughput
                and then calls this helper per job with `already_scored=True`
                just to apply the regex-fallback / persistence stages.
      Stage 4 — regex fallback (`_apply_regex_fallback`) if Claude didn't
                return a score for this id.
      Stage 5 — atomic-merge persistence into results.json + seen_jobs.json
                under fcntl lock (skipped when `persist=False`, e.g. when the
                scraper batches its own writes at the end of a run).

    Manual-add (corpus_ctl.py add-manual) calls with `persist=True,
    already_scored=False` to ingest one user-typed URL through the same
    code path the scraper uses. Scraper batches call with `persist=False`
    inside _enrich_descriptions's per-job loop (so throttled fetches still
    drive a single helper) and then loop again with `persist=True,
    already_scored=True` after the run-level Claude batch returns.
    """
    # Stage 1 — title pre-filter. Priority-flagged companies bypass.
    reason = is_obviously_offtopic(job.get("title") or "")
    if reason and not job.get("priority"):
        job["fit"] = "skip"
        job["score"] = 1
        job["fit_reasons"] = [f"title: matches /{reason}/"]
        job["scored_by"] = "title-filter"
        job["scored_at"] = datetime.now().isoformat()
        if persist:
            save_results_merge([job])
            save_seen({job["id"]})
        return job

    # Stage 2 — description fetch.
    if not already_scored:
        try:
            desc, diag = fetch_one(job)
        except Exception as e:
            desc, diag = "", f"error:{str(e)[:60]}"
        job["_desc"] = desc
        job["_diag"] = diag

        # Stage 3 — Claude single-item batch.
        scored_map = (
            claude_batch_score(cv_text, [job])
            if (cv_text and desc) else None
        )
        if scored_map and str(job["id"]) in scored_map:
            _apply_claude_scoring(job, scored_map[str(job["id"])])
        else:
            # Stage 4 — regex fallback.
            _apply_regex_fallback(job, desc)

        # Strip transient hints — they'd just bloat results.json.
        job.pop("_desc", None)
        job.pop("_diag", None)
    else:
        # already_scored=True path: scraper has already populated fit/score
        # via its run-level batch; if anything is still unset, regex fallback.
        if job.get("fit") is None:
            _apply_regex_fallback(job, job.get("_desc", "") or "")
        job.pop("_desc", None)
        job.pop("_diag", None)

    # Stage 4.5 — derive `hot` from the just-applied fit/score/priority.
    # Single source of truth: the frontend reads `j.hot` directly rather
    # than recomputing the formula in TypeScript (avoids drift).
    job["hot"] = _compute_hot(job)

    # Stage 5 — atomic-merge persistence (single-row writes are safe to
    # interleave with batched scraper writes thanks to the fcntl lock).
    if persist:
        save_results_merge([job])
        save_seen({job["id"]})
    return job


# `hot` formula: a job is hot when Claude rated it 'good' AND either its
# raw score crosses the threshold OR it's at a priority-list company.
# Both clauses require fit='good' — a 'skip' job at a priority company
# is NOT hot. Threshold is hardcoded for now; can be moved to config.json
# later if tuning becomes useful.
HOT_SCORE_MIN = 8

def _compute_hot(job: dict) -> bool:
    if job.get("fit") != "good":
        return False
    score = job.get("score")
    if isinstance(score, (int, float)) and score >= HOT_SCORE_MIN:
        return True
    if job.get("priority"):
        return True
    return False


def _enrich_descriptions(args, new_jobs, cv_text, diagnosis_counts,
                         fetch_one):
    """Shared enrichment stage. `fetch_one(job)` returns (text_lower, diag)
    for one job. Returns prefilter_skipped count.

    Composes `process_one_job` for the per-row title pre-filter + regex
    fallback steps, but keeps the run-level batched description-fetch
    throttling and the run-level batched Claude scoring intact for
    throughput. Persistence is deferred to the scraper main loop
    (`save_results_merge(new_jobs)` after the enrich pass), so all calls
    here pass `persist=False`.
    """
    prefilter_skipped = 0
    if args.no_enrich or not new_jobs:
        return prefilter_skipped

    # Stage 1: title pre-filter — same for both modes. We use process_one_job
    # with a no-op fetch + no-persist to walk the helper's title-filter branch
    # so any future changes to it apply uniformly to scraper + manual-add.
    to_fetch = []
    for job in new_jobs:
        reason = is_obviously_offtopic(job["title"])
        if reason and not job.get("priority"):
            job["fit"] = "skip"
            job["score"] = 1
            job["fit_reasons"] = [f"title: matches /{reason}/"]
            job["scored_by"] = "title-filter"
            job["scored_at"] = datetime.now().isoformat()
            prefilter_skipped += 1
        else:
            to_fetch.append(job)
    print(f"\nPre-filter: skipped {prefilter_skipped} off-topic titles; "
          f"fetching descriptions for {len(to_fetch)} jobs.")

    # Stage 2: fetch descriptions one-by-one. Backend supplies fetch_one.
    # Inter-request throttling — baseline 1.5–3.0 s between fetches; every
    # 20 requests, take a longer ~10 s breather. Based on 2026 public guides
    # for the /jobs-guest endpoints and empirical 429 bursts observed during
    # rescue runs. The loggedin path is rate-limited by the browser naturally
    # but the sleep costs little there too.
    for i, job in enumerate(to_fetch):
        short_title = (job["title"] or "")[:60]
        print(f"  [{i+1}/{len(to_fetch)}] {short_title} @ {job['company']}")
        try:
            desc, diag = fetch_one(job)
        except Exception as e:
            desc, diag = "", f"error:{str(e)[:60]}"
        bucket = diag if diag in diagnosis_counts else "error"
        diagnosis_counts[bucket] = diagnosis_counts.get(bucket, 0) + 1
        if diag != "ok":
            print(f"    ⚠ description fetch: {diag}")
        job["_desc"] = desc
        # Inter-request sleep.
        if i < len(to_fetch) - 1:
            time.sleep(random.uniform(1.5, 3.0))
            # Every 20 fetches, an extra cool-down to avoid sustained-rate
            # ratelimiting on bigger batches.
            if (i + 1) % 20 == 0:
                print(f"    … 20-fetch cool-down (10s)")
                time.sleep(10.0)

    print("  Description fetch summary: " +
          ", ".join(f"{k}={v}" for k, v in diagnosis_counts.items()))

    # Stage 3: Claude batch scoring (preserved at the run level for throughput).
    to_score = [j for j in to_fetch if j.get("_desc")]
    if to_score:
        print(f"\nScoring {len(to_score)} jobs via Claude in batches of {BATCH_SIZE}...")
        score_jobs_in_batches(to_score, cv_text)

    # Stage 4: regex fallback for anything still unscored. Routed through
    # process_one_job(already_scored=True, persist=False) so the helper is
    # the single home for the "scraper batched, now finalize per row" path.
    # _desc is consumed and stripped inside the helper.
    def _no_fetch(_j):  # never actually called when already_scored=True
        return "", "ok"
    for job in to_fetch:
        process_one_job(
            job,
            cv_text=cv_text,
            fetch_one=_no_fetch,
            persist=False,
            already_scored=True,
        )

    return prefilter_skipped


def _run_loggedin_pipeline(args, all_queries, seen, new_jobs, max_pages,
                           date_filter_override, cv_text, per_query_stats,
                           run_errors):
    """Original Playwright-driven path — needs linkedin_session.json."""
    # Defer playwright import so guest mode can run on installs without it.
    # Raises ImportError with install instructions if playwright is missing.
    _require_playwright()

    diagnosis_counts = {"ok": 0, "empty-dom": 0, "authwall": 0,
                        "nav-failed": 0, "error": 0}

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=False,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--disable-features=IsolateOrigins,site-per-process",
            ],
            ignore_default_args=["--enable-automation"],
        )
        # Auto-detect locale + timezone from the system so the browser
        # fingerprint matches the user's actual machine. LinkedIn correlates
        # navigator.language / navigator.languages / Intl tz vs. session geo;
        # mismatches can trigger soft-blocks. Was hardcoded to en-US +
        # Asia/Jerusalem pre-2026-04. Override via config keys
        # `playwright_locale` / `playwright_timezone`.
        resolved_locale, resolved_tz = _resolved_browser_locale_tz()
        stealth_js = _build_stealth_js(resolved_locale)
        context_kwargs = dict(
            viewport={"width": 1280, "height": 800},
            locale=resolved_locale,
            timezone_id=resolved_tz,
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
        )

        if SESSION_FILE.exists():
            ctx = browser.new_context(storage_state=str(SESSION_FILE), **context_kwargs)
            page = new_page_with_stealth(ctx, stealth_js=stealth_js)
            print("Loaded saved session. Verifying login...")
            try:
                page.goto("https://www.linkedin.com/feed/",
                          wait_until="domcontentloaded", timeout=20000)
            except Exception as e:
                print(f"Failed to reach feed: {str(e)[:120]}")
            time.sleep(random.uniform(2, 3.5))
            current = page.url
            if "login" in current or "authwall" in current or "checkpoint" in current:
                print("Session expired — please log in again.")
                try:
                    SESSION_FILE.unlink()
                except Exception:
                    pass
                ctx.close(); browser.close()
                print("Re-run the script to log in fresh.")
                sys.exit(1)
        else:
            # First-run logged-in flow needs a real terminal: we open a browser
            # for the user to sign in, then block on input() until they press
            # Enter. When the UI spawns this script via Vite middleware there's
            # no TTY → input() blocks forever and the UI shows a stuck "running"
            # spinner. Detect that case BEFORE opening a browser and bail with
            # an actionable message.
            if not sys.stdin.isatty():
                browser.close()
                print(
                    "Logged-in mode's first run needs a terminal — run from "
                    "your shell with: cd " + str(ROOT) + " && python3 "
                    "backend/search.py --mode=loggedin. After the session is "
                    "saved you can use the UI normally.",
                    file=sys.stderr,
                )
                sys.exit(2)
            ctx = browser.new_context(**context_kwargs)
            page = new_page_with_stealth(ctx, stealth_js=stealth_js)
            print("No saved session found. Browser will open — please log in to LinkedIn.")
            print("Once you see your feed, come back here and press Enter to continue...")
            try:
                page.goto("https://www.linkedin.com/login",
                          wait_until="domcontentloaded", timeout=20000)
            except Exception as e:
                print(f"Failed to open login page: {str(e)[:120]}")
            input()
            ctx.storage_state(path=str(SESSION_FILE))
            print(f"Session saved to {SESSION_FILE}")
            time.sleep(2)

        for query, category, category_type in all_queries:
            print(f"Searching [{category}/{category_type}]: {query!r} ...")
            qstats = {"real": 0, "jymbii": 0, "unknown": 0,
                      "banner": False, "jobs_kept_after_dedup": 0}
            try:
                jobs = scrape_query(page, query, category,
                                    max_pages=max_pages,
                                    date_filter=date_filter_override,
                                    stats_out=qstats,
                                    category_type=category_type)
                new_in_query = [j for j in jobs if j["id"] not in seen]
                print(f"  {len(jobs)} results, {len(new_in_query)} new")
                for job in new_in_query:
                    seen.add(job["id"])
                    new_jobs.append(job)
                qstats["jobs_kept_after_dedup"] = len(new_in_query)
            except PlaywrightTimeout:
                print(f"  Timeout — skipping")
                run_errors.append({"query": query, "error": "PlaywrightTimeout"})
            except Exception as e:
                print(f"  Error on query {query!r}: {str(e)[:120]}")
                run_errors.append({"query": query, "error": str(e)[:300]})
            per_query_stats.append({"query": query, "category": category, **qstats})
            jiggle_mouse(page)
            time.sleep(random.uniform(3.0, 6.0))

        # Per-job description fetcher closure — uses the page from this scope.
        def _fetch_one(job):
            return fetch_description(page, job["url"], job["id"])

        prefilter_skipped = _enrich_descriptions(
            args, new_jobs, cv_text, diagnosis_counts, _fetch_one
        )

        ctx.close(); browser.close()

    return prefilter_skipped, diagnosis_counts


def _run_guest_pipeline(args, all_queries, seen, new_jobs, max_pages,
                        date_filter_override, cv_text, per_query_stats,
                        run_errors):
    """Unauthenticated HTTP path — no browser, no session needed."""
    diagnosis_counts = {"ok": 0, "empty": 0, "error": 0}
    geo_id = (args.geo_id or _ACTIVE_CONFIG.get("geo_id") or "").strip() or None

    session = _guest_session()
    print(f"Guest mode: geoId={geo_id or '(worldwide — set geo_id in config to scope)'}")

    for query, category, category_type in all_queries:
        print(f"Searching [{category}/{category_type}]: {query!r} ...")
        qstats = {"real": 0, "jymbii": 0, "unknown": 0,
                  "banner": False, "jobs_kept_after_dedup": 0}
        try:
            jobs = scrape_query_guest(
                session, query, category,
                max_pages=max_pages,
                date_filter=date_filter_override,
                geo_id=geo_id,
                category_type=category_type,
            )
            qstats["real"] = len(jobs)
            new_in_query = [j for j in jobs if j["id"] not in seen]
            print(f"  {len(jobs)} results, {len(new_in_query)} new")
            for job in new_in_query:
                seen.add(job["id"])
                new_jobs.append(job)
            qstats["jobs_kept_after_dedup"] = len(new_in_query)
        except Exception as e:
            print(f"  Error on query {query!r}: {str(e)[:120]}")
            run_errors.append({"query": query, "error": str(e)[:300]})
        per_query_stats.append({"query": query, "category": category, **qstats})
        time.sleep(random.uniform(1.0, 2.5))

    def _fetch_one(job):
        return fetch_description_guest(session, job["id"])

    prefilter_skipped = _enrich_descriptions(
        args, new_jobs, cv_text, diagnosis_counts, _fetch_one
    )
    return prefilter_skipped, diagnosis_counts


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--all", action="store_true", help="show all results including seen")
    parser.add_argument("--no-enrich", action="store_true", help="skip description fetching (faster)")
    parser.add_argument("--all-time", action="store_true",
                        help="drop the 7-day date filter (any posting date). "
                             "Implicitly bumps --pages to 10 unless overridden.")
    parser.add_argument("--pages", type=int, default=None,
                        help="max pages per query (default: from config.json or 3, "
                             "or 10 with --all-time)")
    parser.add_argument("--print-defaults", action="store_true",
                        help="emit hardcoded defaults as JSON to stdout and exit "
                             "(used by the UI's 'Reset to defaults' action)")
    parser.add_argument("--mode", choices=["loggedin", "guest"], default="loggedin",
                        help="Scrape backend: 'loggedin' (current Playwright path, "
                             "needs linkedin_session.json) or 'guest' (unauthenticated "
                             "HTTP via /jobs-guest endpoints — no browser, no account, "
                             "more results, surfaces Big Tech postings the personalized "
                             "search hides). Both modes share results.json + seen_jobs.json "
                             "via fcntl-locked merges so they can run in parallel.")
    parser.add_argument("--geo-id", default=None,
                        help="Override the geoId for guest mode (default: Israel "
                             "101620260). Ignored in loggedin mode (LinkedIn picks "
                             "geo from the session).")
    parser.add_argument("--test-llm", nargs="?", const="auto", default=None,
                        metavar="PROVIDER",
                        help="Test the LLM scoring backend and exit. Optional "
                             "PROVIDER ∈ {auto, claude_cli, claude_sdk, gemini, "
                             "openrouter, ollama}. Default: auto.")
    args = parser.parse_args()

    if args.test_llm is not None:
        from backend.llm import test_provider
        ok, msg = test_provider(args.test_llm)
        prefix = "OK" if ok else "FAIL"
        print(f"[{prefix}] {msg}")
        sys.exit(0 if ok else 1)

    if args.print_defaults:
        # Print the *hardcoded* defaults — not the merged active config —
        # so the UI's "Reset to defaults" button always lands on the
        # in-file source-of-truth, regardless of what's currently in
        # config.json.
        print(json.dumps(_hardcoded_defaults(), indent=2, ensure_ascii=False))
        return

    # Track when we started for run history (move now() up here so it's correct
    # even if early errors abort the run).
    started_at = datetime.now()
    started_perf = time.perf_counter()

    # Resolve scrape breadth. Config-file `max_pages` is the new default;
    # CLI --pages still overrides it; --all-time still bumps to 10 if neither
    # CLI flag nor config narrows it.
    config_pages = _ACTIVE_CONFIG.get("max_pages", 3)
    if args.pages is not None:
        max_pages = args.pages
    elif args.all_time:
        max_pages = 10
    else:
        max_pages = config_pages
    date_filter_override = "" if args.all_time else None  # None = use default DATE_FILTER
    print(f"Scrape settings: max_pages={max_pages}, "
          f"date_filter={'ANY' if args.all_time else DATE_FILTER}")

    seen = load_seen()
    all_results = load_results()
    new_jobs = []

    # Build the query plan from the user-defined CATEGORIES list. Each item
    # is (query, category_id, category_type) — the type drives whether the
    # scraper applies token-relevance (keyword) or company-name relevance
    # (company) downstream. Falls back to the legacy three-bucket structure
    # if CATEGORIES is empty for any reason.
    all_queries: list[tuple[str, str, str]] = []
    for cat in CATEGORIES:
        cid = cat.get("id") or "uncategorized"
        ctype = cat.get("type") or "keyword"
        for q in cat.get("queries", []):
            if q and isinstance(q, str):
                all_queries.append((q, cid, ctype))
    if not all_queries:
        all_queries = (
            [(q, "crypto", "keyword") for q in SEARCH_QUERIES]
            + [(q, "security_researcher", "keyword") for q in SECURITY_RESEARCHER_QUERIES]
            + [(q, "company", "company") for q in COMPANY_QUERIES]
        )

    cv_text = _load_cv_text()
    if cv_text:
        if shutil.which("claude"):
            print("Fit scoring: Claude Code CLI")
        elif os.environ.get("ANTHROPIC_API_KEY"):
            print("Fit scoring: Anthropic SDK (ANTHROPIC_API_KEY)")
        else:
            print("Fit scoring: regex fallback (install `claude` CLI or set ANTHROPIC_API_KEY for LLM scoring)")
    else:
        print(f"Fit scoring: regex fallback (no CV at {CV_FILE})")

    print(f"Backend mode: {args.mode}")

    # Stats accumulators shared across both modes.
    per_query_stats: list[dict] = []
    run_errors: list[dict] = []
    prefilter_skipped = 0
    diagnosis_counts = {"ok": 0, "empty-dom": 0, "authwall": 0,
                        "nav-failed": 0, "error": 0}

    if args.mode == "guest":
        prefilter_skipped, diagnosis_counts = _run_guest_pipeline(
            args=args, all_queries=all_queries, seen=seen, new_jobs=new_jobs,
            max_pages=max_pages, date_filter_override=date_filter_override,
            cv_text=cv_text, per_query_stats=per_query_stats,
            run_errors=run_errors,
        )
    else:
        prefilter_skipped, diagnosis_counts = _run_loggedin_pipeline(
            args=args, all_queries=all_queries, seen=seen, new_jobs=new_jobs,
            max_pages=max_pages, date_filter_override=date_filter_override,
            cv_text=cv_text, per_query_stats=per_query_stats,
            run_errors=run_errors,
        )

    # ===== POST-PROCESSING (shared by both modes) =====
    display_jobs = []
    skipped = []
    for job in new_jobs:
        if job.get("fit") == "skip":
            skipped.append(job)
        else:
            display_jobs.append(job)

    # Sort display jobs by score (highest first), priority companies first.
    def _sort_key(j):
        return (
            0 if j.get("priority") else 1,
            -(j.get("score") or 0),
            {"good": 0, "ok": 1, None: 2, "skip": 3}.get(j.get("fit"), 2),
        )
    display_jobs.sort(key=_sort_key)

    all_results.extend(new_jobs)
    save_seen(seen)
    # Pass only new_jobs — save_results_merge dedups against the on-disk corpus
    # under fcntl lock, which makes parallel --mode=guest + --mode=loggedin runs
    # safe (otherwise the second writer would overwrite the first's additions).
    save_results_merge(new_jobs)

    # Record the IDs that were new this run so send_email.py can pick them up.
    # Path MUST be ROOT — that's where send_email.py:NEW_IDS_FILE reads from,
    # and it matches the convention for every other persistent state file
    # (results.json, seen_jobs.json, run_history.json, etc.). Writing to
    # `HERE / new_ids.json` (which lives under backend/) silently dropped
    # all post-Apr-24 daily digests on the floor — the scrape produced fresh
    # IDs, but the email kept reading the stale ROOT file.
    (ROOT / "new_ids.json").write_text(
        json.dumps([j["id"] for j in new_jobs], indent=2)
    )

    print(f"\n{'='*55}")
    if display_jobs:
        priority = [j for j in display_jobs if j.get("priority")]
        normal = [j for j in display_jobs if not j.get("priority")]

        print(f"NEW JOBS: {len(display_jobs)} shown, {len(skipped)} filtered out")
        print(f"{'='*55}")

        if priority:
            print("\n--- PRIORITY COMPANIES ---")
            for job in priority:
                print_job(job)

        good = [j for j in normal if j.get("fit") == "good"]
        ok = [j for j in normal if j.get("fit") == "ok"]
        unscored = [j for j in normal if j.get("fit") not in ("good", "ok", "skip")]

        if good:
            print("\n--- GOOD FIT ---")
            for job in good:
                print_job(job)

        if ok:
            print("\n--- OK FIT ---")
            for job in ok:
                print_job(job)

        if unscored:
            print("\n--- UNSCORED ---")
            for job in unscored:
                print_job(job)
    else:
        print("No new jobs since last run.")

    if skipped:
        print(f"\n--- SKIPPED ({len(skipped)} — poor fit per Claude/regex) ---")
        for job in skipped:
            print_job(job, label="skipped")

    if args.all:
        old = [j for j in all_results if j not in new_jobs]
        if old:
            print(f"\n--- PREVIOUSLY SEEN ({len(old)}) ---")
            for job in old:
                print_job(job, label="seen")

    print(f"\nAll results saved to: {RESULTS_FILE}")

    # Write the polished HTML digest so the user can `open digest.html` after
    # a manual run. send_email.py will regenerate it (and optionally email)
    # when invoked from run.py on a schedule.
    #
    # Like every other persistent state file (results.json, seen_jobs.json,
    # run_history.json), digest.html lives at the project ROOT — NOT under
    # backend/. send_email.py reads ROOT/digest.html; writing it under HERE
    # would silently de-sync the manual-run path from the scheduled-run path.
    # Same convention as the HERE/ROOT block comment near search.py:805.
    try:
        from send_email import build_digest_html
        digest_jobs = [j for j in new_jobs if j.get("fit") != "skip"]
        html = build_digest_html(digest_jobs)
        digest_path = ROOT / "digest.html"
        digest_path.write_text(html, encoding="utf-8")
        print(f"Digest written: file://{digest_path}  ({len(digest_jobs)} jobs)")
    except Exception as e:
        print(f"Digest generation failed: {str(e)[:200]}")

    # Record run-history entry for the UI's Run History page. Best-effort —
    # never let history-writing failures crash the scraper.
    try:
        ended_at = datetime.now()
        scored_claude = sum(1 for j in new_jobs if j.get("scored_by") == "claude")
        scored_regex = sum(1 for j in new_jobs if j.get("scored_by") == "regex")
        title_filtered = sum(
            1 for j in new_jobs if j.get("scored_by") == "title-filter"
        )
        descriptions_fetched = sum(
            v for k, v in diagnosis_counts.items() if k.startswith("ok")
        )
        descriptions_failed = sum(
            v for k, v in diagnosis_counts.items() if not k.startswith("ok")
        )
        fit_distribution = {"good": 0, "ok": 0, "skip": 0, "unscored": 0}
        for j in new_jobs:
            f = j.get("fit")
            if f in ("good", "ok", "skip"):
                fit_distribution[f] += 1
            else:
                fit_distribution["unscored"] += 1
        entry = {
            "started_at": started_at.isoformat(timespec="seconds"),
            "ended_at": ended_at.isoformat(timespec="seconds"),
            "duration_sec": round(time.perf_counter() - started_perf, 1),
            "args": {
                "all": args.all,
                "no_enrich": args.no_enrich,
                "all_time": args.all_time,
                "pages": args.pages,
                "max_pages_used": max_pages,
            },
            "queries": per_query_stats,
            "totals": {
                "new_jobs": len(new_jobs),
                "scored_claude": scored_claude,
                "scored_regex": scored_regex,
                "title_filtered": title_filtered,
                "descriptions_fetched": descriptions_fetched,
                "descriptions_failed": descriptions_failed,
            },
            "fit_distribution": fit_distribution,
            "errors": run_errors,
        }
        _append_run_history(entry)
        print(f"Run history updated: {RUN_HISTORY_FILE}")
    except Exception as e:
        print(f"⚠ failed to write run history: {e}")
        traceback.print_exc()


if __name__ == "__main__":
    main()
