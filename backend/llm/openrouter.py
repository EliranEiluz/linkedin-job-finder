"""OpenRouter provider — OpenAI-compatible /chat/completions, many free models."""

from __future__ import annotations

import os
from typing import Any

from ._shared import TEST_BATCH, TEST_CV, parse_json_response
from .base import LLMProvider, ModelInfo, ReasoningCapability

ENDPOINT = "https://openrouter.ai/api/v1/chat/completions"
MODELS_ENDPOINT = "https://openrouter.ai/api/v1/models"

# OpenRouter normalizes reasoning across providers to three levels.
_OPENROUTER_LEVELS: tuple[str, ...] = ("low", "medium", "high")
_VALID_EFFORT_LEVELS: frozenset[str] = frozenset(_OPENROUTER_LEVELS)


class OpenRouterProvider(LLMProvider):
    name = "openrouter"

    def __init__(
        self,
        model: str = "meta-llama/llama-3.3-70b-instruct:free",
        *,
        reasoning_effort: str | int | None = None,
    ):
        self.model = model
        self.reasoning_effort = reasoning_effort

    def _prompt(self, cv_text: str, batch: list[dict]) -> str:
        from backend.search import _build_batch_prompt

        return _build_batch_prompt(cv_text, batch)

    def _api_key(self) -> str | None:
        return os.environ.get("OPENROUTER_API_KEY")

    def _reasoning_for_body(self) -> dict | None:
        """Build the `reasoning` slice for the chat-completions body.

        OpenRouter accepts `reasoning={"effort": "low|medium|high"}` and is
        mutually exclusive with `reasoning={"max_tokens": N}` — we surface
        the effort form. Returns None to omit."""
        eff = self.reasoning_effort
        if not isinstance(eff, str):
            return None
        lvl = eff.strip().lower()
        if lvl in ("", "off", "none"):
            return None
        if lvl not in _VALID_EFFORT_LEVELS:
            print(f"    openrouter: ignoring unknown reasoning_effort={lvl!r}")
            return None
        return {"effort": lvl}

    def score_batch(self, cv_text: str, batch: list[dict]) -> list | None:
        key = self._api_key()
        if not key:
            return None
        try:
            import requests
        except Exception:
            print("    openrouter: requests not installed")
            return None
        prompt = self._prompt(cv_text, batch)
        body: dict[str, Any] = {
            "model": self.model,
            "messages": [
                {
                    "role": "system",
                    "content": f"You score LinkedIn jobs for fit against this CV:\n\n{cv_text}",
                },
                {"role": "user", "content": prompt},
            ],
            "temperature": 0.2,
            "max_tokens": 2048,
            # Many OpenRouter-hosted models accept this OpenAI-style hint.
            "response_format": {"type": "json_object"},
        }
        # Scoring path omits `reasoning` — bounded JSON, see #114 policy.
        headers = {
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            # Optional but recommended by OpenRouter for routing/observability.
            "HTTP-Referer": "https://github.com/linkedin-jobs",
            "X-Title": "linkedin-jobs",
        }
        try:
            r = requests.post(ENDPOINT, headers=headers, json=body, timeout=240)
            if r.status_code != 200:
                print(f"    openrouter http {r.status_code}: {r.text[:200]}")
                return None
            data = r.json()
            choices = data.get("choices") or []
            if not choices:
                print(f"    openrouter: no choices in response: {str(data)[:200]}")
                return None
            raw = (choices[0].get("message") or {}).get("content") or ""
            parsed = parse_json_response(raw)
            return parsed if isinstance(parsed, list) else None
        except Exception as e:
            print(f"    openrouter error: {str(e)[:200]}")
            return None

    def test(self) -> tuple[bool, str]:
        key = self._api_key()
        if not key:
            return False, (
                "OPENROUTER_API_KEY not set — get a key at "
                "https://openrouter.ai/keys then "
                "`export OPENROUTER_API_KEY=sk-or-...`"
            )
        try:
            arr = self.score_batch(TEST_CV, TEST_BATCH)
        except Exception as e:
            return False, f"openrouter error: {e}"
        if isinstance(arr, list) and arr:
            return True, f"openrouter ok (model={self.model})"
        return False, "openrouter returned no parseable result"

    def complete(
        self,
        prompt: str,
        *,
        system: str | None = None,
        max_tokens: int = 4096,
        json_mode: bool = False,
    ) -> str | None:
        key = self._api_key()
        if not key:
            return None
        try:
            import requests
        except Exception:
            print("    openrouter: requests not installed")
            return None
        messages: list[dict] = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})
        body: dict = {
            "model": self.model,
            "messages": messages,
            "temperature": 0.2,
            "max_tokens": max_tokens,
        }
        reasoning = self._reasoning_for_body()
        if reasoning is not None:
            body["reasoning"] = reasoning
        if json_mode:
            body["response_format"] = {"type": "json_object"}
        headers = {
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://github.com/linkedin-jobs",
            "X-Title": "linkedin-jobs",
        }
        try:
            r = requests.post(ENDPOINT, headers=headers, json=body, timeout=240)
            if r.status_code != 200:
                print(f"    openrouter http {r.status_code}: {r.text[:200]}")
                return None
            data = r.json()
            choices = data.get("choices") or []
            if not choices:
                print(f"    openrouter: no choices in response: {str(data)[:200]}")
                return None
            return (choices[0].get("message") or {}).get("content") or ""
        except Exception as e:
            print(f"    openrouter error: {str(e)[:200]}")
            return None

    def list_models(self) -> list[ModelInfo]:
        """GET /api/v1/models — public endpoint (no auth required for the
        catalog). Returns 100+ entries; the picker UI handles the list
        size via its search box. Every entry gets the levels shape since
        OpenRouter normalizes reasoning across upstream providers."""
        try:
            import requests
        except Exception:
            return []
        try:
            r = requests.get(MODELS_ENDPOINT, timeout=30)
            if r.status_code != 200:
                print(f"    openrouter list_models http {r.status_code}: {r.text[:200]}")
                return []
            data = r.json()
        except Exception as e:
            print(f"    openrouter list_models error: {str(e)[:200]}")
            return []
        out: list[ModelInfo] = []
        for m in data.get("data") or []:
            if not isinstance(m, dict):
                continue
            mid = str(m.get("id") or "")
            if not mid:
                continue
            display = str(m.get("name") or mid)
            ctx = m.get("context_length")
            max_in: int | None = int(ctx) if isinstance(ctx, int) else None
            # OpenRouter exposes `top_provider.max_completion_tokens`.
            tp = m.get("top_provider") if isinstance(m.get("top_provider"), dict) else None
            max_out_raw = tp.get("max_completion_tokens") if tp else None
            max_out: int | None = int(max_out_raw) if isinstance(max_out_raw, int) else None
            # OpenRouter advertises reasoning support via supported_parameters.
            # If a model's adapter doesn't accept it, the field is absent.
            supported_params = m.get("supported_parameters") or []
            has_reasoning = isinstance(supported_params, list) and (
                "reasoning" in supported_params or "reasoning_effort" in supported_params
            )
            reasoning = (
                ReasoningCapability(supported=True, shape="levels", levels=_OPENROUTER_LEVELS)
                if has_reasoning
                else ReasoningCapability(supported=False, shape="none")
            )
            out.append(
                ModelInfo(
                    id=mid,
                    display_name=display,
                    max_input_tokens=max_in,
                    max_output_tokens=max_out,
                    reasoning=reasoning,
                )
            )
        return out
