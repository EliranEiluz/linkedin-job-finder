"""LLM provider abstraction. Resolves provider from active config and
delegates `score_batch`. Stage 2 — backend only, no UI yet."""

from __future__ import annotations

import os

from .base import LLMProvider
from .claude_cli import ClaudeCLIProvider
from .claude_sdk import ClaudeSDKProvider
from .gemini import GeminiProvider
from .openai import OpenAIProvider
from .openrouter import OpenRouterProvider
from .ollama import OllamaProvider

PROVIDERS = {
    "claude_cli": ClaudeCLIProvider,
    "claude_sdk": ClaudeSDKProvider,
    "gemini": GeminiProvider,
    "openai": OpenAIProvider,
    "openrouter": OpenRouterProvider,
    "ollama": OllamaProvider,
}

# Order tried in `auto` mode. Cheap-or-already-installed first.
AUTO_ORDER = ["claude_cli", "claude_sdk", "gemini", "openai", "openrouter", "ollama"]

_cached: LLMProvider | None = None


def _read_cfg() -> dict:
    try:
        from backend import search

        cfg = getattr(search, "_ACTIVE_CONFIG", {}) or {}
    except Exception:
        cfg = {}
    val = cfg.get("llm_provider") or {}
    if not isinstance(val, dict):
        val = {}
    return val


def _instantiate(name: str, model: str | None = None) -> LLMProvider:
    cls = PROVIDERS[name]
    return cls(model=model) if model else cls()


def _quick_available(p: LLMProvider) -> bool:
    """Cheap pre-check before paying for a real test() call. Avoids burning
    Claude tokens during auto-resolve when we already know a provider isn't
    set up. Each provider's test() does the full round-trip."""
    n = p.name
    if n == "claude_cli":
        import shutil

        return bool(shutil.which("claude"))
    if n == "claude_sdk":
        return bool(os.environ.get("ANTHROPIC_API_KEY"))
    if n == "gemini":
        return bool(os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY"))
    if n == "openai":
        return bool(os.environ.get("OPENAI_API_KEY"))
    if n == "openrouter":
        return bool(os.environ.get("OPENROUTER_API_KEY"))
    if n == "ollama":
        try:
            import requests
            from .ollama import HOST

            r = requests.get(f"{HOST}/api/tags", timeout=2)
            return r.status_code == 200
        except Exception:
            return False
    return False


def get_provider(force: bool = False) -> LLMProvider | None:
    global _cached
    if _cached is not None and not force:
        return _cached
    cfg = _read_cfg()
    name = (cfg.get("name") or "auto").strip().lower()
    model = cfg.get("model") or None
    if name != "auto":
        if name not in PROVIDERS:
            print(f"⚠ unknown llm_provider.name={name!r} — falling back to auto")
            name = "auto"
        else:
            _cached = _instantiate(name, model)
            return _cached
    # auto: pick the first provider that's quickly-available. We don't run the
    # full test() during scrape startup — that would burn a Claude token on
    # every run. quick_available is a pure-local check. The actual scrape will
    # surface a real failure if the chosen provider then breaks at score time.
    for n in AUTO_ORDER:
        cand = _instantiate(n, model if cfg.get("name") == n else None)
        if _quick_available(cand):
            _cached = cand
            return _cached
    return None


def score_batch(cv_text: str, batch: list[dict]) -> list | None:
    p = get_provider()
    if p is None:
        return None
    return p.score_batch(cv_text, batch)


def complete(
    prompt: str, *, system: str | None = None, max_tokens: int = 4096, json_mode: bool = False
) -> str | None:
    """Single-shot completion via the resolved provider. Returns raw text or
    None if no provider is configured / the call fails. Used by the wizard
    (onboarding_ctl) and the suggester (config_suggest_ctl) — both of which
    pass json_mode=True since they expect a structured JSON object back."""
    provider = get_provider()
    if not provider:
        return None
    return provider.complete(prompt, system=system, max_tokens=max_tokens, json_mode=json_mode)


def test_provider(name: str | None = None) -> tuple[bool, str]:
    """If name is None or 'auto', resolve via get_provider() and test that."""
    if not name or name == "auto":
        p = get_provider(force=True)
        if p is None:
            return (
                False,
                "no provider available — set ANTHROPIC_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY, install `claude` CLI, or run `ollama serve`",
            )
        ok, msg = p.test()
        return ok, f"[auto -> {p.name}] {msg}"
    if name not in PROVIDERS:
        return False, f"unknown provider {name!r} — known: {sorted(PROVIDERS)}"
    cfg = _read_cfg()
    model = cfg.get("model") if cfg.get("name") == name else None
    return _instantiate(name, model).test()


__all__ = [
    "LLMProvider",
    "PROVIDERS",
    "AUTO_ORDER",
    "get_provider",
    "score_batch",
    "complete",
    "test_provider",
]
