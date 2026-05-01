"""OpenRouter provider — OpenAI-compatible /chat/completions, many free models."""
from __future__ import annotations

import os

from .base import LLMProvider
from ._shared import parse_json_response, TEST_BATCH, TEST_CV

ENDPOINT = "https://openrouter.ai/api/v1/chat/completions"


class OpenRouterProvider(LLMProvider):
    name = "openrouter"

    def __init__(self, model: str = "meta-llama/llama-3.3-70b-instruct:free"):
        self.model = model

    def _prompt(self, cv_text: str, batch: list[dict]) -> str:
        from backend.search import _build_batch_prompt
        return _build_batch_prompt(cv_text, batch)

    def _api_key(self) -> str | None:
        return os.environ.get("OPENROUTER_API_KEY")

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
        body = {
            "model": self.model,
            "messages": [
                {"role": "system",
                 "content": f"You score LinkedIn jobs for fit against this CV:\n\n{cv_text}"},
                {"role": "user", "content": prompt},
            ],
            "temperature": 0.2,
            "max_tokens": 2048,
            # Many OpenRouter-hosted models accept this OpenAI-style hint.
            "response_format": {"type": "json_object"},
        }
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

    def complete(self, prompt: str, *, system: str | None = None,
                 max_tokens: int = 4096, json_mode: bool = False) -> str | None:
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
