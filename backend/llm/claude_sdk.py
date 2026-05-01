"""Claude SDK provider — uses ANTHROPIC_API_KEY via the anthropic Python SDK."""

from __future__ import annotations

import os
from typing import Any

from ._shared import TEST_BATCH, TEST_CV, parse_json_response
from .base import LLMProvider


class ClaudeSDKProvider(LLMProvider):
    name = "claude_sdk"

    def __init__(self, model: str = "claude-sonnet-4-5") -> None:
        self.model = model
        # Cached `anthropic.Anthropic` client. Stays Any-typed because the
        # `anthropic` package is optional — typing it explicitly would force a
        # hard dep at type-check time.
        self._client: Any = None

    def _ensure_client(self) -> Any:
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
                system=[
                    {
                        "type": "text",
                        "text": f"You score LinkedIn jobs for fit against this CV:\n\n{cv_text}",
                        "cache_control": {"type": "ephemeral"},
                    }
                ],
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

    def complete(
        self,
        prompt: str,
        *,
        system: str | None = None,
        max_tokens: int = 4096,
        json_mode: bool = False,  # noqa: ARG002 — Anthropic SDK has no JSON-mode flag
    ) -> str | None:
        client = self._ensure_client()
        if client is None:
            return None
        try:
            kwargs: dict[str, Any] = {
                "model": self.model,
                "max_tokens": max_tokens,
                "messages": [{"role": "user", "content": prompt}],
            }
            if system:
                kwargs["system"] = system
            msg = client.messages.create(**kwargs)
            return "".join(b.text for b in msg.content if getattr(b, "type", "") == "text")
        except Exception as e:
            print(f"    SDK error: {str(e)[:150]}")
            return None
