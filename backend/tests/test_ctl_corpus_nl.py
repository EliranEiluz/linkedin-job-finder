"""Tests for backend/ctl/corpus_nl_ctl.py.

The script translates a natural-language query into the UI's FilterState
shape via an LLM. We mock the LLM (via the provider abstraction) so no
real API call ever fires. The validation layer is what's actually
load-bearing — the tests exercise its drop-invalid-fields behavior
through subprocess invocations to match the Vite middleware path.

Test plan (mirrors the spec's ctl section):
  1. Happy path: LLM returns valid JSON for "security jobs last week"
     -> ctl emits parsed filters + a non-empty parse_summary.
  2. LLM returns invalid (truncated) JSON -> ctl returns ok=false.
  3. LLM hallucinates a category not in config -> that category is
     dropped from output, valid ones kept.
  4. Empty query -> ctl returns a "couldn't parse" error before calling
     the LLM at all.
  5. LLM provider not configured -> ctl returns auth error in the envelope.
"""

from __future__ import annotations

import json
from pathlib import Path

# Each test seeds a single-file mock LLM module that the ctl will pick
# up via PYTHONPATH (the run_ctl fixture already sets PYTHONPATH=tmp_path
# so the fake backend.llm package takes precedence over the real one).
# We rewrite backend/llm/__init__.py in the materialized fake-repo to
# return a deterministic provider whose .complete() emits canned JSON.

_FAKE_LLM_TEMPLATE = """
from __future__ import annotations

PROVIDERS = {{"mock": type("MockProvider", (), {{}})}}


class _MockProvider:
    name = "mock"
    model = "mock-model"

    def __init__(self, *args, **kwargs):
        pass

    def complete(self, prompt, *, system=None, max_tokens=4096, json_mode=False):
        return {canned!r}


def get_provider(force=False):
    {provider_body}


def complete(prompt, *, system=None, max_tokens=4096, json_mode=False):
    p = get_provider()
    if p is None:
        return None
    return p.complete(prompt, system=system, max_tokens=max_tokens, json_mode=json_mode)


# Make the constructor reachable via the PROVIDERS map the ctl reads.
PROVIDERS["mock"] = _MockProvider
"""


def _write_fake_llm(tmp_path: Path, canned: str, provider_available: bool = True) -> None:
    """Replace backend/llm/__init__.py in the materialized fake-repo with
    a stub that returns the given canned string from .complete()."""
    llm_dir = tmp_path / "backend" / "llm"
    llm_dir.mkdir(parents=True, exist_ok=True)
    body = "return _MockProvider()" if provider_available else "return None"
    (llm_dir / "__init__.py").write_text(
        _FAKE_LLM_TEMPLATE.format(canned=canned, provider_body=body)
    )


def _write_config(tmp_path: Path, categories: list[dict]) -> None:
    (tmp_path / "config.json").write_text(json.dumps({"categories": categories}))


def test_happy_path_security_jobs_last_week(run_ctl, tmp_path: Path) -> None:
    """LLM produces valid filter JSON -> ctl emits ok=true with the
    parsed filters and a parse_summary describing them."""
    _write_config(
        tmp_path,
        [
            {"id": "security", "name": "Security"},
            {"id": "sre", "name": "SRE"},
            {"id": "backend", "name": "Backend"},
        ],
    )
    canned = json.dumps(
        {
            "categories": ["security"],
            "dateQuick": "7d",
        }
    )
    _write_fake_llm(tmp_path, canned)

    rc, out, _err = run_ctl(
        "corpus_nl_ctl.py",
        stdin_payload={"query": "security jobs last week"},
    )
    assert rc == 0, out
    assert out["ok"] is True
    assert out["filters"]["categories"] == ["security"]
    assert out["filters"]["dateQuick"] == "7d"
    # Server-side summary mentions the category NAME (not id) and the bucket.
    assert "Security" in out["parse_summary"]
    assert "Last 7 days" in out["parse_summary"]


def test_invalid_json_returns_error_envelope(run_ctl, tmp_path: Path) -> None:
    """LLM truncates its output -> _parse_claude_json returns None ->
    ctl emits ok=false with rc=1 and a 'could not parse' error."""
    _write_config(tmp_path, [{"id": "security", "name": "Security"}])
    # Truncated / non-JSON output. _parse_claude_json tolerates code fences
    # and partial JSON, so we use a deliberately broken object that has no
    # balanced braces.
    _write_fake_llm(tmp_path, "not even close to JSON {unterminated")

    rc, out, _err = run_ctl(
        "corpus_nl_ctl.py",
        stdin_payload={"query": "something"},
    )
    assert rc == 1, out
    assert out["ok"] is False
    assert "parse" in out["error"].lower() or "json" in out["error"].lower()
    assert "raw" in out


def test_hallucinated_category_is_dropped(run_ctl, tmp_path: Path) -> None:
    """LLM returns a category id not in config -> it's dropped silently;
    valid categories are kept. Partial parse, not a hard failure."""
    _write_config(
        tmp_path,
        [
            {"id": "security", "name": "Security"},
            {"id": "sre", "name": "SRE"},
        ],
    )
    canned = json.dumps(
        {
            "categories": ["security", "machine-learning", "sre"],
            "priority": "yes",
        }
    )
    _write_fake_llm(tmp_path, canned)

    rc, out, _err = run_ctl(
        "corpus_nl_ctl.py",
        stdin_payload={"query": "security sre priority"},
    )
    assert rc == 0, out
    assert out["ok"] is True
    # Only the two valid ids survived. Order is deterministic (sorted).
    assert out["filters"]["categories"] == ["security", "sre"]
    assert out["filters"]["priority"] == "yes"


def test_empty_query_errors_before_calling_llm(run_ctl, tmp_path: Path) -> None:
    """Empty or whitespace-only query -> error envelope before LLM call.
    Also verifies that even with a working LLM stub, the validation
    short-circuit fires first."""
    _write_config(tmp_path, [{"id": "security", "name": "Security"}])
    _write_fake_llm(tmp_path, "{}")

    rc, out, _err = run_ctl(
        "corpus_nl_ctl.py",
        stdin_payload={"query": "   "},
    )
    assert rc == 1, out
    assert out["ok"] is False
    assert "non-empty" in out["error"]


def test_provider_not_configured_returns_auth_error(run_ctl, tmp_path: Path) -> None:
    """When get_provider() returns None, the ctl surfaces a structured
    error pointing the user at credentials setup."""
    _write_config(tmp_path, [{"id": "security", "name": "Security"}])
    _write_fake_llm(tmp_path, "{}", provider_available=False)

    rc, out, _err = run_ctl(
        "corpus_nl_ctl.py",
        stdin_payload={"query": "anything"},
    )
    assert rc == 1, out
    assert out["ok"] is False
    assert "llm error" in out["error"].lower()
    # Body must mention at least one of the credential env vars / install paths.
    assert any(
        token in out["error"]
        for token in (
            "ANTHROPIC_API_KEY",
            "GEMINI_API_KEY",
            "OPENROUTER_API_KEY",
            "claude",
            "ollama",
        )
    )


def test_score_range_swap_when_min_exceeds_max(run_ctl, tmp_path: Path) -> None:
    """LLM returns scoreMin=9, scoreMax=3 -> ctl swaps so the range is
    coherent for the UI's sliders."""
    _write_config(tmp_path, [{"id": "security", "name": "Security"}])
    canned = json.dumps({"scoreMin": 9, "scoreMax": 3})
    _write_fake_llm(tmp_path, canned)

    rc, out, _err = run_ctl(
        "corpus_nl_ctl.py",
        stdin_payload={"query": "score range"},
    )
    assert rc == 0, out
    assert out["filters"]["scoreMin"] == 3
    assert out["filters"]["scoreMax"] == 9


def test_invalid_enum_values_dropped_not_failed(run_ctl, tmp_path: Path) -> None:
    """LLM returns dateQuick='2w' (not in our enum) and fits=['great']
    (not in our enum) -> both dropped, other valid fields preserved."""
    _write_config(tmp_path, [{"id": "security", "name": "Security"}])
    canned = json.dumps(
        {
            "categories": ["security"],
            "fits": ["great", "good"],
            "dateQuick": "2w",
            "applied": "no",
        }
    )
    _write_fake_llm(tmp_path, canned)

    rc, out, _err = run_ctl(
        "corpus_nl_ctl.py",
        stdin_payload={"query": "mixed valid+invalid"},
    )
    assert rc == 0, out
    # Valid field kept.
    assert out["filters"]["categories"] == ["security"]
    # fits filtered down to the valid subset.
    assert out["filters"]["fits"] == ["good"]
    # Invalid dateQuick dropped entirely (not coerced).
    assert "dateQuick" not in out["filters"]
    # Other valid fields preserved.
    assert out["filters"]["applied"] == "no"
