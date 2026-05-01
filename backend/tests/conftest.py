"""Shared pytest fixtures for the backend test suite.

Two responsibilities:

1. Make the bare-name `import search`, `import _common`, `import corpus_ctl`,
   etc. work from any test_*.py without per-file sys.path shims. The ctl
   scripts at runtime do the same `sys.path.insert` dance themselves; the
   tests re-do it once here so the modules resolve identically whether
   imported as `backend.search` or as plain `search`.

2. Provide `tmp_repo` — a per-test temp directory wired up to look like a
   project root, with `search.RESULTS_FILE` / `SEEN_FILE` / `RUN_HISTORY_FILE`
   redirected at it. NEVER touches the real corpus.

3. Provide `run_ctl` — a small helper for invoking ctl scripts as
   subprocesses with stdin payloads, returning (exit_code, stdout_dict,
   stderr_text). Used by every ctl-level test.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

HERE = Path(__file__).resolve().parent  # backend/tests/
BACKEND = HERE.parent  # backend/
ROOT = BACKEND.parent  # repo root

# Match the runtime sys.path that ctl scripts set up themselves. We do this
# at import time so module-level `import search` / `import corpus_ctl` calls
# inside test files resolve before any fixture runs.
for p in (str(ROOT), str(BACKEND), str(BACKEND / "ctl")):
    if p not in sys.path:
        sys.path.insert(0, p)


@pytest.fixture
def tmp_repo(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Per-test repo-root sandbox.

    Redirects `backend.search` module-level paths (RESULTS_FILE, SEEN_FILE,
    RUN_HISTORY_FILE, SESSION_FILE, CONFIG_FILE) into `tmp_path` so the test
    can call high-level helpers (`save_results_merge`, `load_seen`, etc.)
    without ever touching the real on-disk corpus.

    Returns the tmp_path so the test can read/write files there directly
    if it wants to seed state.
    """
    import search  # noqa: PLC0415 — bare-name import via sys.path shim above

    monkeypatch.setattr(search, "RESULTS_FILE", tmp_path / "results.json")
    monkeypatch.setattr(search, "SEEN_FILE", tmp_path / "seen_jobs.json")
    monkeypatch.setattr(search, "RUN_HISTORY_FILE", tmp_path / "run_history.json")
    monkeypatch.setattr(search, "SESSION_FILE", tmp_path / "linkedin_session.json")
    monkeypatch.setattr(search, "CONFIG_FILE", tmp_path / "config.json")
    monkeypatch.setattr(search, "DEFAULTS_FILE", tmp_path / "defaults.json")
    monkeypatch.setattr(search, "ROOT", tmp_path)
    monkeypatch.setattr(search, "CV_FILE", tmp_path / "cv.txt")
    return tmp_path


@pytest.fixture
def run_ctl(tmp_path: Path):
    """Subprocess runner for ctl scripts.

    Critical: the ctl scripts hardcode ROOT = `Path(__file__).resolve().parent.parent.parent`
    so they always write into the repo root regardless of cwd. To keep tests
    hermetic we materialize a fake-repo layout under `tmp_path` (a `backend/`
    tree mirroring the real one), copy the ctl + its deps into it, and spawn
    that copy. The script's ROOT then resolves to `tmp_path`.

    Usage:
        rc, out, err = run_ctl("corpus_ctl.py", ["delete"], {"ids": ["123"]})

    Args:
        script: filename under backend/ctl/ (e.g. "corpus_ctl.py")
        argv:   list of argparse args (e.g. ["delete"] or ["set-interval", "60"])
        stdin_payload: dict to JSON-encode and pipe to stdin, or None for no stdin,
                       or bytes/str to send raw.
        cwd: working directory; defaults to tmp_path itself.
        timeout: subprocess timeout seconds (default 30).
        extra_files: dict of {relpath: text} to seed in the fake repo before
                     the spawn (e.g. {"cv.txt": "my CV"}).

    Returns: (returncode, parsed-stdout-dict-or-raw-text, stderr).
    """
    import shutil

    # Materialize the minimal directory tree the ctl scripts assume:
    # tmp_path/backend/ctl/  + tmp_path/backend/llm/ + tmp_path/backend/search.py
    # (plus _common, the scheduler package, and probes/tools so any imports succeed).
    fake_backend = tmp_path / "backend"
    fake_backend.mkdir(exist_ok=True)
    fake_ctl = fake_backend / "ctl"
    if not fake_ctl.exists():
        shutil.copytree(BACKEND / "ctl", fake_ctl)
    # Copy single files (search.py + send_email.py) and the llm package.
    for fname in ("search.py", "send_email.py", "run.py"):
        src = BACKEND / fname
        if src.exists() and not (fake_backend / fname).exists():
            shutil.copy2(src, fake_backend / fname)
    if not (fake_backend / "llm").exists():
        shutil.copytree(BACKEND / "llm", fake_backend / "llm")
    # Empty package marker so `import backend.X` works.
    (fake_backend / "__init__.py").touch(exist_ok=True)

    def _run(
        script: str,
        argv: list[str] | None = None,
        stdin_payload: dict | bytes | str | None = None,
        cwd: Path | None = None,
        timeout: int = 30,
        extra_files: dict[str, str] | None = None,
    ) -> tuple[int, Any, str]:
        argv = argv or []
        script_path = fake_ctl / script
        if not script_path.exists():
            raise FileNotFoundError(script_path)

        for relpath, contents in (extra_files or {}).items():
            (tmp_path / relpath).parent.mkdir(parents=True, exist_ok=True)
            (tmp_path / relpath).write_text(contents)

        if stdin_payload is None:
            stdin_bytes: bytes | None = None
        elif isinstance(stdin_payload, bytes):
            stdin_bytes = stdin_payload
        elif isinstance(stdin_payload, str):
            stdin_bytes = stdin_payload.encode("utf-8")
        else:
            stdin_bytes = json.dumps(stdin_payload).encode("utf-8")

        # PYTHONPATH so `from backend.llm` etc. resolve from the tmp tree.
        env = dict(os.environ)
        env["PYTHONPATH"] = str(tmp_path) + os.pathsep + env.get("PYTHONPATH", "")
        # Strip HOME-leaking env vars that might point real tests at a real
        # ~/.linkedin-jobs.env file (llm_ctl writes there). Tests that need
        # them re-set explicitly via extra_files.
        env["HOME"] = str(tmp_path)

        proc = subprocess.run(
            [sys.executable, str(script_path), *argv],
            input=stdin_bytes,
            capture_output=True,
            timeout=timeout,
            cwd=str(cwd) if cwd else str(tmp_path),
            env=env,
        )
        stdout_text = proc.stdout.decode("utf-8", errors="replace")
        stderr_text = proc.stderr.decode("utf-8", errors="replace")
        try:
            stdout_obj: Any = json.loads(stdout_text) if stdout_text.strip() else {}
        except json.JSONDecodeError:
            stdout_obj = stdout_text
        return proc.returncode, stdout_obj, stderr_text

    return _run


@pytest.fixture
def sample_job() -> dict:
    """A representative job dict shaped like what search.py produces.
    Tests that mutate it should `dict(sample_job)` first to avoid cross-test bleed."""
    return {
        "id": "4395123456",
        "title": "Senior Software Engineer",
        "company": "Acme Corp",
        "location": "Remote",
        "url": "https://www.linkedin.com/jobs/view/4395123456/",
        "query": "software engineer",
        "category": "keyword",
        "category_name": "Keywords",
        "found_at": "2026-04-15T10:00:00",
        "priority": False,
        "msc_required": False,
        "fit": None,
        "score": None,
        "fit_reasons": [],
        "scored_by": None,
    }
