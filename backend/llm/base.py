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
