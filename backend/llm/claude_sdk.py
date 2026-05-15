"""Claude SDK provider — uses ANTHROPIC_API_KEY via the anthropic Python SDK."""

from __future__ import annotations

import os
from typing import Any

from ._shared import TEST_BATCH, TEST_CV, parse_json_response
from .base import LLMProvider, ModelInfo, ReasoningCapability

# Effort levels the Anthropic SDK accepts on `output_config.effort`. "off"
# is the local sentinel meaning "don't send the field at all" — Anthropic's
# API has no literal "off" string. Kept aligned with the levels enumerated
# by `models.list()` so the picker can pre-validate user input.
_VALID_EFFORT_LEVELS: frozenset[str] = frozenset({"low", "medium", "high", "max", "xhigh"})


class ClaudeSDKProvider(LLMProvider):
    name = "claude_sdk"
    # Anthropic's tool-use API enforces `tool.input_schema`; the model is
    # forced to produce output that matches. See complete_structured below.
    supports_structured_output = True

    def __init__(
        self,
        model: str = "claude-sonnet-4-5",
        *,
        reasoning_effort: str | int | None = None,
    ) -> None:
        self.model = model
        # User-configured effort level. None / "off" / anything outside the
        # declared set → omit the field from the request. `complete()` honors
        # this; `score_batch()` deliberately ignores it (scoring loop is
        # bounded JSON, see #114 default-policy note).
        self.reasoning_effort = reasoning_effort
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

    def _effort_kwarg(self) -> dict:
        """Build the kwargs slice the SDK accepts for the configured effort.

        Returns an empty dict when no effort should be applied (None / "off" /
        unknown level) so callers can just `**self._effort_kwarg()` into their
        request payload."""
        eff = self.reasoning_effort
        if not isinstance(eff, str):
            return {}
        lvl = eff.strip().lower()
        if lvl in ("", "off", "none"):
            return {}
        if lvl not in _VALID_EFFORT_LEVELS:
            print(f"    SDK: ignoring unknown reasoning_effort={lvl!r}")
            return {}
        # Newer anthropic SDKs accept output_config.effort. Older clients
        # silently drop unknown kwargs; if a future SDK rejects it we'll
        # surface the API error from the try/except in score_batch/complete.
        return {"output_config": {"effort": lvl}}

    def score_batch(self, cv_text: str, batch: list[dict]) -> list | None:
        client = self._ensure_client()
        if client is None:
            return None
        prompt = self._prompt(cv_text, batch)
        try:
            # Scoring loop deliberately omits reasoning effort: structured
            # JSON output is bounded, and thinking inflates latency 3-10x
            # for marginal accuracy. The default-policy note in #114 spec.
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
                # Honor the configured effort on single-shot calls (suggester
                # path is the one that benefits from extra reasoning).
                **self._effort_kwarg(),
            }
            if system:
                kwargs["system"] = system
            msg = client.messages.create(**kwargs)
            return "".join(b.text for b in msg.content if getattr(b, "type", "") == "text")
        except Exception as e:
            print(f"    SDK error: {str(e)[:150]}")
            return None

    def list_models(self) -> list[ModelInfo]:
        """Call `client.models.list(limit=1000)` and map the rich capability
        block onto our ModelInfo shape. Each Anthropic model includes a
        `capabilities.effort` object with per-level supported flags."""
        client = self._ensure_client()
        if client is None:
            return []
        try:
            resp = client.models.list(limit=1000)
        except Exception as e:
            print(f"    SDK list_models error: {str(e)[:150]}")
            return []
        # The SDK exposes `.data` (list) on the response page object; some
        # versions yield directly. Normalize both.
        raw_models = getattr(resp, "data", None)
        if raw_models is None:
            try:
                raw_models = list(resp)
            except TypeError:
                return []
        out: list[ModelInfo] = []
        for m in raw_models or []:
            mid = str(getattr(m, "id", "") or "")
            if not mid:
                continue
            display = str(getattr(m, "display_name", None) or mid)
            max_in = getattr(m, "max_input_tokens", None)
            max_out = getattr(m, "max_output_tokens", None)
            cap = getattr(m, "capabilities", None)
            effort = getattr(cap, "effort", None) if cap is not None else None
            if effort is None:
                reasoning = ReasoningCapability(supported=False, shape="none")
            else:
                supported_levels = tuple(
                    lvl
                    for lvl in ("low", "medium", "high", "max", "xhigh")
                    if getattr(getattr(effort, lvl, None), "supported", False)
                )
                if supported_levels:
                    reasoning = ReasoningCapability(
                        supported=True, shape="levels", levels=supported_levels
                    )
                else:
                    reasoning = ReasoningCapability(supported=False, shape="none")
            out.append(
                ModelInfo(
                    id=mid,
                    display_name=display,
                    max_input_tokens=int(max_in) if isinstance(max_in, int) else None,
                    max_output_tokens=int(max_out) if isinstance(max_out, int) else None,
                    reasoning=reasoning,
                )
            )
        return out
