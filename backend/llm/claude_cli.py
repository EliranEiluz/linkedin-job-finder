"""Claude Code CLI provider — subprocess `claude -p ...`."""
from __future__ import annotations

import shutil
import subprocess

from .base import LLMProvider
from ._shared import parse_json_response, TEST_BATCH, TEST_CV


class ClaudeCLIProvider(LLMProvider):
    name = "claude_cli"

    def __init__(self, model: str = "claude-sonnet-4-5"):
        self.model = model

    def _prompt(self, cv_text: str, batch: list[dict]) -> str:
        # Lazy import to avoid circular dep at module load.
        from backend.search import _build_batch_prompt
        return _build_batch_prompt(cv_text, batch)

    def score_batch(self, cv_text: str, batch: list[dict]) -> list | None:
        if not shutil.which("claude"):
            return None
        prompt = self._prompt(cv_text, batch)
        try:
            proc = subprocess.run(
                ["claude", "-p", prompt,
                 "--output-format", "text",
                 "--model", self.model],
                capture_output=True, text=True, timeout=240,
            )
            if proc.returncode != 0:
                print(f"    claude CLI rc={proc.returncode}: {proc.stderr.strip()[:300]}")
                return None
            parsed = parse_json_response(proc.stdout)
            if isinstance(parsed, list):
                return parsed
            print(f"    claude CLI returned non-array: {str(proc.stdout)[:200]}")
            return None
        except Exception as e:
            # Tail-truncate — TimeoutExpired/CalledProcessError put the giant
            # argv at the START of str(e); the actual reason lives at the end.
            msg = str(e)
            print(f"    claude CLI error ({type(e).__name__}): …{msg[-300:]}")
            return None

    def test(self) -> tuple[bool, str]:
        if not shutil.which("claude"):
            return False, "`claude` CLI not on PATH (npm i -g @anthropic-ai/claude-code)"
        try:
            arr = self.score_batch(TEST_CV, TEST_BATCH)
        except Exception as e:
            return False, f"claude CLI error: {e}"
        if isinstance(arr, list) and arr:
            return True, f"claude CLI ok (model={self.model})"
        return False, "claude CLI returned no parseable result"
