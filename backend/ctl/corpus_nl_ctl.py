#!/usr/bin/env python3
"""
Corpus natural-language filter ctl — translates a free-text query like
"security jobs from priority companies last 2 weeks" into the UI's
existing FilterState shape via an LLM.

The Vite middleware at /api/corpus/nl shells to this script; the UI
shows the user a parse preview ("Will filter by: ...") before applying.

Contract (matches other ctl scripts: read JSON stdin, emit one JSON
envelope on stdout, exit 0 success / 1 failure):

    stdin:  {"query": "<user text>"}
    stdout (ok):
        {
          "ok": true,
          "filters": {
            "categories": ["cat-id1", "cat-id2"],
            "fits": ["good", "ok"],
            "scoredBy": ["claude"],
            "sources": [],
            "priority": "yes" | "no" | "all",
            "applied": "yes" | "no" | "all",
            "scoreMin": 7,
            "scoreMax": 10,
            "dateQuick": "7d",
            "search": "kubernetes"
          },
          "parse_summary": "Categories: Security, SRE - Priority - Last 7 days"
        }
    stdout (err):
        { "ok": false, "error": "...", "raw": "<llm output>" }

The "filters" envelope only contains fields actually present after
validation — the UI's `normalizeFilters()` then maps each known field
onto its FilterState slot, dropping anything alien. Defaults are
preserved by omitting fields the LLM didn't set.

Schema-centralize (task #125): the field set, allowed enums, and
score range are no longer hardcoded here — they're loaded from
shared/filterStateSchema.json, which is dumped from the UI's Zod
source of truth. Adding/removing/renaming a static filter field is
now a one-file edit (ui/src/filterStateSchema.ts).

Provider routing — if the resolved provider declares
supports_structured_output=True (claude_sdk, openai, gemini) the
call goes through complete_structured() and the LLM is constrained
to the schema upstream. Otherwise the schema TEXT is embedded into
the prompt and the local validator enforces it. The dynamic-vocab
fields (categories, scoredBy, sources) still come from the live
corpus + config — the static schema's enums are the floor, not the
ceiling, for those.

Routes through `backend.llm.complete_structured` / fallback to
`provider.complete()` so any configured provider (claude_cli /
claude_sdk / gemini / openai / openrouter / ollama) works.
Reasoning effort is forced to "off" for this call: structured
bounded JSON output doesn't benefit from thinking and would inflate
latency 3-10x.
"""

from __future__ import annotations

import copy
import json
import sys
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent  # backend/ctl/
ROOT = HERE.parent.parent  # project root
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(ROOT))

from _common import emit as _emit  # noqa: E402
from _common import read_stdin_json  # noqa: E402

from backend.llm import PROVIDERS, get_provider  # noqa: E402
from backend.search import _parse_claude_json  # noqa: E402

CONFIG_PATH = ROOT / "config.json"
RESULTS_PATH = ROOT / "results.json"
SCHEMA_PATH = ROOT / "shared" / "filterStateSchema.json"

LLM_MAX_TOKENS = 1024

# Schema name passed to provider.complete_structured(). Used by:
#   - Anthropic tool-use: tool.name
#   - OpenAI response_format: json_schema.name
# Must match a regex like ^[a-zA-Z0-9_-]+$ for both.
SCHEMA_NAME = "FilterEnvelope"


# ---------- schema-derived validation surface ----------------------------


def _load_schema() -> dict:
    """Load the JSON Schema dumped from ui/src/filterStateSchema.ts.

    Soft-fails to an empty schema if the file is missing — callers see
    a noisy but non-crashing fallback (every LLM field gets dropped by
    validation since the schema has no properties, but the envelope
    still emits ok=true). Tests that need the schema seed it explicitly.
    """
    if not SCHEMA_PATH.exists():
        return {"type": "object", "properties": {}, "additionalProperties": False}
    try:
        payload = json.loads(SCHEMA_PATH.read_text())
    except Exception:
        return {"type": "object", "properties": {}, "additionalProperties": False}
    if isinstance(payload, dict):
        wrapped = payload.get("schema")
        if isinstance(wrapped, dict):
            return wrapped
        if payload.get("type") == "object":
            # Plain-schema fallback (no _meta header).
            return payload
    return {"type": "object", "properties": {}, "additionalProperties": False}


def _enum_set(schema: dict, field: str) -> frozenset[str]:
    """Resolve the enum allowed for `field`. Works for both scalar
    enum fields (priority/applied/dateQuick) and array-of-enum fields
    (fits/scoredBy/sources — the enum lives on items)."""
    props = (schema.get("properties") or {}).get(field) or {}
    if not isinstance(props, dict):
        return frozenset()
    if isinstance(props.get("enum"), list):
        return frozenset(str(x) for x in props["enum"] if isinstance(x, str))
    items = props.get("items")
    if isinstance(items, dict) and isinstance(items.get("enum"), list):
        return frozenset(str(x) for x in items["enum"] if isinstance(x, str))
    return frozenset()


def _int_range(schema: dict, field: str) -> tuple[int, int] | None:
    """Resolve (min, max) on an integer field. None if the field isn't
    int-typed or the bounds are missing."""
    props = (schema.get("properties") or {}).get(field) or {}
    if not isinstance(props, dict) or props.get("type") != "integer":
        return None
    mn = props.get("minimum")
    mx = props.get("maximum")
    if isinstance(mn, int) and isinstance(mx, int):
        return mn, mx
    return None


# ---------- config-derived category catalog ------------------------------


def _load_categories() -> list[dict]:
    """Return the UNION of (categories declared in config.json) and
    (distinct category ids actually present in results.json). The corpus
    can contain rows tagged with categories that are no longer in the
    active config — e.g. after a profile switch, a category rename, or
    an import. Without including those, the LLM never learns they exist
    and refuses to filter on them.

    Entries have `id` (always) and `name` (config name when known, else
    the id itself). Returns [] only when both sources are unavailable.
    """
    out: dict[str, dict] = {}  # id → {id, name}; dict so we dedupe by id.

    # Source 1: config.json categories (authoritative for names).
    if CONFIG_PATH.exists():
        try:
            cfg = json.loads(CONFIG_PATH.read_text())
            if isinstance(cfg, dict):
                cats = cfg.get("categories")
                if isinstance(cats, list):
                    for c in cats:
                        if not isinstance(c, dict):
                            continue
                        cid = str(c.get("id") or "").strip()
                        if not cid:
                            continue
                        out[cid] = {
                            "id": cid,
                            "name": str(c.get("name") or cid).strip(),
                        }
        except Exception:
            pass

    # Source 2: results.json distinct category ids (so orphan/legacy
    # categories — present in corpus but absent from current config —
    # are still visible to the LLM). Soft-fail on any read/parse error.
    if RESULTS_PATH.exists():
        try:
            rows = json.loads(RESULTS_PATH.read_text())
            if isinstance(rows, list):
                for r in rows:
                    if not isinstance(r, dict):
                        continue
                    cid = str(r.get("category_id") or "").strip()
                    if not cid or cid in out:
                        continue
                    out[cid] = {"id": cid, "name": cid}  # no name available
        except Exception:
            pass

    return list(out.values())


# ---------- LLM prompt ----------------------------------------------------


# Trimmed META prompt — the schema text + enum lists come from the
# centralized schema dump, no longer duplicated here. The mapping rules
# stay (those are interpretation hints the schema can't express in JSON
# Schema form) but the rules' enum references resolve from the live
# schema at prompt-build time.
META_PROMPT_TEMPLATE = """You translate natural-language filter requests for \
a LinkedIn job corpus into a strict JSON object.

KNOWN CATEGORIES (the user's config):
<categories>
{categories_json}
</categories>

OUTPUT SCHEMA — every field is OPTIONAL. Match this JSON Schema exactly. \
The model MUST omit fields the user didn't mention rather than emit defaults.

<schema>
{schema_json}
</schema>

MAPPING RULES (concrete):
- "last week" / "past week" / "1w" → dateQuick: "7d"
- "last 2 weeks" / "2w" / "past two weeks" → dateQuick: "7d" \
(closest supported bucket; round DOWN to 7d, not 30d, unless user explicitly says month)
- "last 3 days" / "last few days" / "1d" / "3d" → dateQuick: "24h"
- "last month" / "1m" / "30 days" → dateQuick: "30d"
- "only good fit" / "good only" → fits: ["good"]
- "good and ok" → fits: ["good", "ok"]
- "not skip" → fits: ["good", "ok", "unscored"]
- "priority companies" / "from priority companies" / "hot" → priority: "yes"
- "not applied" / "haven't applied" / "unapplied" → applied: "no"
- "already applied" / "I applied to" → applied: "yes"
- "score >= 7" / "7 or higher" / "high score" → scoreMin: 7
- "score <= 3" → scoreMax: 3
- "scored by gemini" / "scored by openai" / "scored by the LLM" → scoredBy: ["claude"] \
(the field marks any LLM-scored job, not provider-specific).
- "scored by regex" / "regex-scored" → scoredBy: ["regex"]
- "unscored" → scoredBy: ["none"]
- Category names may include synonyms — match user's words to the closest listed \
category by name. If multiple match, include all. If NONE match clearly, omit \
the `categories` field entirely (don't guess).

KEYWORD search:
- Real product/tech words ("kubernetes", "postgres", "fintech") that aren't \
filter keywords go into `search`. Don't dump the whole query into search — \
extract the noun(s) only.

CRITICAL RULES:
- DO NOT invent category ids that aren't in the list above.
- DO NOT add fields not in the schema.
- DO NOT include explanatory prose.
- Return ONLY the JSON object. No markdown fences.
- If the query is unparseable or empty, return {{}} (empty object).

User query: "{user_query}"
"""


def _build_prompt(user_query: str, categories: list[dict], schema: dict) -> str:
    return META_PROMPT_TEMPLATE.format(
        categories_json=json.dumps(categories, indent=2, ensure_ascii=False),
        schema_json=json.dumps(schema, indent=2, ensure_ascii=False),
        user_query=user_query.replace('"', "'"),
    )


def _categories_schema(schema: dict, categories: list[dict]) -> dict:
    """Return a copy of `schema` with the dynamic-vocabulary `categories`
    field constrained to the actual id catalog. The structured-output
    providers (Anthropic/OpenAI/Gemini) enforce this constraint upstream,
    which means the model can't even emit an unknown id — saving a
    validation round-trip.

    Mutates a deep copy so subsequent calls (e.g. another query under the
    same process) see the original unconstrained schema.
    """
    out = copy.deepcopy(schema)
    props = out.get("properties")
    if not isinstance(props, dict):
        return out
    cat_prop = props.get("categories")
    if not isinstance(cat_prop, dict):
        return out
    ids = sorted({c["id"] for c in categories if isinstance(c, dict) and c.get("id")})
    if not ids:
        # Empty enum is invalid in JSON Schema — leave the field as a
        # plain string[] so the model can still emit (and the validator
        # then drops everything since the dynamic vocabulary is empty).
        return out
    items = cat_prop.get("items")
    if isinstance(items, dict):
        items["enum"] = ids
    else:
        cat_prop["items"] = {"type": "string", "enum": ids}
    return out


# ---------- LLM invocation ------------------------------------------------


def _call_llm(prompt: str, schema: dict | None) -> tuple[int, str, str]:
    """Force reasoning_effort=off for this call: bounded JSON output, no
    benefit from thinking. We re-instantiate the configured provider with
    reasoning_effort="off" rather than using the cached one (which inherits
    the user's persisted reasoning level).

    If the provider supports structured output AND we have a schema in
    hand, route through complete_structured(). Otherwise fall back to
    complete(json_mode=True) — the prompt-embed path that already
    contains the schema text.

    Returns (rc, stdout, stderr). rc=0 success, rc=1 any failure."""
    base = get_provider()
    if base is None:
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

    # Re-instantiate with reasoning_effort="off". Each provider treats "off"
    # as "omit the reasoning field" — see _effort_kwarg in claude_sdk.py and
    # the equivalents in gemini.py / claude_cli.py.
    name = base.name
    if name not in PROVIDERS:
        return 1, "", f"unknown provider {name!r}"
    cls = PROVIDERS[name]
    kwargs: dict[str, Any] = {"reasoning_effort": "off"}
    model = getattr(base, "model", None)
    if model:
        kwargs["model"] = model
    try:
        provider = cls(**kwargs)
    except TypeError:
        # Provider constructor doesn't accept reasoning_effort (e.g. older
        # signature) — fall back to the cached provider. The downside is the
        # call may incur reasoning latency, but correctness is preserved.
        provider = base

    # Structured-output gate. complete_structured falls back to
    # complete(json_mode=True) at the LLMProvider base — so the
    # gating logic stays here, in the caller, where we can log it.
    use_structured = bool(getattr(provider, "supports_structured_output", False) and schema)
    try:
        if use_structured:
            text = provider.complete_structured(
                prompt,
                schema=schema,  # type: ignore[arg-type]  # narrowed by use_structured guard
                schema_name=SCHEMA_NAME,
                max_tokens=LLM_MAX_TOKENS,
            )
        else:
            text = provider.complete(prompt, max_tokens=LLM_MAX_TOKENS, json_mode=True)
    except Exception as e:
        return 1, "", f"[{provider.name}] {type(e).__name__}: {e}"
    if not text or not text.strip():
        return 1, "", f"[{provider.name}] empty response"
    return 0, text, ""


# ---------- LLM output validation ----------------------------------------


def _validate_filters(parsed: Any, schema: dict, category_ids: set[str]) -> dict:
    """Coerce the LLM's output into the FilterState shape, dropping any
    field that fails validation. Partial outputs are fine — the UI fills
    in defaults for omitted fields.

    All enum / range constraints come from the loaded JSON Schema (see
    _load_schema) so adding a new field is a one-file edit in
    ui/src/filterStateSchema.ts.

    Returns a dict with only the fields that passed validation.
    """
    out: dict[str, Any] = {}
    if not isinstance(parsed, dict):
        return out

    valid_fits = _enum_set(schema, "fits")
    valid_scored_by = _enum_set(schema, "scoredBy")
    valid_sources = _enum_set(schema, "sources")
    valid_priority = _enum_set(schema, "priority")
    valid_applied = _enum_set(schema, "applied")
    valid_date_quick = _enum_set(schema, "dateQuick")
    score_range = _int_range(schema, "scoreMin") or (1, 10)

    # categories — list of strings, each must be a known id.
    raw_cats = parsed.get("categories")
    if isinstance(raw_cats, list):
        valid: list[str] = []
        for c in raw_cats:
            if isinstance(c, str) and c.strip() in category_ids:
                valid.append(c.strip())
        if valid:
            out["categories"] = sorted(set(valid))

    def _coerce_str_array(raw: Any, allowed: frozenset[str]) -> list[str]:
        if not isinstance(raw, list) or not allowed:
            return []
        return sorted({s for s in raw if isinstance(s, str) and s in allowed})

    # Array enum fields (fits / scoredBy / sources).
    fits_out = _coerce_str_array(parsed.get("fits"), valid_fits)
    if fits_out:
        out["fits"] = fits_out
    sb_out = _coerce_str_array(parsed.get("scoredBy"), valid_scored_by)
    if sb_out:
        out["scoredBy"] = sb_out
    src_out = _coerce_str_array(parsed.get("sources"), valid_sources)
    if src_out:
        out["sources"] = src_out

    # priority — tri-state.
    raw_pri = parsed.get("priority")
    if isinstance(raw_pri, str) and raw_pri in valid_priority:
        out["priority"] = raw_pri
    elif isinstance(raw_pri, bool):
        # LLMs sometimes ignore the tri-state convention and return a bool;
        # map true→yes, false→all (rather than no, since "priority: false"
        # is rarely a useful affirmative filter).
        out["priority"] = "yes" if raw_pri else "all"

    # applied — tri-state.
    raw_app = parsed.get("applied")
    if isinstance(raw_app, str) and raw_app in valid_applied:
        out["applied"] = raw_app

    # score range — integers from schema bounds. Swap if min > max.
    lo, hi = score_range

    def _coerce_score(v: Any) -> int | None:
        if isinstance(v, bool):
            return None
        if isinstance(v, int):
            n = v
        elif isinstance(v, float):
            n = int(v)
        elif isinstance(v, str) and v.strip().isdigit():
            n = int(v.strip())
        else:
            return None
        if lo <= n <= hi:
            return n
        return None

    smin = _coerce_score(parsed.get("scoreMin"))
    smax = _coerce_score(parsed.get("scoreMax"))
    if smin is not None and smax is not None and smin > smax:
        smin, smax = smax, smin
    if smin is not None:
        out["scoreMin"] = smin
    if smax is not None:
        out["scoreMax"] = smax

    # dateQuick
    raw_dq = parsed.get("dateQuick")
    if isinstance(raw_dq, str) and raw_dq in valid_date_quick:
        out["dateQuick"] = raw_dq

    # search — free-text, trim + drop empty.
    raw_search = parsed.get("search")
    if isinstance(raw_search, str):
        s = raw_search.strip()
        if s:
            out["search"] = s

    return out


# ---------- parse_summary (server-side rendering) -------------------------


def _build_parse_summary(filters: dict, categories: list[dict]) -> str:
    """Render a human-readable one-liner describing what the validated
    filters will actually do. Generated server-side so the UI doesn't have
    to re-implement the same logic, and so the summary reflects POST-
    validation truth (not the LLM's raw output)."""
    cat_name_by_id = {c["id"]: c["name"] for c in categories}

    parts: list[str] = []

    if "categories" in filters:
        names = [cat_name_by_id.get(cid, cid) for cid in filters["categories"]]
        parts.append(f"Categories: {', '.join(names)}")

    if "fits" in filters:
        parts.append(f"Fit: {', '.join(filters['fits'])}")

    if filters.get("priority") == "yes":
        parts.append("Priority companies only")
    elif filters.get("priority") == "no":
        parts.append("Excluding priority")

    if filters.get("applied") == "yes":
        parts.append("Applied only")
    elif filters.get("applied") == "no":
        parts.append("Not applied")

    dq = filters.get("dateQuick")
    if dq == "24h":
        parts.append("Last 24 hours")
    elif dq == "7d":
        parts.append("Last 7 days")
    elif dq == "30d":
        parts.append("Last 30 days")

    smin = filters.get("scoreMin")
    smax = filters.get("scoreMax")
    if smin is not None and smax is not None and (smin != 1 or smax != 10):
        parts.append(f"Score {smin}-{smax}")
    elif smin is not None and smin != 1:
        parts.append(f"Score >= {smin}")
    elif smax is not None and smax != 10:
        parts.append(f"Score <= {smax}")

    if "scoredBy" in filters:
        parts.append(f"Scored by: {', '.join(filters['scoredBy'])}")

    if "sources" in filters:
        parts.append(f"Source: {', '.join(filters['sources'])}")

    if "search" in filters:
        parts.append(f'Search: "{filters["search"]}"')

    if not parts:
        return "No filters detected"

    return " - ".join(parts)


# ---------- main ----------------------------------------------------------


def main() -> None:
    try:
        payload = read_stdin_json()
    except Exception as e:
        _emit({"ok": False, "error": f"bad stdin: {e}"}, 1)
        return  # for type-checker; _emit calls sys.exit

    query = payload.get("query")
    if not isinstance(query, str) or not query.strip():
        _emit({"ok": False, "error": "query must be a non-empty string"}, 1)
        return

    query = query.strip()
    # Reject suspiciously long queries — the UI input has no max-length but a
    # 5000-char paste of garbage isn't a NL filter request. Keep this loose;
    # real filter queries are <200 chars.
    if len(query) > 2000:
        _emit({"ok": False, "error": "query too long (max 2000 chars)"}, 1)
        return

    schema = _load_schema()
    categories = _load_categories()
    # The schema we send to the LLM has the dynamic `categories` vocab
    # baked in. The validation schema below stays unconstrained — the
    # validator uses `category_ids` directly to enforce membership, and
    # we want it to keep working even when the structured-output API
    # didn't enforce the enum (older models / non-strict response_format).
    prompt_schema = _categories_schema(schema, categories)
    prompt = _build_prompt(query, categories, prompt_schema)

    rc, stdout, stderr = _call_llm(prompt, prompt_schema)
    raw = (stdout or "").strip()

    if rc != 0:
        _emit(
            {
                "ok": False,
                "error": f"llm error: {(stderr or '').strip()[:400]}",
                "raw": raw,
            },
            1,
        )
        return

    parsed = _parse_claude_json(raw)
    if not isinstance(parsed, dict):
        _emit(
            {
                "ok": False,
                "error": "could not parse LLM output as a JSON object",
                "raw": raw,
            },
            1,
        )
        return

    category_ids = {c["id"] for c in categories}
    filters = _validate_filters(parsed, schema, category_ids)
    parse_summary = _build_parse_summary(filters, categories)

    _emit(
        {
            "ok": True,
            "filters": filters,
            "parse_summary": parse_summary,
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
