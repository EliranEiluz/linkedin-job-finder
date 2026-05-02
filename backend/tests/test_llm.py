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
