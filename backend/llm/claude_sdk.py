"""Claude SDK provider — uses ANTHROPIC_API_KEY via the anthropic Python SDK."""
from __future__ import annotations

import os

from .base import LLMProvider
from ._shared import parse_json_response, TEST_BATCH, TEST_CV


class ClaudeSDKProvider(LLMProvider):
    name = "claude_sdk"

    def __init__(self, model: str = "claude-sonnet-4-5"):
        self.model = model
        self._client = None

    def _ensure_client(self):
        if self._client is not None:
            return self._client
        if not os.environ.get("ANTHROPIC_API_KEY"):
            return None
        try:
            from anthropic import Anthropic
            self._client = Anthropic()
            return self._client
        except Exception:
            return None

    def _prompt(self, cv_text: str, batch: list[dict]) -> str:
        from backend.search import _build_batch_prompt
        return _build_batch_prompt(cv_text, batch)

    def score_batch(self, cv_text: str, batch: list[dict]) -> list | None:
        client = self._ensure_client()
        if client is None:
            return None
        prompt = self._prompt(cv_text, batch)
        try:
            msg = client.messages.create(
                model=self.model,
                max_tokens=2048,
                system=[{
                    "type": "text",
                    "text": f"You score LinkedIn jobs for fit against this CV:\n\n{cv_text}",
                    "cache_control": {"type": "ephemeral"},
                }],
                messages=[{"role": "user", "content": prompt}],
            )
            raw = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text")
            parsed = parse_json_response(raw)
            return parsed if isinstance(parsed, list) else None
        except Exception as e:
            print(f"    SDK error: {str(e)[:150]}")
            return None

    def test(self) -> tuple[bool, str]:
        if not os.environ.get("ANTHROPIC_API_KEY"):
            return False, "ANTHROPIC_API_KEY not set"
        if self._ensure_client() is None:
            return False, "anthropic SDK import failed (pip install anthropic)"
        try:
            arr = self.score_batch(TEST_CV, TEST_BATCH)
        except Exception as e:
            return False, f"Anthropic SDK error: {e}"
        if isinstance(arr, list) and arr:
            return True, f"Anthropic SDK ok (model={self.model})"
        return False, "Anthropic SDK returned no parseable result"
