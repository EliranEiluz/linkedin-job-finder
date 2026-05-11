"""Abstract LLM provider interface for batch job scoring.

Stage 4 (task #114) added the `list_models()` API + the `ModelInfo` /
`ReasoningCapability` dataclasses, so each provider can advertise its
own catalog + reasoning-effort surface to the picker UI. Existing call
sites that just want score_batch / complete keep working — the new
methods are opt-in.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

# Provider-agnostic reasoning shapes. Mirrors the per-provider docs as of
# May 2026:
#   "levels"  — string ∈ {off, low, medium, high, max, xhigh} subset.
#               Anthropic / OpenAI / OpenRouter / claude_cli.
#   "budget"  — integer token budget within a min/max range, or -1 for
#               dynamic. Gemini 2.5 family only.
#   "boolean" — true/false. Ollama "thinking" models (deepseek-r1, qwen3).
#   "none"    — model has no reasoning surface. Hide the control entirely.
ReasoningShape = Literal["levels", "budget", "boolean", "none"]


@dataclass(frozen=True)
class ReasoningCapability:
    """What the model declares about its reasoning-effort surface.

    Frozen so accidentally mutating an in-memory entry after `list_models()`
    cached it can't corrupt other readers."""

    supported: bool
    shape: ReasoningShape
    # Populated only when shape == "levels".
    levels: tuple[str, ...] | None = None
    # Populated only when shape == "budget". (min, max) inclusive.
    budget_range: tuple[int, int] | None = None

    def to_dict(self) -> dict:
        """JSON-friendly view for the ctl envelope + the picker UI.

        Tuples become arrays so the envelope round-trips through json.dumps
        without a custom encoder."""
        out: dict = {"supported": self.supported, "shape": self.shape}
        if self.levels is not None:
            out["levels"] = list(self.levels)
        if self.budget_range is not None:
            out["budget_range"] = list(self.budget_range)
        return out


@dataclass(frozen=True)
class ModelInfo:
    """One row in the provider's model catalog. The picker renders these."""

    id: str
    display_name: str
    max_input_tokens: int | None
    max_output_tokens: int | None
    reasoning: ReasoningCapability = field(
        default_factory=lambda: ReasoningCapability(supported=False, shape="none")
    )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "display_name": self.display_name,
            "max_input_tokens": self.max_input_tokens,
            "max_output_tokens": self.max_output_tokens,
            "reasoning": self.reasoning.to_dict(),
        }


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

    def list_models(self) -> list[ModelInfo]:
        """Return this provider's available models + their reasoning shape.

        Mixed implementation strategy across providers:
          - claude_sdk / openrouter / gemini / ollama : live API call.
          - openai : live `client.models.list()` cross-referenced against
            an in-repo capability map (the live response is sparse).
          - claude_cli : hardcoded (CLI has no enumeration endpoint).

        Each provider is responsible for swallowing transport errors and
        returning [] in that case — callers downstream (the ctl envelope,
        the picker UI) treat an empty list as "no models surfaced" without
        crashing.
        """
        return []
