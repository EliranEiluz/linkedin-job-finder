"""Abstract LLM provider interface for batch job scoring."""

from __future__ import annotations


class LLMProvider:
    name: str = "base"

    def score_batch(self, cv_text: str, batch: list[dict]) -> list | None:
        """Return parsed JSON array (one entry per job) or None on failure."""
        raise NotImplementedError

    def test(self) -> tuple[bool, str]:
        """One trivial 1-job call to verify creds + connectivity.
        Returns (ok, human-readable message)."""
        raise NotImplementedError

    def complete(
        self,
        prompt: str,
        *,
        system: str | None = None,
        max_tokens: int = 4096,
        json_mode: bool = False,
    ) -> str | None:
        """Single-shot completion. Returns the model's text output (no parsing),
        or None on failure. `json_mode=True` is a hint for providers that
        support a structured-output mode (Gemini, OpenRouter+capable models,
        Ollama). Callers are still expected to parse the returned text
        themselves (use backend.llm._shared.parse_json_response if needed)."""
        raise NotImplementedError
