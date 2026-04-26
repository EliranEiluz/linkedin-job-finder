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

  python3 corpus_ctl.py app-status
      stdin: {"id": "4395..", "status": <one of APP_STATUS_VALUES>,
              "note": <string|null|undefined>}
      Sets job.app_status, appends to app_status_history on transitions, and
      stamps app_status_at. `note` is tri-state: undefined (key absent) =
      don't touch app_notes; null/"" or whitespace-only = clear; non-empty
      string up to 4000 chars = set.
      -> {"ok": true, "id": "...", "status": "...", "app_status_at": "...",
          "history_len": <int>, "app_notes": <string|null>}

  python3 corpus_ctl.py applied-import
      stdin: {"applied_ids": ["4395..", ...]}
      One-shot localStorage→server migration. For each id present in
      results.json with no app_status (or "new"), set app_status="applied",
      append history entry, and stamp app_status_at. Idempotent: rows already
      past "new" are skipped. Empty array is a valid no-op.
      -> {"ok": true, "imported": <int>, "skipped_already_set": <int>,
          "skipped_not_in_corpus": <int>}
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


# ---------- app-status ----------

# 8-stage application pipeline, in display order. Spec authoritative — the
# design doc lists 6, but the user added `take-home` as its own column and
# `new` as the unset/default state used by the import migration.
APP_STATUS_VALUES = (
    "new",
    "applied",
    "screening",
    "interview",
    "take-home",
    "offer",
    "rejected",
    "withdrew",
)
_APP_STATUS_SET = frozenset(APP_STATUS_VALUES)

# Notes can grow over time (recruiter pings, follow-up details, post-interview
# debriefs). Cap higher than the 2000-char rating comment cap.
_APP_NOTES_MAX_CHARS = 4000


def cmd_app_status(_args) -> None:
    """Set the application-pipeline status for one job. Appends an entry to
    app_status_history on actual transitions (no double-log for no-op writes
    of the same status). `note` is tri-state — see module docstring."""
    try:
        body = _read_stdin_json()
    except json.JSONDecodeError as e:
        _emit({"ok": False, "error": f"invalid JSON on stdin: {e}"}, 1)

    if not isinstance(body, dict):
        _emit({"ok": False, "error": "body must be a JSON object"}, 1)

    job_id = body.get("id")
    status = body.get("status")
    _UNSET = object()
    note_in = body.get("note", _UNSET)

    if not isinstance(job_id, str) or not job_id:
        _emit({"ok": False, "error": "id must be a non-empty string"}, 1)
    if not isinstance(status, str) or status not in _APP_STATUS_SET:
        _emit({
            "ok": False,
            "error": (
                "status must be one of: "
                + ", ".join(APP_STATUS_VALUES)
            ),
        }, 1)

    update_note = note_in is not _UNSET
    note_value: str | None = None
    if update_note:
        if note_in is None:
            note_value = None
        elif isinstance(note_in, str):
            stripped = note_in.strip()
            if stripped == "":
                note_value = None
            else:
                if len(stripped) > _APP_NOTES_MAX_CHARS:
                    stripped = stripped[:_APP_NOTES_MAX_CHARS]
                note_value = stripped
        else:
            _emit({"ok": False, "error": "note must be string or null"}, 1)

    now_iso = datetime.now(timezone.utc).isoformat(timespec="seconds")
    found = {"hit": False}
    final_history_len = {"n": 0}
    final_notes: dict[str, str | None] = {"v": None}

    def _mut(current):
        existing = current if isinstance(current, list) else []
        for j in existing:
            if not isinstance(j, dict) or j.get("id") != job_id:
                continue
            found["hit"] = True

            prev_status = j.get("app_status")
            history = j.get("app_status_history")
            if not isinstance(history, list):
                history = []

            # Only append on real transitions — keeps the audit log clean
            # when the UI re-asserts the same status (e.g. drag-drop into
            # the same column).
            if prev_status != status:
                history.append({"status": status, "at": now_iso})
                j["app_status_at"] = now_iso

            j["app_status"] = status
            j["app_status_history"] = history

            if update_note:
                if note_value is None:
                    j.pop("app_notes", None)
                else:
                    j["app_notes"] = note_value

            final_history_len["n"] = len(history)
            final_notes["v"] = j.get("app_notes")
            break
        return existing

    search._atomic_merge_json(search.RESULTS_FILE, _mut)

    if not found["hit"]:
        _emit({"ok": False, "error": f"job id {job_id!r} not found in corpus"}, 1)

    _emit({
        "ok": True,
        "id": job_id,
        "status": status,
        "app_status_at": now_iso,
        "history_len": final_history_len["n"],
        "app_notes": final_notes["v"],
    }, 0)


# ---------- applied-import (one-shot localStorage migration) ----------

_APPLIED_IMPORT_MAX = 10_000  # safety bound on a one-shot bulk migration


def cmd_applied_import(_args) -> None:
    """Bulk-set app_status='applied' for ids that have no app_status yet
    (or are still on the default "new"). Idempotent: rerunning skips ids
    that already advanced past "new"."""
    try:
        body = _read_stdin_json()
    except json.JSONDecodeError as e:
        _emit({"ok": False, "error": f"invalid JSON on stdin: {e}"}, 1)

    if not isinstance(body, dict):
        _emit({"ok": False, "error": "body must be a JSON object"}, 1)

    ids = body.get("applied_ids")
    if not isinstance(ids, list):
        _emit({"ok": False, "error": "applied_ids must be an array of strings"}, 1)
    if not all(isinstance(i, str) and i for i in ids):
        _emit({"ok": False, "error": "applied_ids entries must be non-empty strings"}, 1)
    if len(ids) > _APPLIED_IMPORT_MAX:
        _emit({
            "ok": False,
            "error": f"applied_ids exceeds max of {_APPLIED_IMPORT_MAX}",
        }, 1)

    # Empty array is a valid no-op — early-return without touching the file.
    if not ids:
        _emit({
            "ok": True,
            "imported": 0,
            "skipped_already_set": 0,
            "skipped_not_in_corpus": 0,
        }, 0)

    id_set = set(ids)
    now_iso = datetime.now(timezone.utc).isoformat(timespec="seconds")
    counts = {"imported": 0, "skipped_already_set": 0}
    seen_ids: set[str] = set()

    def _mut(current):
        existing = current if isinstance(current, list) else []
        for j in existing:
            if not isinstance(j, dict):
                continue
            jid = j.get("id")
            if jid not in id_set:
                continue
            seen_ids.add(jid)

            current_status = j.get("app_status")
            # "no app_status" or stuck on the default "new" both qualify.
            if current_status not in (None, "new"):
                counts["skipped_already_set"] += 1
                continue

            history = j.get("app_status_history")
            if not isinstance(history, list):
                history = []
            history.append({"status": "applied", "at": now_iso})
            j["app_status"] = "applied"
            j["app_status_at"] = now_iso
            j["app_status_history"] = history
            counts["imported"] += 1
        return existing

    search._atomic_merge_json(search.RESULTS_FILE, _mut)

    _emit({
        "ok": True,
        "imported": counts["imported"],
        "skipped_already_set": counts["skipped_already_set"],
        "skipped_not_in_corpus": len(id_set - seen_ids),
    }, 0)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("delete").set_defaults(func=cmd_delete)
    sub.add_parser("rate").set_defaults(func=cmd_rate)
    sub.add_parser("app-status").set_defaults(func=cmd_app_status)
    sub.add_parser("applied-import").set_defaults(func=cmd_applied_import)
    args = p.parse_args()
    try:
        args.func(args)
    except Exception as e:
        _emit({"ok": False, "error": f"{type(e).__name__}: {e}"}, 1)


if __name__ == "__main__":
    main()
