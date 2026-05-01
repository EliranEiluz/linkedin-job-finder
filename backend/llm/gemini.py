"""Google Gemini provider — raw HTTP, free tier via aistudio.google.com/apikey."""
from __future__ import annotations

import os

from .base import LLMProvider
from ._shared import parse_json_response, TEST_BATCH, TEST_CV

ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"


class GeminiProvider(LLMProvider):
    name = "gemini"

    def __init__(self, model: str = "gemini-2.5-flash"):
        self.model = model

    def _prompt(self, cv_text: str, batch: list[dict]) -> str:
        from backend.search import _build_batch_prompt
        return _build_batch_prompt(cv_text, batch)

    def _api_key(self) -> str | None:
        return os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")

    def score_batch(self, cv_text: str, batch: list[dict]) -> list | None:
        key = self._api_key()
        if not key:
            return None
        try:
            import requests
        except Exception:
            print("    gemini: requests not installed")
            return None
        prompt = self._prompt(cv_text, batch)
        url = ENDPOINT.format(model=self.model)
        body = {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {
                "response_mime_type": "application/json",
                "temperature": 0.2,
                "maxOutputTokens": 2048,
            },
        }
        try:
            r = requests.post(url, params={"key": key}, json=body, timeout=240)
            if r.status_code != 200:
                print(f"    gemini http {r.status_code}: {r.text[:200]}")
                return None
            data = r.json()
            cand = (data.get("candidates") or [{}])[0]
            parts = (cand.get("content") or {}).get("parts") or []
            raw = "".join(p.get("text", "") for p in parts if isinstance(p, dict))
            parsed = parse_json_response(raw)
            return parsed if isinstance(parsed, list) else None
        except Exception as e:
            print(f"    gemini error: {str(e)[:200]}")
            return None

    def test(self) -> tuple[bool, str]:
        key = self._api_key()
        if not key:
            return False, (
                "GEMINI_API_KEY not set — get a free key at "
                "https://aistudio.google.com/apikey then "
                "`export GEMINI_API_KEY=...`"
            )
        try:
            arr = self.score_batch(TEST_CV, TEST_BATCH)
        except Exception as e:
            return False, f"gemini error: {e}"
        if isinstance(arr, list) and arr:
            return True, f"gemini ok (model={self.model})"
        return False, "gemini returned no parseable result"

    def complete(self, prompt: str, *, system: str | None = None,
                 max_tokens: int = 4096, json_mode: bool = False) -> str | None:
        key = self._api_key()
        if not key:
            return None
        try:
            import requests
        except Exception:
            print("    gemini: requests not installed")
            return None
        url = ENDPOINT.format(model=self.model)
        gen_cfg: dict = {"temperature": 0.2, "maxOutputTokens": max_tokens}
        if json_mode:
            gen_cfg["response_mime_type"] = "application/json"
        body: dict = {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": gen_cfg,
        }
        if system:
            # Gemini's v1beta supports system_instruction at the top level.
            body["system_instruction"] = {"parts": [{"text": system}]}
        try:
            r = requests.post(url, params={"key": key}, json=body, timeout=240)
            if r.status_code != 200:
                print(f"    gemini http {r.status_code}: {r.text[:200]}")
                return None
            data = r.json()
            cand = (data.get("candidates") or [{}])[0]
            parts = (cand.get("content") or {}).get("parts") or []
            return "".join(p.get("text", "") for p in parts if isinstance(p, dict))
        except Exception as e:
            print(f"    gemini error: {str(e)[:200]}")
            return None
