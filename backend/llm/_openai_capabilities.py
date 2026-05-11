"""OpenAI capability map — keyed by model-id prefix.

The OpenAI `client.models.list()` response is sparse — it surfaces only
id/created/owned_by/object. The reasoning-effort surface (which models
accept `reasoning_effort`, which levels they declare) lives in the
platform docs, NOT in the API response. So we keep an in-repo lookup
keyed by id prefix that the picker UI can render against.

May 2026 facts (verified against platform.openai.com/docs):
  - gpt-5 / gpt-5.5 / gpt-5-pro     : reasoning-effort levels [low, medium, high, xhigh]
  - o1 / o1-mini / o1-preview       : levels [low, medium, high]
  - o3 / o3-mini                    : levels [low, medium, high, xhigh]
  - o4-mini                          : levels [low, medium, high]
  - "minimal" was REMOVED from the API surface in late 2025
  - Everything else (gpt-4o, gpt-4o-mini, gpt-3.5, etc.) — no reasoning_effort

"none" shape models still appear in the picker — they just don't render
the secondary control. The picker reads `reasoning.shape == "none"`
and hides it.
"""

from __future__ import annotations

from .base import ReasoningCapability

# Per-prefix capability lookup. Order matters: most-specific prefix first
# so `gpt-5-pro` doesn't match the `gpt-5` family entry. We do a longest-
# prefix-wins iteration at the call site.
_NO_REASONING = ReasoningCapability(supported=False, shape="none")

_OPENAI_CAPABILITIES: list[tuple[str, ReasoningCapability]] = [
    # gpt-5 family: forced "high" on gpt-5-pro is enforced at request time
    # (the API rejects other values); the catalog still declares the full
    # spectrum so the picker shows "what's possible on this family".
    (
        "gpt-5-pro",
        ReasoningCapability(
            supported=True, shape="levels", levels=("low", "medium", "high", "xhigh")
        ),
    ),
    (
        "gpt-5.5",
        ReasoningCapability(
            supported=True, shape="levels", levels=("low", "medium", "high", "xhigh")
        ),
    ),
    (
        "gpt-5",
        ReasoningCapability(
            supported=True, shape="levels", levels=("low", "medium", "high", "xhigh")
        ),
    ),
    (
        "o4-mini",
        ReasoningCapability(supported=True, shape="levels", levels=("low", "medium", "high")),
    ),
    (
        "o3-mini",
        ReasoningCapability(
            supported=True, shape="levels", levels=("low", "medium", "high", "xhigh")
        ),
    ),
    (
        "o3",
        ReasoningCapability(
            supported=True, shape="levels", levels=("low", "medium", "high", "xhigh")
        ),
    ),
    (
        "o1-preview",
        ReasoningCapability(supported=True, shape="levels", levels=("low", "medium", "high")),
    ),
    (
        "o1-mini",
        ReasoningCapability(supported=True, shape="levels", levels=("low", "medium", "high")),
    ),
    (
        "o1",
        ReasoningCapability(supported=True, shape="levels", levels=("low", "medium", "high")),
    ),
]


def capability_for(model_id: str) -> ReasoningCapability:
    """Longest-prefix-wins lookup. Unknown ids → no reasoning surface."""
    if not model_id:
        return _NO_REASONING
    # The table is in longest-first order — first match wins.
    for prefix, cap in _OPENAI_CAPABILITIES:
        if model_id.startswith(prefix):
            return cap
    return _NO_REASONING
