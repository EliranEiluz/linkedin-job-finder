"""Ollama provider — local model server at http://localhost:11434."""

from __future__ import annotations

import os

from ._shared import TEST_BATCH, TEST_CV, parse_json_response
from .base import LLMProvider, ModelInfo, ReasoningCapability

# qwen2.5:32b strikes a fit-vs-RAM balance on a 32GB Mac (~20GB resident).
# Override via config llm_provider.model or OLLAMA_MODEL env.
DEFAULT_MODEL = "qwen2.5:32b"
HOST = os.environ.get("OLLAMA_HOST", "http://localhost:11434")

# Name prefixes of known "thinking" families. Ollama doesn't enumerate this
# in /api/tags so we keep a small table; the picker uses this to render the
# on/off toggle vs hiding the control entirely.
_THINKING_MODEL_PREFIXES: tuple[str, ...] = (
    "deepseek-r1",
    "qwen3",
    # qwq is qwen2.5's reasoning sibling; users with that pulled also benefit.
    "qwq",
)


def _is_thinking_model(model_id: str) -> bool:
    """True if the model id (with or without :tag) looks like one of the
    known reasoning families."""
    if not model_id:
        return False
    base = model_id.split(":", 1)[0].lower()
    return any(base.startswith(p) for p in _THINKING_MODEL_PREFIXES)


class OllamaProvider(LLMProvider):
    name = "ollama"

    def __init__(
        self,
        model: str | None = None,
        *,
        reasoning_effort: bool | str | int | None = None,
    ):
        self.model = model or os.environ.get("OLLAMA_MODEL") or DEFAULT_MODEL
        # Ollama treats reasoning as a boolean `think` parameter. Accept
        # True/False directly; also accept stringy "off"/"low"/... and
        # resolve to a bool (low/medium/high → True; off → False).
        self.reasoning_effort = reasoning_effort

    def _prompt(self, cv_text: str, batch: list[dict]) -> str:
        from backend.search import _build_batch_prompt

        return _build_batch_prompt(cv_text, batch)

    def _think_flag(self) -> bool | None:
        """Resolve the configured effort into a `think` boolean, or None to
        omit the field. Returns None when the model isn't a known thinking
        family OR the user disabled it OR config wasn't set."""
        if not _is_thinking_model(self.model):
            return None
        eff = self.reasoning_effort
        if eff is None:
            return None
        if isinstance(eff, bool):
            return eff
        if isinstance(eff, str):
            lvl = eff.strip().lower()
            return lvl not in ("", "off", "none", "false", "0")
        # int 0 → off; anything else → on. Mirrors the Gemini "0 budget" idea.
        if isinstance(eff, int):
            return bool(eff)
        return None

    def score_batch(self, cv_text: str, batch: list[dict]) -> list | None:
        try:
            import requests
        except Exception:
            print("    ollama: requests not installed")
            return None
        prompt = self._prompt(cv_text, batch)
        body = {
            "model": self.model,
            "messages": [
                {
                    "role": "system",
                    "content": f"You score LinkedIn jobs for fit against this CV:\n\n{cv_text}",
                },
                {"role": "user", "content": prompt},
            ],
            "stream": False,
            "format": "json",
            "options": {"temperature": 0.2},
        }
        # Scoring path deliberately omits `think` even on thinking models —
        # bounded JSON, see #114 policy. complete() honors the config.
        try:
            r = requests.post(f"{HOST}/api/chat", json=body, timeout=600)
            if r.status_code != 200:
                print(f"    ollama http {r.status_code}: {r.text[:200]}")
                return None
            data = r.json()
            raw = (data.get("message") or {}).get("content") or ""
            parsed = parse_json_response(raw)
            return parsed if isinstance(parsed, list) else None
        except Exception as e:
            print(f"    ollama error: {str(e)[:200]}")
            return None

    def test(self) -> tuple[bool, str]:
        try:
            import requests
        except Exception:
            return False, "requests not installed"
        try:
            r = requests.get(f"{HOST}/api/tags", timeout=5)
        except Exception as e:
            return False, f"ollama not reachable at {HOST} ({e}) — `ollama serve`"
        if r.status_code != 200:
            return False, f"ollama /api/tags http {r.status_code}"
        # Confirm the model is actually pulled.
        try:
            tags = r.json().get("models") or []
            names = {(m.get("name") or "").split(":")[0] for m in tags}
            wanted = self.model.split(":")[0]
            if wanted not in names:
                return (
                    False,
                    f"ollama up but model '{self.model}' not pulled — `ollama pull {self.model}`",
                )
        except Exception:
            pass
        try:
            arr = self.score_batch(TEST_CV, TEST_BATCH)
        except Exception as e:
            return False, f"ollama error: {e}"
        if isinstance(arr, list) and arr:
            return True, f"ollama ok (model={self.model})"
        return False, "ollama returned no parseable result"

    def complete(
        self,
        prompt: str,
        *,
        system: str | None = None,
        max_tokens: int = 4096,
        json_mode: bool = False,
    ) -> str | None:
        try:
            import requests
        except Exception:
            print("    ollama: requests not installed")
            return None
        messages: list[dict] = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})
        body: dict = {
            "model": self.model,
            "messages": messages,
            "stream": False,
            # num_predict is Ollama's max-tokens analogue.
            "options": {"temperature": 0.2, "num_predict": max_tokens},
        }
        think = self._think_flag()
        if think is not None:
            body["think"] = think
        if json_mode:
            body["format"] = "json"
        try:
            r = requests.post(f"{HOST}/api/chat", json=body, timeout=600)
            if r.status_code != 200:
                print(f"    ollama http {r.status_code}: {r.text[:200]}")
                return None
            data = r.json()
            return (data.get("message") or {}).get("content") or ""
        except Exception as e:
            print(f"    ollama error: {str(e)[:200]}")
            return None

    def list_models(self) -> list[ModelInfo]:
        """GET /api/tags — the local catalog of pulled models. We don't
        enumerate the full Ollama registry; the user has to `ollama pull`
        a model first."""
        try:
            import requests
        except Exception:
            return []
        try:
            r = requests.get(f"{HOST}/api/tags", timeout=5)
            if r.status_code != 200:
                print(f"    ollama list_models http {r.status_code}: {r.text[:200]}")
                return []
            data = r.json()
        except Exception as e:
            print(f"    ollama list_models error: {str(e)[:200]}")
            return []
        out: list[ModelInfo] = []
        for m in data.get("models") or []:
            if not isinstance(m, dict):
                continue
            mid = str(m.get("name") or "")
            if not mid:
                continue
            reasoning = (
                ReasoningCapability(supported=True, shape="boolean")
                if _is_thinking_model(mid)
                else ReasoningCapability(supported=False, shape="none")
            )
            # /api/tags doesn't expose context length; the picker shows
            # "unknown" for that column.
            out.append(
                ModelInfo(
                    id=mid,
                    display_name=mid,
                    max_input_tokens=None,
                    max_output_tokens=None,
                    reasoning=reasoning,
                )
            )
        return out
