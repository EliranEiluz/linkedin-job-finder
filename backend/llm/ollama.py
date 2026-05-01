"""Ollama provider — local model server at http://localhost:11434."""
from __future__ import annotations

import os

from .base import LLMProvider
from ._shared import parse_json_response, TEST_BATCH, TEST_CV

# qwen2.5:32b strikes a fit-vs-RAM balance on a 32GB Mac (~20GB resident).
# Override via config llm_provider.model or OLLAMA_MODEL env.
DEFAULT_MODEL = "qwen2.5:32b"
HOST = os.environ.get("OLLAMA_HOST", "http://localhost:11434")


class OllamaProvider(LLMProvider):
    name = "ollama"

    def __init__(self, model: str | None = None):
        self.model = model or os.environ.get("OLLAMA_MODEL") or DEFAULT_MODEL

    def _prompt(self, cv_text: str, batch: list[dict]) -> str:
        from backend.search import _build_batch_prompt
        return _build_batch_prompt(cv_text, batch)

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
                {"role": "system",
                 "content": f"You score LinkedIn jobs for fit against this CV:\n\n{cv_text}"},
                {"role": "user", "content": prompt},
            ],
            "stream": False,
            "format": "json",
            "options": {"temperature": 0.2},
        }
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
                return False, f"ollama up but model '{self.model}' not pulled — `ollama pull {self.model}`"
        except Exception:
            pass
        try:
            arr = self.score_batch(TEST_CV, TEST_BATCH)
        except Exception as e:
            return False, f"ollama error: {e}"
        if isinstance(arr, list) and arr:
            return True, f"ollama ok (model={self.model})"
        return False, "ollama returned no parseable result"
