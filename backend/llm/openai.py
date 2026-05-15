"""OpenAI provider — chat-completions API, JSON mode, paid (no free tier)."""

from __future__ import annotations

import os
from typing import Any

from ._openai_capabilities import capability_for
from ._shared import TEST_BATCH, TEST_CV, parse_json_response
from .base import LLMProvider, ModelInfo, ReasoningCapability

ENDPOINT = "https://api.openai.com/v1/chat/completions"
MODELS_ENDPOINT = "https://api.openai.com/v1/models"

# Same valid-levels surface as the capability map. Used to validate user-
# configured effort before letting it land in a request.
_VALID_EFFORT_LEVELS: frozenset[str] = frozenset({"low", "medium", "high", "xhigh"})


class OpenAIProvider(LLMProvider):
    name = "openai"
    # response_format={"type": "json_schema", strict: true} enforces the
    # schema on gpt-5*, gpt-4.1*, gpt-4o*. Older models silently drop
    # the unknown response_format type — the caller still gets back a
    # parseable JSON object from json_mode fallback.
    supports_structured_output = True

    def __init__(
        self,
        model: str = "gpt-4o-mini",
        *,
        reasoning_effort: str | int | None = None,
    ):
        self.model = model
        # Mirrors the claude_sdk pattern — None/off/unknown all suppress the
        # field at request time. The capability lookup at request time is
        # what decides whether the model even accepts the parameter.
        self.reasoning_effort = reasoning_effort

    def _prompt(self, cv_text: str, batch: list[dict]) -> str:
        from backend.search import _build_batch_prompt

        return _build_batch_prompt(cv_text, batch)

    def _api_key(self) -> str | None:
        return os.environ.get("OPENAI_API_KEY")

    def _effort_for_body(self) -> str | None:
        """Resolved reasoning_effort string, or None to omit from the body.

        Skips when:
          - user left it as None / "off" / "" (silent — that's the user
            choosing to disable);
          - user picked something but the chosen model doesn't actually
            accept reasoning_effort (logged warning, request proceeds);
          - the level isn't in the canonical set (logged warning).
        """
        eff = self.reasoning_effort
        if not isinstance(eff, str):
            return None
        lvl = eff.strip().lower()
        if lvl in ("", "off", "none"):
            return None
        if lvl not in _VALID_EFFORT_LEVELS:
            print(f"    openai: ignoring unknown reasoning_effort={lvl!r}")
            return None
        cap = capability_for(self.model)
        if not cap.supported:
            print(f"    openai: model {self.model!r} does not accept reasoning_effort — omitting")
            return None
        return lvl

    def score_batch(self, cv_text: str, batch: list[dict]) -> list | None:
        key = self._api_key()
        if not key:
            return None
        try:
            import requests
        except Exception:
            print("    openai: requests not installed")
            return None
        prompt = self._prompt(cv_text, batch)
        body: dict[str, Any] = {
            "model": self.model,
            "messages": [
                {
                    "role": "system",
                    "content": f"You score LinkedIn jobs for fit against this CV:\n\n{cv_text}",
                },
                {"role": "user", "content": prompt},
            ],
            "temperature": 0.2,
            "max_tokens": 2048,
            "response_format": {"type": "json_object"},
        }
        # Scoring path deliberately omits reasoning_effort (see #114 default
        # policy — bounded structured-output JSON doesn't benefit).
        headers = {
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        }
        try:
            r = requests.post(ENDPOINT, headers=headers, json=body, timeout=240)
            if r.status_code != 200:
                print(f"    openai http {r.status_code}: {r.text[:200]}")
                return None
            data = r.json()
            choices = data.get("choices") or []
            if not choices:
                print(f"    openai: no choices in response: {str(data)[:200]}")
                return None
            raw = (choices[0].get("message") or {}).get("content") or ""
            parsed = parse_json_response(raw)
            return parsed if isinstance(parsed, list) else None
        except Exception as e:
            print(f"    openai error: {str(e)[:200]}")
            return None

    def test(self) -> tuple[bool, str]:
        key = self._api_key()
        if not key:
            return False, (
                "set OPENAI_API_KEY (https://platform.openai.com/api-keys) — "
                "note: OpenAI has no free tier; cost applies per call"
            )
        try:
            arr = self.score_batch(TEST_CV, TEST_BATCH)
        except Exception as e:
            return False, f"openai error: {e}"
        if isinstance(arr, list) and arr:
            return True, f"openai ok (model={self.model})"
        return False, "openai returned no parseable result"

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
            print("    openai: requests not installed")
            return None
        messages: list[dict] = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})
        body: dict = {
            "model": self.model,
            "messages": messages,
            "temperature": 0.2,
            "max_tokens": max_tokens,
        }
        eff = self._effort_for_body()
        if eff is not None:
            body["reasoning_effort"] = eff
        if json_mode:
            body["response_format"] = {"type": "json_object"}
        headers = {
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        }
        try:
            r = requests.post(ENDPOINT, headers=headers, json=body, timeout=240)
            if r.status_code != 200:
                print(f"    openai http {r.status_code}: {r.text[:200]}")
                return None
            data = r.json()
            choices = data.get("choices") or []
            if not choices:
                print(f"    openai: no choices in response: {str(data)[:200]}")
                return None
            return (choices[0].get("message") or {}).get("content") or ""
        except Exception as e:
            print(f"    openai error: {str(e)[:200]}")
            return None

    def complete_structured(
        self,
        prompt: str,
        *,
        schema: dict,
        schema_name: str = "FilterEnvelope",
        system: str | None = None,
        max_tokens: int = 4096,
    ) -> str | None:
        """OpenAI structured output via response_format=json_schema.

        Available on gpt-5*, gpt-4.1*, gpt-4o* (and the o-series). Older
        models silently ignore the unknown type and produce free-form text;
        we leave that case to the caller's validator since hard-gating per
        model would duplicate the capability map.

        OpenAI's strict JSON Schema flavor requires `additionalProperties:
        false` AND `required: [<all keys>]`. Our schema already declares
        additionalProperties: false at the top level; partial-output
        support means we DON'T set `required` — we instead pass strict=
        false so the model can omit fields the user didn't mention.
        Without strict=false the model would have to invent values for
        every key, which is the opposite of the partial-output contract.
        """
        key = self._api_key()
        if not key:
            return None
        try:
            import requests
        except Exception:
            print("    openai: requests not installed")
            return None
        messages: list[dict] = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})
        body: dict = {
            "model": self.model,
            "messages": messages,
            "temperature": 0.2,
            "max_tokens": max_tokens,
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": schema_name,
                    "schema": schema,
                    # strict=False allows partial output. See docstring.
                    "strict": False,
                },
            },
        }
        eff = self._effort_for_body()
        if eff is not None:
            body["reasoning_effort"] = eff
        headers = {
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        }
        try:
            r = requests.post(ENDPOINT, headers=headers, json=body, timeout=240)
            if r.status_code != 200:
                print(f"    openai structured http {r.status_code}: {r.text[:200]}")
                return None
            data = r.json()
            choices = data.get("choices") or []
            if not choices:
                return None
            return (choices[0].get("message") or {}).get("content") or ""
        except Exception as e:
            print(f"    openai structured error: {str(e)[:200]}")
            return None

    def list_models(self) -> list[ModelInfo]:
        """GET /v1/models — sparse response (id/owned_by only). Cross-
        reference against the in-repo capability map for the reasoning
        surface."""
        key = self._api_key()
        if not key:
            return []
        try:
            import requests
        except Exception:
            return []
        try:
            r = requests.get(
                MODELS_ENDPOINT,
                headers={"Authorization": f"Bearer {key}"},
                timeout=30,
            )
            if r.status_code != 200:
                print(f"    openai list_models http {r.status_code}: {r.text[:200]}")
                return []
            data = r.json()
        except Exception as e:
            print(f"    openai list_models error: {str(e)[:200]}")
            return []
        out: list[ModelInfo] = []
        for entry in data.get("data") or []:
            if not isinstance(entry, dict):
                continue
            mid = str(entry.get("id") or "")
            if not mid:
                continue
            # Live API doesn't expose token windows on this endpoint; the
            # picker falls back to "unknown" rendering for those columns.
            out.append(
                ModelInfo(
                    id=mid,
                    display_name=mid,
                    max_input_tokens=None,
                    max_output_tokens=None,
                    reasoning=capability_for(mid)
                    or ReasoningCapability(supported=False, shape="none"),
                )
            )
        return out
