"""Claude Code CLI provider — subprocess `claude -p ...`."""

from __future__ import annotations

import shutil
import subprocess

from ._shared import TEST_BATCH, TEST_CV, parse_json_response
from .base import LLMProvider, ModelInfo, ReasoningCapability

# Effort levels the `claude` CLI accepts via `--effort`. Same canonical set
# as the SDK; "off" is the local sentinel meaning "omit the flag entirely".
_VALID_EFFORT_LEVELS: frozenset[str] = frozenset({"low", "medium", "high", "max", "xhigh"})

# Hardcoded model list — the CLI has no enumeration endpoint. Kept in this
# file (not _claude_cli_capabilities.py) because the list is small and
# stable; revisit if it grows.
_CLAUDE_CLI_LEVELS: tuple[str, ...] = ("low", "medium", "high", "max", "xhigh")
_CLAUDE_CLI_MODELS: tuple[tuple[str, str], ...] = (
    ("opus-4-7", "Claude Opus 4.7"),
    ("opus-4-6", "Claude Opus 4.6"),
    ("sonnet-4-6", "Claude Sonnet 4.6"),
    ("haiku-4-5", "Claude Haiku 4.5"),
)


class ClaudeCLIProvider(LLMProvider):
    name = "claude_cli"

    def __init__(
        self,
        model: str = "claude-sonnet-4-5",
        *,
        reasoning_effort: str | int | None = None,
    ):
        self.model = model
        self.reasoning_effort = reasoning_effort

    def _prompt(self, cv_text: str, batch: list[dict]) -> str:
        # Lazy import to avoid circular dep at module load.
        from backend.search import _build_batch_prompt

        return _build_batch_prompt(cv_text, batch)

    def _effort_argv(self) -> list[str]:
        """Build the `--effort <level>` argv slice for the configured level,
        or [] to omit the flag."""
        eff = self.reasoning_effort
        if not isinstance(eff, str):
            return []
        lvl = eff.strip().lower()
        if lvl in ("", "off", "none"):
            return []
        if lvl not in _VALID_EFFORT_LEVELS:
            print(f"    claude CLI: ignoring unknown reasoning_effort={lvl!r}")
            return []
        return ["--effort", lvl]

    def score_batch(self, cv_text: str, batch: list[dict]) -> list | None:
        if not shutil.which("claude"):
            return None
        prompt = self._prompt(cv_text, batch)
        # Scoring path omits --effort — bounded JSON output, see #114 policy.
        try:
            proc = subprocess.run(
                ["claude", "-p", prompt, "--output-format", "text", "--model", self.model],
                capture_output=True,
                text=True,
                timeout=240,
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

    def complete(
        self,
        prompt: str,
        *,
        system: str | None = None,
        max_tokens: int = 4096,  # noqa: ARG002 — CLI has no max-tokens flag
        json_mode: bool = False,  # noqa: ARG002 — CLI has no JSON-mode flag
    ) -> str | None:
        # CLI has no separate `--system` flag in the -p path; we just prepend
        # the system message to the user prompt. json_mode is irrelevant here
        # — the CLI emits whatever Claude writes; callers parse the result.
        if not shutil.which("claude"):
            return None
        full_prompt = f"{system}\n\n{prompt}" if system else prompt
        argv = [
            "claude",
            "-p",
            full_prompt,
            "--output-format",
            "text",
            "--model",
            self.model,
            *self._effort_argv(),
        ]
        try:
            proc = subprocess.run(
                argv,
                capture_output=True,
                text=True,
                timeout=240,
            )
            if proc.returncode != 0:
                print(f"    claude CLI rc={proc.returncode}: {proc.stderr.strip()[:300]}")
                return None
            return proc.stdout
        except Exception as e:
            msg = str(e)
            print(f"    claude CLI error ({type(e).__name__}): …{msg[-300:]}")
            return None

    def list_models(self) -> list[ModelInfo]:
        """Hardcoded list — the CLI has no `models` subcommand. All four
        entries declare the full effort spectrum so the picker UI surfaces
        every level (the CLI ignores ones the underlying account can't run
        and the user sees a clear error from the subprocess in that case)."""
        out: list[ModelInfo] = []
        for mid, display in _CLAUDE_CLI_MODELS:
            out.append(
                ModelInfo(
                    id=mid,
                    display_name=display,
                    max_input_tokens=None,
                    max_output_tokens=None,
                    reasoning=ReasoningCapability(
                        supported=True, shape="levels", levels=_CLAUDE_CLI_LEVELS
                    ),
                )
            )
        return out
