#!/usr/bin/env python3
"""
Corpus mutation CLI for the LinkedIn jobs scraper. Wraps `results.json` and
`seen_jobs.json` with stable JSON commands the UI's Vite middleware shells to.

Same conventions as scheduler_ctl.py / profile_ctl.py / onboarding_ctl.py:
each command reads JSON from stdin, emits a single JSON envelope on stdout,
exit 0 on success / 1 on validation or IO error.

Commands:
  python3 corpus_ctl.py delete
      stdin: {"ids": ["4395..", ...]}
      Removes those jobs from results.json (atomic fcntl-merge) and ADDS
      their ids to seen_jobs.json so future scrapes don't re-add them.
      -> {"ok": true, "deleted": <int>, "missing": [...], "kept_in_seen": <int>}

  python3 corpus_ctl.py rate
      stdin: {"id": "4395..", "rating": 1..5 | null}
      Sets job.rating in results.json. `null` clears any existing rating.
      -> {"ok": true, "id": "...", "rating": <int|null>}
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

# Add backend/ to sys.path so we can import sibling `search` module.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import search  # noqa: E402 — needs the path shim above


def _read_stdin_json() -> dict:
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    return json.loads(raw)


def _emit(obj: dict, code: int = 0):
    print(json.dumps(obj, indent=2, ensure_ascii=False))
    sys.exit(code)


# ---------- delete ----------

def cmd_delete(_args) -> None:
    try:
        body = _read_stdin_json()
    except json.JSONDecodeError as e:
        _emit({"ok": False, "error": f"invalid JSON on stdin: {e}"}, 1)
    ids = body.get("ids") if isinstance(body, dict) else None
    if (not isinstance(ids, list)
            or len(ids) == 0
            or not all(isinstance(i, str) and i for i in ids)):
        _emit({"ok": False, "error": "ids must be a non-empty array of strings"}, 1)
    id_set = set(ids)

    deleted = {"n": 0}
    missing = list(id_set)

    def _mut_results(current):
        out = []
        existing = current if isinstance(current, list) else []
        for j in existing:
            if isinstance(j, dict) and j.get("id") in id_set:
                deleted["n"] += 1
                if j["id"] in missing:
                    missing.remove(j["id"])
                continue
            out.append(j)
        return out

    search._atomic_merge_json(search.RESULTS_FILE, _mut_results)

    # Also pin them in seen_jobs.json so future scrapes don't re-add them.
    def _mut_seen(current):
        existing = set(current or [])
        existing |= id_set
        return sorted(existing)

    search._atomic_merge_json(search.SEEN_FILE, _mut_seen)

    _emit({
        "ok": True,
        "deleted": deleted["n"],
        "missing": sorted(missing),
        "kept_in_seen": len(id_set),
    }, 0)


# ---------- rate ----------

_COMMENT_MAX_CHARS = 2000


def cmd_rate(_args) -> None:
    """Set the user's rating and/or comment on a job, with a `rated_at`
    timestamp updated on every mutation. Rating and comment are independent —
    you can clear one while keeping the other."""
    try:
        body = _read_stdin_json()
    except json.JSONDecodeError as e:
        _emit({"ok": False, "error": f"invalid JSON on stdin: {e}"}, 1)

    if not isinstance(body, dict):
        _emit({"ok": False, "error": "body must be a JSON object"}, 1)

    job_id = body.get("id")
    rating = body.get("rating")
    comment_in = body.get("comment", _UNSET := object())

    if not isinstance(job_id, str) or not job_id:
        _emit({"ok": False, "error": "id must be a non-empty string"}, 1)
    if rating is not None and not (isinstance(rating, int) and 1 <= rating <= 5):
        _emit({"ok": False, "error": "rating must be int 1..5 or null"}, 1)

    # Comment normalization: undefined → don't touch field; null / "" → delete;
    # str → store (truncated to cap). Everything else rejected.
    update_comment = comment_in is not _UNSET
    comment_value: str | None = None
    if update_comment:
        if comment_in is None:
            comment_value = None
        elif isinstance(comment_in, str):
            stripped = comment_in.strip()
            if stripped == "":
                comment_value = None
            else:
                comment_value = stripped[:_COMMENT_MAX_CHARS]
        else:
            _emit({"ok": False, "error": "comment must be string or null"}, 1)

    rated_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    found = {"hit": False}

    def _mut(current):
        existing = current if isinstance(current, list) else []
        for j in existing:
            if isinstance(j, dict) and j.get("id") == job_id:
                if rating is None:
                    j.pop("rating", None)
                else:
                    j["rating"] = rating
                if update_comment:
                    if comment_value is None:
                        j.pop("comment", None)
                    else:
                        j["comment"] = comment_value
                # Touch rated_at on any mutation — useful for the future
                # tracker's "stale rating" sort and the few-shot loop.
                j["rated_at"] = rated_at
                found["hit"] = True
                break
        return existing

    search._atomic_merge_json(search.RESULTS_FILE, _mut)

    if not found["hit"]:
        _emit({"ok": False, "error": f"job id {job_id!r} not found in corpus"}, 1)
    _emit({
        "ok": True, "id": job_id, "rating": rating,
        "comment": comment_value if update_comment else None,
        "rated_at": rated_at,
    }, 0)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("delete").set_defaults(func=cmd_delete)
    sub.add_parser("rate").set_defaults(func=cmd_rate)
    args = p.parse_args()
    try:
        args.func(args)
    except Exception as e:
        _emit({"ok": False, "error": f"{type(e).__name__}: {e}"}, 1)


if __name__ == "__main__":
    main()
