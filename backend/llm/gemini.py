"""Google Gemini provider — raw HTTP, free tier via aistudio.google.com/apikey."""

from __future__ import annotations

import os
from typing import Any

from ._shared import TEST_BATCH, TEST_CV, parse_json_response
from .base import LLMProvider, ModelInfo, ReasoningCapability

ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
LIST_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models"

# Thinking-level values the gemini-3 family declares (mirrors the
# thinkingConfig.thinkingLevel docs as of May 2026).
_GEMINI3_LEVELS: tuple[str, ...] = ("minimal", "low", "medium", "high")
# Budget windows. See Google AI docs §"Thinking budget".
_GEMINI_25_PRO_RANGE: tuple[int, int] = (128, 32768)
_GEMINI_25_FLASH_RANGE: tuple[int, int] = (0, 24576)


# Keys in our dumped JSON Schema that Gemini's responseSchema rejects.
# We strip these in _to_gemini_schema; everything else passes through.
_GEMINI_REJECTED_KEYS: frozenset[str] = frozenset(
    {"additionalProperties", "$schema", "$id", "$comment", "default", "examples"}
)


def _to_gemini_schema(schema: dict) -> dict:
    """Translate a Draft-2020-12 JSON Schema into Gemini's OpenAPI subset.

    Recursive: descends into `properties`, `items`, `oneOf`/`anyOf`/`allOf`.
    Drops keys Gemini rejects; passes the rest through unmodified. The
    translator is intentionally conservative — we only handle the shapes
    our FilterStateSchema actually emits (object with scalar / array
    properties, enums on string types, integer min/max). If Zod grows a
    feature this doesn't handle, the test_structured_output_gemini case
    will catch the regression and we extend here.
    """
    if not isinstance(schema, dict):
        return schema
    out: dict = {}
    for k, v in schema.items():
        if k in _GEMINI_REJECTED_KEYS:
            continue
        if k == "properties" and isinstance(v, dict):
            out["properties"] = {pk: _to_gemini_schema(pv) for pk, pv in v.items()}
        elif k == "items":
            out["items"] = _to_gemini_schema(v) if isinstance(v, dict) else v
        elif k in ("oneOf", "anyOf", "allOf") and isinstance(v, list):
            out[k] = [_to_gemini_schema(x) if isinstance(x, dict) else x for x in v]
        else:
            out[k] = v
    return out


def _reasoning_for_gemini_model(model_id: str) -> ReasoningCapability:
    """Map a model id to its reasoning shape. Returns "none" for any
    Gemini model that doesn't declare a thinkingConfig surface."""
    lid = model_id.lower()
    if "gemini-3" in lid:
        return ReasoningCapability(supported=True, shape="levels", levels=_GEMINI3_LEVELS)
    if lid.startswith("gemini-2.5-pro") or "gemini-2.5-pro" in lid:
        return ReasoningCapability(
            supported=True, shape="budget", budget_range=_GEMINI_25_PRO_RANGE
        )
    if lid.startswith("gemini-2.5-flash") or "gemini-2.5-flash" in lid:
        return ReasoningCapability(
            supported=True, shape="budget", budget_range=_GEMINI_25_FLASH_RANGE
        )
    return ReasoningCapability(supported=False, shape="none")


class GeminiProvider(LLMProvider):
    name = "gemini"
    # Gemini accepts generationConfig.responseSchema (OpenAPI-flavored
    # subset of JSON Schema) when paired with responseMimeType=
    # application/json. We adapt the Draft-2020-12 JSON Schema into
    # Gemini's expected shape in complete_structured below.
    supports_structured_output = True

    def __init__(
        self,
        model: str = "gemini-2.5-flash",
        *,
        reasoning_effort: str | int | None = None,
    ):
        self.model = model
        # On Gemini this can be either:
        #   - a string thinking-level ("minimal"|"low"|"medium"|"high") for
        #     the gemini-3 family
        #   - an integer thinking-budget for gemini-2.5-{pro,flash} (or -1
        #     for dynamic)
        # `_thinking_config()` picks the right shape based on the model id.
        self.reasoning_effort = reasoning_effort

    def _prompt(self, cv_text: str, batch: list[dict]) -> str:
        from backend.search import _build_batch_prompt

        return _build_batch_prompt(cv_text, batch)

    def _api_key(self) -> str | None:
        return os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")

    def _thinking_config(self) -> dict | None:
        """Build the `thinkingConfig` slice for generationConfig, honoring
        the model's reasoning shape. Returns None to omit when:
          - user disabled it (None / "off");
          - model doesn't accept thinking (shape == "none");
          - the configured value type doesn't match the shape."""
        eff = self.reasoning_effort
        if eff is None:
            return None
        if isinstance(eff, str) and eff.strip().lower() in ("", "off", "none"):
            return None
        cap = _reasoning_for_gemini_model(self.model)
        if cap.shape == "levels":
            if not isinstance(eff, str):
                return None
            lvl = eff.strip().lower()
            if cap.levels is None or lvl not in cap.levels:
                print(f"    gemini: ignoring unknown thinking level {lvl!r}")
                return None
            return {"thinkingLevel": lvl}
        if cap.shape == "budget":
            if not isinstance(eff, int) or isinstance(eff, bool):
                # The picker UI emits a number; a string here means the user
                # had the model swapped under them — surface and skip.
                print(f"    gemini: budget shape needs int, got {type(eff).__name__}")
                return None
            # -1 = dynamic (Google's sentinel). Any other negative is bogus.
            if eff != -1 and cap.budget_range is not None:
                lo, hi = cap.budget_range
                if not (lo <= eff <= hi):
                    print(
                        f"    gemini: thinking_budget {eff} out of range {cap.budget_range} — clamping"
                    )
                    eff = max(lo, min(eff, hi))
            return {"thinkingBudget": eff}
        # shape == "none" — omit.
        return None

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
        body: dict[str, Any] = {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": {
                "response_mime_type": "application/json",
                "temperature": 0.2,
                "maxOutputTokens": 2048,
            },
        }
        # Scoring loop omits thinking — bounded JSON output, see #114 default
        # policy. complete() honors the configured value for the suggester.
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

    def complete(
        self,
        prompt: str,
        *,
        system: str | None = None,
        max_tokens: int = 4096,
        json_mode: bool = False,
    ) -> str | None:
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
        thinking = self._thinking_config()
        if thinking is not None:
            gen_cfg["thinkingConfig"] = thinking
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

    def complete_structured(
        self,
        prompt: str,
        *,
        schema: dict,
        schema_name: str = "FilterEnvelope",  # noqa: ARG002 — Gemini doesn't name schemas
        system: str | None = None,
        max_tokens: int = 4096,
    ) -> str | None:
        """Gemini structured output via responseSchema.

        Gemini wants the OpenAPI-flavor subset of JSON Schema (not full
        Draft 2020-12). We translate the dumped schema here rather than
        emitting OpenAPI from Zod directly — only this provider needs it,
        and the JSON Schema source is authoritative.

        Differences vs. Draft-2020-12:
          - `additionalProperties` is rejected (Gemini infers strictness
            from `propertyOrdering` instead — we don't set it, so partial
            output is allowed).
          - `enum` lives ON the field type, not nested under items.type.
          - `description`, `type`, `properties`, `required`, `items`,
            `nullable` are accepted as-is.
          - Numeric `minimum`/`maximum` are accepted on type=integer/number.
          - `minLength`/`maxLength` are accepted on type=string.
        """
        key = self._api_key()
        if not key:
            return None
        try:
            import requests
        except Exception:
            print("    gemini: requests not installed")
            return None
        translated = _to_gemini_schema(schema)
        url = ENDPOINT.format(model=self.model)
        gen_cfg: dict = {
            "temperature": 0.2,
            "maxOutputTokens": max_tokens,
            "responseMimeType": "application/json",
            "responseSchema": translated,
        }
        # Honor the configured thinking config — structured-output works
        # alongside thinking on gemini-2.5-pro and gemini-3.
        thinking = self._thinking_config()
        if thinking is not None:
            gen_cfg["thinkingConfig"] = thinking
        body: dict = {
            "contents": [{"parts": [{"text": prompt}]}],
            "generationConfig": gen_cfg,
        }
        if system:
            body["system_instruction"] = {"parts": [{"text": system}]}
        try:
            r = requests.post(url, params={"key": key}, json=body, timeout=240)
            if r.status_code != 200:
                print(f"    gemini structured http {r.status_code}: {r.text[:200]}")
                return None
            data = r.json()
            cand = (data.get("candidates") or [{}])[0]
            parts = (cand.get("content") or {}).get("parts") or []
            return "".join(p.get("text", "") for p in parts if isinstance(p, dict))
        except Exception as e:
            print(f"    gemini structured error: {str(e)[:200]}")
            return None

    def list_models(self) -> list[ModelInfo]:
        """GET /v1beta/models. Filter to entries that support generateContent;
        map to ModelInfo with per-family reasoning shape."""
        key = self._api_key()
        if not key:
            return []
        try:
            import requests
        except Exception:
            return []
        try:
            r = requests.get(LIST_ENDPOINT, params={"key": key}, timeout=30)
            if r.status_code != 200:
                print(f"    gemini list_models http {r.status_code}: {r.text[:200]}")
                return []
            data = r.json()
        except Exception as e:
            print(f"    gemini list_models error: {str(e)[:200]}")
            return []
        out: list[ModelInfo] = []
        for m in data.get("models") or []:
            if not isinstance(m, dict):
                continue
            methods = m.get("supportedGenerationMethods") or []
            if "generateContent" not in methods:
                continue
            # IDs come back as "models/gemini-2.5-flash"; strip the prefix.
            raw_name = str(m.get("name") or "")
            mid = raw_name.split("/", 1)[1] if "/" in raw_name else raw_name
            if not mid:
                continue
            display = str(m.get("displayName") or mid)
            max_in = m.get("inputTokenLimit")
            max_out = m.get("outputTokenLimit")
            out.append(
                ModelInfo(
                    id=mid,
                    display_name=display,
                    max_input_tokens=int(max_in) if isinstance(max_in, int) else None,
                    max_output_tokens=int(max_out) if isinstance(max_out, int) else None,
                    reasoning=_reasoning_for_gemini_model(mid),
                )
            )
        return out
