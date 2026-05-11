"""Pytest tests for backend/llm/* — provider abstraction + each implementation.

Strategy:
- `parse_json_response` / `_shared.py` get exhaustive coverage (it's the only
  pure-function component every provider depends on, so it earns the surface).
- Each provider's `score_batch` and `test()` get a happy path (mocked HTTP /
  subprocess), a credentials-missing path, and a malformed-response path.
- Auto-resolution order from `__init__.py` is asserted via the cache-clear +
  patched `_quick_available` strategy.

We use the `responses` library to stub `requests.post` / `requests.get` for
HTTP-based providers (gemini, openai, openrouter, ollama) and direct mocking
for subprocess (claude_cli) and the anthropic SDK (claude_sdk).
"""

from __future__ import annotations

import json
import os
from typing import Any

import pytest
import responses

from backend import llm as llm_pkg
from backend.llm import _shared
from backend.llm.claude_cli import ClaudeCLIProvider
from backend.llm.claude_sdk import ClaudeSDKProvider
from backend.llm.gemini import GeminiProvider
from backend.llm.ollama import OllamaProvider
from backend.llm.openai import OpenAIProvider
from backend.llm.openrouter import OpenRouterProvider

# ---------------------------------------------------------------------------
# parse_json_response — same shape coverage as search._parse_claude_json
# (both implementations should behave identically; they're physically
# duplicated to dodge a circular import).
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ('[{"id": "1"}]', [{"id": "1"}]),
        ('{"foo": "bar"}', {"foo": "bar"}),
        ('```json\n[{"id":"1"}]\n```', [{"id": "1"}]),
        # Object-prefixed input must NOT pick the inner array.
        ('{"jobs": [{"id":"1"}]}', {"jobs": [{"id": "1"}]}),
        # Strings containing brackets
        ('{"k": "[ ]"}', {"k": "[ ]"}),
        # Escaped quotes inside strings
        (r'{"k": "she said \"hi\""}', {"k": 'she said "hi"'}),
        ("", None),
        ("nothing", None),
    ],
)
def test_parse_json_response(raw: str, expected: object) -> None:
    assert _shared.parse_json_response(raw) == expected


def test_test_constants_present() -> None:
    """test() methods all share TEST_BATCH + TEST_CV — guard against
    accidental rename/removal."""
    assert _shared.TEST_BATCH and isinstance(_shared.TEST_BATCH, list)
    assert _shared.TEST_BATCH[0]["id"]  # has an id
    assert _shared.TEST_CV  # non-empty


# ---------------------------------------------------------------------------
# Auto-resolution order. Must consult AUTO_ORDER in sequence and pick the
# first provider whose `_quick_available` returns True.
# ---------------------------------------------------------------------------


def test_get_provider_auto_picks_first_available(monkeypatch: pytest.MonkeyPatch) -> None:
    """Patch _quick_available so only `gemini` is "available". get_provider
    in auto-mode should return a GeminiProvider, even if claude_cli/claude_sdk
    appear earlier in AUTO_ORDER."""
    # Reset the module-level cache so the test starts clean.
    monkeypatch.setattr(llm_pkg, "_cached", None)
    # Force auto mode — empty config.
    monkeypatch.setattr(llm_pkg, "_read_cfg", lambda: {})
    monkeypatch.setattr(llm_pkg, "_quick_available", lambda p: p.name == "gemini")
    p = llm_pkg.get_provider(force=True)
    assert p is not None
    assert p.name == "gemini"


def test_get_provider_auto_returns_none_when_nothing_available(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(llm_pkg, "_cached", None)
    monkeypatch.setattr(llm_pkg, "_read_cfg", lambda: {})
    monkeypatch.setattr(llm_pkg, "_quick_available", lambda _p: False)
    assert llm_pkg.get_provider(force=True) is None


def test_get_provider_explicit_name_bypasses_auto(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(llm_pkg, "_cached", None)
    monkeypatch.setattr(llm_pkg, "_read_cfg", lambda: {"name": "openrouter"})
    p = llm_pkg.get_provider(force=True)
    assert p is not None
    assert p.name == "openrouter"


def test_get_provider_unknown_name_falls_back_to_auto(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture
) -> None:
    monkeypatch.setattr(llm_pkg, "_cached", None)
    monkeypatch.setattr(llm_pkg, "_read_cfg", lambda: {"name": "fake"})
    monkeypatch.setattr(llm_pkg, "_quick_available", lambda p: p.name == "claude_cli")
    p = llm_pkg.get_provider(force=True)
    assert p is not None
    assert p.name == "claude_cli"
    assert "unknown llm_provider.name" in capsys.readouterr().out


def test_get_provider_caches(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(llm_pkg, "_cached", None)
    monkeypatch.setattr(llm_pkg, "_read_cfg", lambda: {"name": "ollama"})
    p1 = llm_pkg.get_provider(force=True)
    p2 = llm_pkg.get_provider(force=False)
    assert p1 is p2  # cached
    p3 = llm_pkg.get_provider(force=True)
    assert p3 is not p1  # bypass cache


# ---------------------------------------------------------------------------
# ClaudeCLIProvider — subprocess `claude -p ...`. We mock subprocess.run.
# ---------------------------------------------------------------------------


def test_claude_cli_score_batch_no_cli_returns_none(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("backend.llm.claude_cli.shutil.which", lambda _: None)
    p = ClaudeCLIProvider()
    assert p.score_batch("cv", [{"id": "1", "_desc": "x"}]) is None


def test_claude_cli_score_batch_happy_path(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("backend.llm.claude_cli.shutil.which", lambda _: "/usr/bin/claude")

    class _FakeProc:
        returncode = 0
        stdout = '[{"id": "1", "fit": "good", "score": 9}]'
        stderr = ""

    monkeypatch.setattr(
        "backend.llm.claude_cli.subprocess.run",
        lambda *_a, **_kw: _FakeProc(),
    )
    # _build_batch_prompt needs the search module callable — it is, via the
    # llm module's lazy import inside _prompt(). No further patching needed.
    p = ClaudeCLIProvider()
    out = p.score_batch("cv text", [{"id": "1", "title": "Eng", "company": "X"}])
    assert out == [{"id": "1", "fit": "good", "score": 9}]


def test_claude_cli_score_batch_nonzero_rc_returns_none(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture
) -> None:
    monkeypatch.setattr("backend.llm.claude_cli.shutil.which", lambda _: "/usr/bin/claude")

    class _FakeProc:
        returncode = 1
        stdout = ""
        stderr = "auth required"

    monkeypatch.setattr(
        "backend.llm.claude_cli.subprocess.run",
        lambda *_a, **_kw: _FakeProc(),
    )
    p = ClaudeCLIProvider()
    assert p.score_batch("cv", [{"id": "1"}]) is None
    assert "auth required" in capsys.readouterr().out


def test_claude_cli_score_batch_non_array_returns_none(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("backend.llm.claude_cli.shutil.which", lambda _: "/usr/bin/claude")

    class _FakeProc:
        returncode = 0
        stdout = '{"single": "object"}'  # not an array
        stderr = ""

    monkeypatch.setattr(
        "backend.llm.claude_cli.subprocess.run",
        lambda *_a, **_kw: _FakeProc(),
    )
    p = ClaudeCLIProvider()
    assert p.score_batch("cv", [{"id": "1"}]) is None


def test_claude_cli_test_no_cli(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("backend.llm.claude_cli.shutil.which", lambda _: None)
    ok, msg = ClaudeCLIProvider().test()
    assert not ok
    assert "claude` CLI not on PATH" in msg


# ---------------------------------------------------------------------------
# ClaudeSDKProvider — anthropic SDK. We mock the client.
# ---------------------------------------------------------------------------


def test_claude_sdk_score_batch_no_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    p = ClaudeSDKProvider()
    assert p.score_batch("cv", [{"id": "1"}]) is None


def test_claude_sdk_score_batch_happy_path(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-fake")

    class _Block:
        type = "text"
        text = '[{"id": "1", "fit": "good", "score": 9}]'

    class _Msg:
        content = [_Block()]

    class _Messages:
        @staticmethod
        def create(**_kw: Any) -> _Msg:
            return _Msg()

    class _Client:
        messages = _Messages()

    p = ClaudeSDKProvider()
    monkeypatch.setattr(p, "_ensure_client", lambda: _Client())
    out = p.score_batch("cv", [{"id": "1", "title": "X", "company": "Y"}])
    assert out == [{"id": "1", "fit": "good", "score": 9}]


def test_claude_sdk_score_batch_sdk_error_returns_none(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-fake")

    class _Messages:
        @staticmethod
        def create(**_kw: Any) -> Any:
            raise RuntimeError("rate limited")

    class _Client:
        messages = _Messages()

    p = ClaudeSDKProvider()
    monkeypatch.setattr(p, "_ensure_client", lambda: _Client())
    assert p.score_batch("cv", [{"id": "1"}]) is None


# ---------------------------------------------------------------------------
# GeminiProvider — HTTP via responses mock.
# ---------------------------------------------------------------------------


@responses.activate
def test_gemini_score_batch_happy_path(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", "test-gemini-key")
    responses.add(
        responses.POST,
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
        json={
            "candidates": [
                {
                    "content": {
                        "parts": [
                            {"text": '[{"id":"1","fit":"good","score":9}]'},
                        ]
                    }
                }
            ]
        },
        status=200,
    )
    out = GeminiProvider().score_batch("cv", [{"id": "1", "title": "X", "company": "Y"}])
    assert out == [{"id": "1", "fit": "good", "score": 9}]


@responses.activate
def test_gemini_score_batch_http_error_returns_none(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", "test-gemini-key")
    responses.add(
        responses.POST,
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
        json={"error": "quota exceeded"},
        status=429,
    )
    assert GeminiProvider().score_batch("cv", [{"id": "1"}]) is None


def test_gemini_test_no_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    ok, msg = GeminiProvider().test()
    assert not ok
    assert "GEMINI_API_KEY" in msg


@responses.activate
def test_gemini_complete_returns_text(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    responses.add(
        responses.POST,
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
        json={"candidates": [{"content": {"parts": [{"text": "hello"}]}}]},
        status=200,
    )
    assert GeminiProvider().complete("prompt") == "hello"


# ---------------------------------------------------------------------------
# OpenAIProvider
# ---------------------------------------------------------------------------


def test_openai_score_batch_no_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    assert OpenAIProvider().score_batch("cv", [{"id": "1"}]) is None


@responses.activate
def test_openai_score_batch_happy_path(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    responses.add(
        responses.POST,
        "https://api.openai.com/v1/chat/completions",
        json={"choices": [{"message": {"content": '[{"id":"1","fit":"ok","score":5}]'}}]},
        status=200,
    )
    out = OpenAIProvider().score_batch("cv", [{"id": "1", "title": "X", "company": "Y"}])
    assert out == [{"id": "1", "fit": "ok", "score": 5}]


@responses.activate
def test_openai_score_batch_no_choices(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    responses.add(
        responses.POST,
        "https://api.openai.com/v1/chat/completions",
        json={"choices": []},
        status=200,
    )
    assert OpenAIProvider().score_batch("cv", [{"id": "1"}]) is None


def test_openai_test_no_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    ok, msg = OpenAIProvider().test()
    assert not ok
    assert "OPENAI_API_KEY" in msg


# ---------------------------------------------------------------------------
# OpenRouterProvider
# ---------------------------------------------------------------------------


def test_openrouter_score_batch_no_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    assert OpenRouterProvider().score_batch("cv", [{"id": "1"}]) is None


@responses.activate
def test_openrouter_score_batch_happy_path(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-test")
    responses.add(
        responses.POST,
        "https://openrouter.ai/api/v1/chat/completions",
        json={"choices": [{"message": {"content": '[{"id":"1","fit":"good","score":8}]'}}]},
        status=200,
    )
    out = OpenRouterProvider().score_batch("cv", [{"id": "1", "title": "X", "company": "Y"}])
    assert out == [{"id": "1", "fit": "good", "score": 8}]


# ---------------------------------------------------------------------------
# OllamaProvider
# ---------------------------------------------------------------------------


@responses.activate
def test_ollama_score_batch_happy_path() -> None:
    responses.add(
        responses.POST,
        "http://localhost:11434/api/chat",
        json={"message": {"content": '[{"id":"1","fit":"ok","score":5}]'}},
        status=200,
    )
    out = OllamaProvider().score_batch("cv", [{"id": "1", "title": "X", "company": "Y"}])
    assert out == [{"id": "1", "fit": "ok", "score": 5}]


@responses.activate
def test_ollama_test_model_not_pulled() -> None:
    responses.add(
        responses.GET,
        "http://localhost:11434/api/tags",
        json={"models": [{"name": "other-model:latest"}]},
        status=200,
    )
    ok, msg = OllamaProvider(model="missing-model:latest").test()
    assert not ok
    assert "not pulled" in msg


@responses.activate
def test_ollama_test_server_unreachable() -> None:
    """No mock for /api/tags = ConnectionError. test() reports the unreachable case."""
    # responses with no registered URL raises ConnectionError on .get()
    ok, msg = OllamaProvider().test()
    assert not ok
    assert "ollama" in msg.lower()


# ---------------------------------------------------------------------------
# score_batch / complete top-level wrappers — should delegate to the
# resolved provider and return None when no provider is available.
# ---------------------------------------------------------------------------


def test_top_level_score_batch_returns_none_when_no_provider(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(llm_pkg, "get_provider", lambda **_: None)
    assert llm_pkg.score_batch("cv", [{"id": "1"}]) is None


def test_top_level_complete_returns_none_when_no_provider(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(llm_pkg, "get_provider", lambda **_: None)
    assert llm_pkg.complete("prompt") is None


def test_top_level_score_batch_delegates(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict = {}

    class _P:
        name = "fake"

        def score_batch(self, cv: str, batch: list[dict]) -> list:
            captured["cv"] = cv
            captured["batch"] = batch
            return [{"id": "1"}]

    monkeypatch.setattr(llm_pkg, "get_provider", lambda **_: _P())
    out = llm_pkg.score_batch("my cv", [{"id": "1"}])
    assert out == [{"id": "1"}]
    assert captured["cv"] == "my cv"


# ---------------------------------------------------------------------------
# test_provider() top-level — auto vs named.
# ---------------------------------------------------------------------------


def test_test_provider_auto_no_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(llm_pkg, "get_provider", lambda **_: None)
    ok, msg = llm_pkg.test_provider("auto")
    assert not ok
    assert "no provider available" in msg


def test_test_provider_unknown_name() -> None:
    ok, msg = llm_pkg.test_provider("definitely-not-a-provider")
    assert not ok
    assert "unknown provider" in msg


def test_test_provider_named_delegates(monkeypatch: pytest.MonkeyPatch) -> None:
    """Naming a known provider runs that provider's `.test()` method (we
    mock it so the test stays offline)."""
    monkeypatch.setenv("GEMINI_API_KEY", "k")

    captured: dict = {"hit": False}

    def _fake_test(self: Any) -> tuple[bool, str]:
        captured["hit"] = True
        return True, "fake ok"

    monkeypatch.setattr(GeminiProvider, "test", _fake_test)
    ok, msg = llm_pkg.test_provider("gemini")
    assert ok
    assert msg == "fake ok"
    assert captured["hit"]


# ---------------------------------------------------------------------------
# _quick_available — env-var / shutil.which / requests checks per provider.
# ---------------------------------------------------------------------------


def test_quick_available_claude_cli(monkeypatch: pytest.MonkeyPatch) -> None:
    # _quick_available imports shutil locally, so patch the real shutil module.
    import shutil

    monkeypatch.setattr(shutil, "which", lambda _: "/usr/bin/claude")
    assert llm_pkg._quick_available(ClaudeCLIProvider()) is True
    monkeypatch.setattr(shutil, "which", lambda _: None)
    assert llm_pkg._quick_available(ClaudeCLIProvider()) is False


@pytest.mark.parametrize(
    ("provider_factory", "env_var"),
    [
        (lambda: ClaudeSDKProvider(), "ANTHROPIC_API_KEY"),
        (lambda: OpenAIProvider(), "OPENAI_API_KEY"),
        (lambda: OpenRouterProvider(), "OPENROUTER_API_KEY"),
    ],
)
def test_quick_available_env_keyed(
    provider_factory: Any,
    env_var: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv(env_var, raising=False)
    assert llm_pkg._quick_available(provider_factory()) is False
    monkeypatch.setenv(env_var, "x")
    assert llm_pkg._quick_available(provider_factory()) is True


def test_quick_available_gemini_either_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    assert llm_pkg._quick_available(GeminiProvider()) is False
    monkeypatch.setenv("GOOGLE_API_KEY", "x")
    assert llm_pkg._quick_available(GeminiProvider()) is True


# ---------------------------------------------------------------------------
# _read_cfg — pulls llm_provider out of search._ACTIVE_CONFIG.
# ---------------------------------------------------------------------------


def test_read_cfg_pulls_from_search_active_config(monkeypatch: pytest.MonkeyPatch) -> None:
    # llm/__init__.py reads from `backend.search` (the package-qualified
    # path). The bare `import search` and `import backend.search` produce
    # different module objects under explicit_package_bases — patch the
    # one llm._read_cfg actually consults.
    from backend import search as bsearch

    monkeypatch.setattr(bsearch, "_ACTIVE_CONFIG", {"llm_provider": {"name": "gemini"}})
    assert llm_pkg._read_cfg() == {"name": "gemini"}


def test_read_cfg_returns_empty_for_missing_key(monkeypatch: pytest.MonkeyPatch) -> None:
    from backend import search as bsearch

    monkeypatch.setattr(bsearch, "_ACTIVE_CONFIG", {})
    assert llm_pkg._read_cfg() == {}


# ---------------------------------------------------------------------------
# Task #114 — list_models() per provider. Each test mocks the underlying
# transport (HTTP / SDK / subprocess) so no real network call happens.
# ---------------------------------------------------------------------------


def test_claude_sdk_list_models_maps_capabilities(monkeypatch: pytest.MonkeyPatch) -> None:
    """Anthropic SDK exposes a rich `capabilities.effort` block on each
    model. We map every supported level into ReasoningCapability.levels."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k")

    class _LvlFlag:
        def __init__(self, supported: bool) -> None:
            self.supported = supported

    class _Effort:
        # Anthropic surfaces every level explicitly. Only the supported=True
        # ones land in our ReasoningCapability.levels tuple.
        low = _LvlFlag(True)
        medium = _LvlFlag(True)
        high = _LvlFlag(True)
        max = _LvlFlag(False)
        xhigh = _LvlFlag(False)

    class _Caps:
        effort = _Effort()

    class _Model:
        id = "claude-opus-4-7"
        display_name = "Claude Opus 4.7"
        max_input_tokens = 200_000
        max_output_tokens = 8_192
        capabilities = _Caps()

    class _Page:
        data = [_Model()]

    class _Models:
        @staticmethod
        def list(**_kw: Any) -> _Page:
            return _Page()

    class _Client:
        models = _Models()
        messages: Any = None

    p = ClaudeSDKProvider()
    monkeypatch.setattr(p, "_ensure_client", lambda: _Client())
    out = p.list_models()
    assert len(out) == 1
    m = out[0]
    assert m.id == "claude-opus-4-7"
    assert m.max_input_tokens == 200_000
    assert m.reasoning.supported is True
    assert m.reasoning.shape == "levels"
    assert m.reasoning.levels == ("low", "medium", "high")


def test_claude_sdk_list_models_no_key_returns_empty(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert ClaudeSDKProvider().list_models() == []


@responses.activate
def test_openai_list_models_uses_capability_map(monkeypatch: pytest.MonkeyPatch) -> None:
    """OpenAI's `/v1/models` response is sparse — capability lookup comes
    from `_openai_capabilities.capability_for`. Verify gpt-5 + gpt-4o get
    different shapes (levels vs none)."""
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    responses.add(
        responses.GET,
        "https://api.openai.com/v1/models",
        json={
            "data": [
                {"id": "gpt-5", "owned_by": "openai"},
                {"id": "gpt-4o-mini", "owned_by": "openai"},
                {"id": "o3-mini", "owned_by": "openai"},
            ]
        },
        status=200,
    )
    models = OpenAIProvider().list_models()
    by_id = {m.id: m for m in models}
    assert by_id["gpt-5"].reasoning.shape == "levels"
    assert by_id["gpt-5"].reasoning.levels == ("low", "medium", "high", "xhigh")
    assert by_id["gpt-4o-mini"].reasoning.shape == "none"
    assert by_id["o3-mini"].reasoning.shape == "levels"


def test_openai_list_models_no_key_returns_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    assert OpenAIProvider().list_models() == []


@responses.activate
def test_gemini_list_models_per_family_shape(monkeypatch: pytest.MonkeyPatch) -> None:
    """gemini-3 → levels, gemini-2.5-pro → budget(128..32768),
    gemini-2.5-flash → budget(0..24576), others → none."""
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    responses.add(
        responses.GET,
        "https://generativelanguage.googleapis.com/v1beta/models",
        json={
            "models": [
                {
                    "name": "models/gemini-3-pro",
                    "displayName": "Gemini 3 Pro",
                    "inputTokenLimit": 2_000_000,
                    "outputTokenLimit": 32_000,
                    "supportedGenerationMethods": ["generateContent"],
                },
                {
                    "name": "models/gemini-2.5-pro",
                    "supportedGenerationMethods": ["generateContent"],
                },
                {
                    "name": "models/gemini-2.5-flash",
                    "supportedGenerationMethods": ["generateContent"],
                },
                {
                    "name": "models/gemini-1.5-flash",
                    "supportedGenerationMethods": ["generateContent"],
                },
                # Filtered out — doesn't support generateContent.
                {
                    "name": "models/embedding-001",
                    "supportedGenerationMethods": ["embedContent"],
                },
            ]
        },
        status=200,
    )
    out = GeminiProvider().list_models()
    by_id = {m.id: m for m in out}
    assert "embedding-001" not in by_id
    assert by_id["gemini-3-pro"].reasoning.shape == "levels"
    assert by_id["gemini-3-pro"].reasoning.levels == (
        "minimal",
        "low",
        "medium",
        "high",
    )
    assert by_id["gemini-2.5-pro"].reasoning.shape == "budget"
    assert by_id["gemini-2.5-pro"].reasoning.budget_range == (128, 32_768)
    assert by_id["gemini-2.5-flash"].reasoning.shape == "budget"
    assert by_id["gemini-2.5-flash"].reasoning.budget_range == (0, 24_576)
    assert by_id["gemini-1.5-flash"].reasoning.shape == "none"


@responses.activate
def test_openrouter_list_models_no_auth_needed() -> None:
    """The OpenRouter catalog endpoint is public — no Authorization header
    sent on the GET."""
    responses.add(
        responses.GET,
        "https://openrouter.ai/api/v1/models",
        json={
            "data": [
                {
                    "id": "anthropic/claude-sonnet-4-6",
                    "name": "Claude Sonnet 4.6",
                    "context_length": 200_000,
                    "top_provider": {"max_completion_tokens": 8192},
                    "supported_parameters": ["reasoning", "tools"],
                },
                {
                    "id": "meta-llama/llama-3.3-70b-instruct:free",
                    "name": "Llama 3.3 70B (free)",
                    "context_length": 128_000,
                    "supported_parameters": ["tools"],  # no reasoning
                },
            ]
        },
        status=200,
    )
    out = OpenRouterProvider().list_models()
    by_id = {m.id: m for m in out}
    claude = by_id["anthropic/claude-sonnet-4-6"]
    assert claude.reasoning.supported is True
    assert claude.reasoning.shape == "levels"
    assert claude.reasoning.levels == ("low", "medium", "high")
    assert claude.max_input_tokens == 200_000
    llama = by_id["meta-llama/llama-3.3-70b-instruct:free"]
    assert llama.reasoning.supported is False
    assert llama.reasoning.shape == "none"


@responses.activate
def test_ollama_list_models_detects_thinking_family() -> None:
    """Known thinking families (deepseek-r1, qwen3, qwq) declare the
    boolean shape; other locally-pulled models stay shape=none."""
    responses.add(
        responses.GET,
        "http://localhost:11434/api/tags",
        json={
            "models": [
                {"name": "deepseek-r1:14b"},
                {"name": "qwen3:32b"},
                {"name": "llama3.2:8b"},
            ]
        },
        status=200,
    )
    out = OllamaProvider().list_models()
    by_id = {m.id: m for m in out}
    assert by_id["deepseek-r1:14b"].reasoning.shape == "boolean"
    assert by_id["deepseek-r1:14b"].reasoning.supported is True
    assert by_id["qwen3:32b"].reasoning.shape == "boolean"
    assert by_id["llama3.2:8b"].reasoning.shape == "none"


def test_claude_cli_list_models_is_hardcoded() -> None:
    """CLI has no models endpoint — we return a fixed list. Every entry
    declares the full effort spectrum."""
    out = ClaudeCLIProvider().list_models()
    ids = [m.id for m in out]
    # Verify the four spec'd models are present.
    assert "opus-4-7" in ids
    assert "opus-4-6" in ids
    assert "sonnet-4-6" in ids
    assert "haiku-4-5" in ids
    # All entries declare the canonical effort levels.
    for m in out:
        assert m.reasoning.supported is True
        assert m.reasoning.shape == "levels"
        assert m.reasoning.levels == ("low", "medium", "high", "max", "xhigh")


# ---------------------------------------------------------------------------
# Top-level llm.list_models() — delegates to the named provider, returns []
# on an unknown name.
# ---------------------------------------------------------------------------


def test_top_level_list_models_unknown_provider() -> None:
    assert llm_pkg.list_models("definitely-not-a-provider") == []


def test_top_level_list_models_delegates(monkeypatch: pytest.MonkeyPatch) -> None:
    """The package-level helper instantiates the named provider and calls
    its `list_models()`."""
    from backend.llm.base import ModelInfo, ReasoningCapability

    fake_models = [
        ModelInfo(
            id="fake-1",
            display_name="Fake",
            max_input_tokens=1024,
            max_output_tokens=512,
            reasoning=ReasoningCapability(supported=False, shape="none"),
        )
    ]
    monkeypatch.setattr("backend.llm.gemini.GeminiProvider.list_models", lambda self: fake_models)
    out = llm_pkg.list_models("gemini")
    assert out == fake_models


# ---------------------------------------------------------------------------
# reasoning_effort plumbing — config-level → provider-level → request body.
# ---------------------------------------------------------------------------


def test_openai_complete_includes_reasoning_effort_when_model_supports_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """End-to-end plumbing: a config with reasoning_effort='low' on a
    capability-mapped model (gpt-5) lands in the chat-completions body
    as `reasoning_effort: low`."""
    monkeypatch.setenv("OPENAI_API_KEY", "k")
    captured: dict = {}

    @responses.activate
    def _run() -> str | None:
        responses.add(
            responses.POST,
            "https://api.openai.com/v1/chat/completions",
            json={"choices": [{"message": {"content": "ok"}}]},
            status=200,
        )
        p = OpenAIProvider(model="gpt-5", reasoning_effort="low")
        result = p.complete("hello")
        # responses 0.25 stores the matched request on the registered match.
        # responses.calls is a list of (req, resp) tuples — grab body json.
        captured["body"] = json.loads(responses.calls[0].request.body or "{}")
        return result

    out = _run()
    assert out == "ok"
    assert captured["body"].get("reasoning_effort") == "low"


def test_openai_complete_omits_reasoning_effort_when_model_does_not_support(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """User configured 'low' but is on gpt-4o-mini — capability map says
    none. The request body must NOT carry reasoning_effort."""
    monkeypatch.setenv("OPENAI_API_KEY", "k")
    captured: dict = {}

    @responses.activate
    def _run() -> str | None:
        responses.add(
            responses.POST,
            "https://api.openai.com/v1/chat/completions",
            json={"choices": [{"message": {"content": "ok"}}]},
            status=200,
        )
        p = OpenAIProvider(model="gpt-4o-mini", reasoning_effort="low")
        result = p.complete("hello")
        captured["body"] = json.loads(responses.calls[0].request.body or "{}")
        return result

    out = _run()
    assert out == "ok"
    assert "reasoning_effort" not in captured["body"]


def test_openai_score_batch_never_carries_reasoning_effort(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Default policy: scoring loop deliberately omits reasoning_effort
    even when the user has it set on a supporting model. Inflating
    bounded-JSON latency 3-10x for marginal accuracy is the bad trade."""
    monkeypatch.setenv("OPENAI_API_KEY", "k")
    captured: dict = {}

    @responses.activate
    def _run() -> Any:
        responses.add(
            responses.POST,
            "https://api.openai.com/v1/chat/completions",
            json={"choices": [{"message": {"content": "[]"}}]},
            status=200,
        )
        p = OpenAIProvider(model="gpt-5", reasoning_effort="high")
        result = p.score_batch("cv", [{"id": "1", "title": "X", "company": "Y"}])
        captured["body"] = json.loads(responses.calls[0].request.body or "{}")
        return result

    _run()
    assert "reasoning_effort" not in captured["body"]


def test_get_provider_forwards_reasoning_effort_from_config(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`get_provider` reads `reasoning_effort` from the active config and
    passes it through to the provider constructor."""
    monkeypatch.setattr(llm_pkg, "_cached", None)
    monkeypatch.setattr(
        llm_pkg,
        "_read_cfg",
        lambda: {"name": "openai", "model": "gpt-5", "reasoning_effort": "medium"},
    )
    p = llm_pkg.get_provider(force=True)
    assert p is not None
    assert p.name == "openai"
    assert getattr(p, "reasoning_effort", None) == "medium"
    assert getattr(p, "model", None) == "gpt-5"


def test_legacy_config_without_model_or_effort_round_trips_unchanged(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A pre-#114 config (just {name: 'gemini'}) must produce a provider
    instance whose reasoning_effort is None and whose model is the
    provider's hardcoded default — i.e. no parameter drift compared to
    before this branch."""
    monkeypatch.setattr(llm_pkg, "_cached", None)
    monkeypatch.setattr(llm_pkg, "_read_cfg", lambda: {"name": "gemini"})
    p = llm_pkg.get_provider(force=True)
    assert p is not None
    assert p.name == "gemini"
    assert getattr(p, "reasoning_effort", None) is None
    assert getattr(p, "model", None) == "gemini-2.5-flash"


def test_normalize_llm_provider_accepts_string_int_bool_for_effort() -> None:
    """search._normalize_llm_provider keeps every supported shape: string
    (levels), int (gemini budget), bool (ollama think)."""
    from backend.search import _normalize_llm_provider

    fb = {"name": "auto"}
    for raw, expected in [
        ({"name": "openai", "reasoning_effort": "low"}, "low"),
        ({"name": "gemini", "reasoning_effort": 4096}, 4096),
        ({"name": "ollama", "reasoning_effort": True}, True),
        ({"name": "ollama", "reasoning_effort": False}, False),
    ]:
        out = _normalize_llm_provider(raw, fb)
        assert out["reasoning_effort"] == expected


def test_normalize_llm_provider_drops_unsupported_effort_types() -> None:
    from backend.search import _normalize_llm_provider

    out = _normalize_llm_provider({"name": "openai", "reasoning_effort": ["low"]}, {"name": "auto"})
    assert "reasoning_effort" not in out
