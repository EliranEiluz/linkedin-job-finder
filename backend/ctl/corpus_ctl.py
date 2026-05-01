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

  python3 corpus_ctl.py add-manual
      stdin: {"url_or_id": "<LinkedIn URL or 8–12 digit job id>"}
      Ingests a single job through the same pipeline a scraped row gets
      (title pre-filter -> guest description fetch -> Claude scoring with
      regex fallback -> atomic merge into results.json + seen_jobs.json).
      Tags the row with `source: "manual"` + `manual_added_at: <ISO>`.
      Does NOT push to run_history.json (manual adds aren't time-windowed
      scrape runs).
      -> success:    {"ok": true, "id": "...", "title": "...", "company": "...",
                      "fit": "...", "score": ..., "scored_by": "...", ...}
         duplicate:  {"ok": false, "error": "already in corpus",
                      "existing_id": "..."}      (exit 1; HTTP layer maps -> 409)
         parse fail: {"ok": false, "error": "could not extract job ID..."}
"""

from __future__ import annotations

import argparse
import contextlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlparse

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


# search.py prints status / progress to stdout (e.g. "Scoring batch 1/3...",
# "↳ guest classification: real=…"). For ctl-style invocations stdout is
# reserved for the final JSON envelope — anything else breaks the vite
# middleware's JSON.parse. Wrap any block that calls into search.* heavy
# pipelines with this context manager so stray prints land on stderr (still
# visible in the spawn log) instead of corrupting stdout.
def _silence_stdout() -> contextlib.AbstractContextManager[object]:
    return contextlib.redirect_stdout(sys.stderr)


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


# ---------- add-manual (single-URL ingest through process_one_job) ----------

# LinkedIn job ids are 8–12 digit numerics. Matches the patterns documented
# in DESIGN_TRACKING.md sec.4 and verified against current LinkedIn surfaces:
#   /jobs/view/4395123456/                                  → trailing digits
#   /jobs/view/staff-eng-foo-at-bar-4395123456?refId=...    → last `-` segment
#   /jobs/search/?currentJobId=4395123456                   → query param
#   /jobs/search-results/?currentJobId=4395123456           → query param
#   4395123456                                              → bare ID
_BARE_ID_RE = re.compile(r"^\d{8,12}$")
_JOBVIEW_RE = re.compile(r"/jobs/view/(?:[^/?#]*-)?(\d{8,12})")
_URL_OR_ID_MAX_CHARS = 500


def extract_job_id(s: str) -> str | None:
    """Return the LinkedIn job id (string of digits) from a URL or bare id,
    or None if no recognised pattern matches.

    Accepts the full set of LinkedIn URL families plus a bare numeric id.
    Does not contact the network — pure parsing.
    """
    s = (s or "").strip()
    if not s:
        return None
    if _BARE_ID_RE.match(s):
        return s
    # urllib.parse refuses scheme-less inputs cleanly, so synth one.
    if not s.lower().startswith(("http://", "https://")):
        s = "https://" + s.lstrip("/")
    try:
        u = urlparse(s)
    except Exception:
        return None
    netloc = (u.netloc or "").lower()
    if "linkedin.com" not in netloc:
        return None
    # ?currentJobId=... wins (search-results pane).
    qs = parse_qs(u.query or "")
    cur = (qs.get("currentJobId") or [None])[0]
    if cur and cur.isdigit() and 8 <= len(cur) <= 12:
        return cur
    # /jobs/view/<slug>-<id>/ or /jobs/view/<id>/
    m = _JOBVIEW_RE.search(u.path or "")
    return m.group(1) if m else None


def cmd_add_manual(_args) -> None:
    """Ingest a single user-typed LinkedIn job URL or bare id.

    Walks the same per-job pipeline a scraped row gets — title pre-filter,
    description fetch (guest endpoint; no browser, no session needed),
    Claude scoring (with regex fallback on Claude failure), atomic merge
    into results.json + seen_jobs.json. The only distinguishing mark is
    `source: "manual"` + `manual_added_at: <ISO>` on the persisted row.

    Stdin:  {"url_or_id": "<URL or bare numeric id>"}
    Stdout: success    -> {ok: true, id, title, company, fit, score, ...}
            duplicate  -> {ok: false, error: "already in corpus", existing_id}
            parse fail -> {ok: false, error: "could not extract job ID..."}
    Exit:   0 on success, 1 on validation/dedup/runtime failure.

    Run-history is intentionally NOT touched — manual adds aren't time-windowed
    scrape runs.
    """
    try:
        body = _read_stdin_json()
    except json.JSONDecodeError as e:
        _emit({"ok": False, "error": f"invalid JSON on stdin: {e}"}, 1)

    if not isinstance(body, dict):
        _emit({"ok": False, "error": "body must be a JSON object"}, 1)

    raw = body.get("url_or_id")
    if not isinstance(raw, str):
        _emit({"ok": False, "error": "url_or_id must be a string"}, 1)
    if not raw.strip():
        _emit({"ok": False, "error": "url_or_id must not be empty"}, 1)
    if len(raw) > _URL_OR_ID_MAX_CHARS:
        _emit({
            "ok": False,
            "error": f"url_or_id exceeds max of {_URL_OR_ID_MAX_CHARS} chars",
        }, 1)

    job_id = extract_job_id(raw)
    if not job_id:
        _emit({
            "ok": False,
            "error": "could not extract job ID from input",
        }, 1)

    # Dedupe against the on-disk corpus first — short-circuits before we
    # spend a network round-trip + Claude call on a job we already have.
    try:
        existing = search.load_results()
    except Exception as e:
        _emit({"ok": False, "error": f"failed to read results.json: {e}"}, 1)

    for row in existing:
        if isinstance(row, dict) and row.get("id") == job_id:
            _emit({
                "ok": False,
                "error": "already in corpus",
                "existing_id": job_id,
            }, 1)

    # Build the stub. Title/company/location are filled in by the guest
    # detail endpoint when fetch_description_guest hits LinkedIn — see
    # below; we leave them blank here so the scoring stage sees a clean
    # row when LinkedIn's detail page omits one of them.
    now_iso = datetime.now().isoformat()
    stub = {
        "id": job_id,
        "title": "",
        "company": "",
        "location": "",
        "url": f"https://www.linkedin.com/jobs/view/{job_id}/",
        "query": "",
        "category": "manual",
        "category_name": "Manual",
        "found_at": now_iso,
        "priority": False,
        "msc_required": None,
        "fit": None,
        "fit_reasons": [],
        "source": "manual",
        "manual_added_at": now_iso,
    }

    # Pull title/company from LinkedIn's detail HTML so the row is more than
    # a numeric-ID placeholder. The guest detail endpoint serves the same
    # block of HTML the scraper's description fetcher already consumes — we
    # just additionally extract the H1 + company anchor before delegating
    # the lower-level fetch to the canonical helper inside process_one_job.
    session = search._guest_session()

    def _populate_stub_metadata(html: str) -> None:
        """Best-effort title/company/location scrape from the guest detail
        HTML. Quietly leaves fields blank if LinkedIn changes the markup."""
        try:
            from bs4 import BeautifulSoup  # local import: same as search.py
            soup = BeautifulSoup(html, "html.parser")
            if not stub["title"]:
                t_el = (
                    soup.select_one("h1.top-card-layout__title")
                    or soup.select_one(".topcard__title")
                    or soup.select_one("h1")
                )
                if t_el:
                    stub["title"] = search._clean_title(
                        t_el.get_text(strip=True) or ""
                    )
            if not stub["company"]:
                c_el = (
                    soup.select_one("a.topcard__org-name-link")
                    or soup.select_one(".topcard__flavor")
                    or soup.select_one(".top-card-layout__second-subline a")
                )
                if c_el:
                    stub["company"] = (c_el.get_text(strip=True) or "").strip()
            if not stub["location"]:
                l_el = soup.select_one(".topcard__flavor--bullet")
                if l_el:
                    stub["location"] = (
                        l_el.get_text(strip=True) or ""
                    ).strip()
        except Exception:
            pass

    def _fetch_one(_job):
        """Single-job fetch closure consumed by process_one_job. Mirrors
        fetch_description_guest's contract (returns (text_lower, diag))
        but additionally scrapes the H1/company/location into the stub
        from the same response so we don't pay two round-trips."""
        url = search.GUEST_DETAIL_URL.format(job_id=_job["id"])
        try:
            r = session.get(url, timeout=15)
        except Exception as e:
            return "", f"error:{str(e)[:60]}"
        if r.status_code == 429:
            return "", "rate-limited"
        if r.status_code != 200:
            return "", f"http-{r.status_code}"
        html = r.text or ""
        if not html.strip():
            return "", "empty"
        _populate_stub_metadata(html)
        try:
            from bs4 import BeautifulSoup
            soup = BeautifulSoup(html, "html.parser")
            desc_el = (
                soup.select_one(".description__text")
                or soup.select_one(".show-more-less-html__markup")
                or soup.select_one("[class*='description__text']")
                or soup.select_one("[class*='show-more-less-html']")
            )
            text = (
                search._strip_html(desc_el.decode_contents())
                if desc_el else search._strip_html(html)
            )
        except Exception:
            text = search._strip_html(html)
        if len(text) < 80:
            return text.lower(), "empty"
        return text.lower(), "ok"

    # search.py status prints would corrupt our JSON envelope on stdout —
    # redirect stdout to stderr for the whole pipeline body.
    with _silence_stdout():
        cv_text = search._load_cv_text()

        # Run the same per-job pipeline a scraped row gets. process_one_job
        # walks: title-filter -> fetch -> Claude (single-item) -> regex
        # fallback -> atomic-merge persist. On Claude failure / empty desc,
        # the row is still persisted with whatever scoring fell out (regex /
        # title-filter / null) — never lost. See
        # backend/search.py:process_one_job docstring.
        try:
            result = search.process_one_job(
                stub,
                cv_text=cv_text,
                fetch_one=_fetch_one,
                persist=True,
                already_scored=False,
            )
        except Exception as e:
            # Stash the error and exit the redirect block before _emit.
            result = None
            err_text = f"pipeline failure: {type(e).__name__}: {e}"
        else:
            err_text = None

    if err_text is not None:
        _emit({"ok": False, "error": err_text}, 1)
    assert result is not None  # for type-checker — _emit on None path exited

    _emit({
        "ok": True,
        "id": result.get("id"),
        "title": result.get("title"),
        "company": result.get("company"),
        "location": result.get("location"),
        "fit": result.get("fit"),
        "score": result.get("score"),
        "scored_by": result.get("scored_by"),
        "fit_reasons": result.get("fit_reasons", []),
        "source": result.get("source"),
        "manual_added_at": result.get("manual_added_at"),
    }, 0)


def cmd_push_to_end(_args) -> None:
    """Set / clear `pushed_to_end` on a list of corpus rows.

    Used by the Corpus tab's per-row + bulk "Move to end" action — for
    jobs the user wants to demote without marking applied. Persisted on
    the row so the override survives reloads and syncs across devices.

    Stdin:  {"ids": [...], "pushed": true|false}
    Stdout: {"ok": true, "updated": <int>, "missing": [...]}
    """
    try:
        body = _read_stdin_json()
    except json.JSONDecodeError as e:
        _emit({"ok": False, "error": f"invalid JSON on stdin: {e}"}, 1)

    if not isinstance(body, dict):
        _emit({"ok": False, "error": "body must be a JSON object"}, 1)

    ids = body.get("ids")
    pushed = body.get("pushed")
    if not isinstance(ids, list) or not ids:
        _emit({"ok": False, "error": "ids must be a non-empty array"}, 1)
    if not isinstance(pushed, bool):
        _emit({"ok": False, "error": "pushed must be a boolean"}, 1)
    ids = [str(i) for i in ids]

    target_ids = set(ids)
    updated = {"n": 0}
    missing_seen = set(ids)

    def _mutate(current):
        rows = current or []
        for r in rows:
            if not isinstance(r, dict):
                continue
            rid = r.get("id")
            if rid in target_ids:
                missing_seen.discard(rid)
                if pushed:
                    if r.get("pushed_to_end") is not True:
                        r["pushed_to_end"] = True
                        updated["n"] += 1
                else:
                    if r.get("pushed_to_end") is True:
                        r["pushed_to_end"] = None
                        updated["n"] += 1
        return rows

    try:
        search._atomic_merge_json(search.RESULTS_FILE, _mutate)
    except Exception as e:
        _emit({"ok": False, "error": f"failed to update results.json: {e}"}, 1)

    _emit({
        "ok": True,
        "updated": updated["n"],
        "missing": sorted(missing_seen),
    }, 0)


def cmd_rescore(_args) -> None:
    """Re-run the scoring pipeline on a list of existing corpus jobs.

    Used by the Corpus tab's bulk "Re-score" button — when the user wants
    to give Claude another shot at a row that fell back to regex (e.g.
    after a Claude CLI timeout, rate-limit, or after the user updated the
    scoring prompt or their CV).

    Stdin:  {"ids": ["<job_id>", ...]}
    Stdout: {"ok": true, "rescored": <int>, "failed": <int>, "missing": [...]}

    For each id, re-fetches the description (LinkedIn detail endpoint),
    runs Claude single-item scoring, falls back to regex on Claude error,
    and atomic-merges the updated row back into results.json. The row's
    other fields (rating, comment, app_status, etc.) are preserved —
    process_one_job mutates the existing dict in place.
    """
    try:
        body = _read_stdin_json()
    except json.JSONDecodeError as e:
        _emit({"ok": False, "error": f"invalid JSON on stdin: {e}"}, 1)

    ids = body.get("ids") if isinstance(body, dict) else None
    if not isinstance(ids, list) or not ids:
        _emit({"ok": False, "error": "ids must be a non-empty array"}, 1)
    ids = [str(i) for i in ids]

    try:
        existing = search.load_results()
    except Exception as e:
        _emit({"ok": False, "error": f"failed to read results.json: {e}"}, 1)

    by_id = {r.get("id"): r for r in existing if isinstance(r, dict)}
    targets = []
    missing = []
    for jid in ids:
        row = by_id.get(jid)
        if row is None:
            missing.append(jid)
        else:
            targets.append(row)

    if not targets:
        _emit({
            "ok": True, "rescored": 0, "failed": 0, "missing": missing,
        }, 0)

    # search.py status prints would corrupt our JSON envelope on stdout —
    # redirect stdout to stderr for the whole pipeline body.
    with _silence_stdout():
        # Reuse the guest-mode session + fetch helper. process_one_job will
        # call this once per target. No browser, no LinkedIn auth needed.
        session = search._guest_session()

        def _fetch_one(job):
            return search.fetch_description_guest(session, job["id"])

        cv_text = search._load_cv_text()

        # Use the SAME batched Claude path the scraper main loop uses
        # (search.py:score_jobs_in_batches, BATCH_SIZE=8) instead of looping
        # process_one_job per row. Per-job calls were ~30s each; batched is
        # one Claude call per 8 jobs and far less likely to hit per-call
        # timeouts or rate-limits.
        #
        # Steps:
        #  1. Snapshot pre-state (for the regex-fallback no-op detection).
        #  2. Reset score-derived fields so the scorer sees a clean slate.
        #  3. Per-job description fetch (sequential — LinkedIn rate-limits).
        #     Title pre-filter still runs first via process_one_job's stage 1
        #     equivalent inline here so off-topic rows don't waste a Claude
        #     slot in the batch.
        #  4. Batch-score what's left through Claude.
        #  5. _compute_hot per row (single source of truth — same as scraper).
        #  6. Atomic-merge persist all targets in one write.
        pre_scored_by = {j.get("id"): j.get("scored_by") for j in targets}

        title_filtered: list[dict] = []
        for job in targets:
            for k in ("fit", "score", "fit_reasons", "scored_by", "msc_required"):
                job[k] = None if k != "fit_reasons" else []
            # Stage 1: title pre-filter (priority companies bypass).
            reason = search.is_obviously_offtopic(job.get("title") or "")
            if reason and not job.get("priority"):
                job["fit"] = "skip"
                job["score"] = 1
                job["fit_reasons"] = [f"title: matches /{reason}/"]
                job["scored_by"] = "title-filter"
                job["scored_at"] = datetime.now().isoformat()
                title_filtered.append(job)
                continue
            # Stage 2: description fetch.
            try:
                desc, diag = _fetch_one(job)
            except Exception as e:
                desc, diag = "", f"error:{type(e).__name__}"
            job["_desc"] = desc
            job["_diag"] = diag

        to_score = [j for j in targets if j not in title_filtered]
        # Stage 3: batched Claude scoring (regex fallback applied per-job
        # for anything Claude didn't return).
        if to_score:
            search.score_jobs_in_batches(to_score, cv_text)

        # Stage 4: hot-flag (single source of truth lives in search.py).
        for job in targets:
            job["hot"] = search._compute_hot(job)

        # Stage 5: atomic upsert — REPLACE existing rows in place. We can't
        # use search.save_results_merge here because that helper is dedup-by-
        # id with "existing record wins" semantics (see its docstring), so
        # it would silently drop every rescore. Bypass via _atomic_merge_json
        # with our own upsert mutator that swaps matching rows by id and
        # preserves order. Sibling rows (not in `targets`) pass through
        # untouched.
        new_by_id: dict[str, dict] = {
            str(j["id"]): j for j in targets if j.get("id") is not None
        }

        def _upsert(current: object) -> list:
            existing = current if isinstance(current, list) else []
            out: list = []
            for row in existing:
                if isinstance(row, dict):
                    rid = row.get("id")
                    if rid is not None and str(rid) in new_by_id:
                        out.append(new_by_id[str(rid)])
                        continue
                out.append(row)
            return out

        search._atomic_merge_json(search.RESULTS_FILE, _upsert)

    # Per-outcome counters for an honest UI report.
    claude_rescored = 0
    regex_fallback = 0
    failed = 0
    for job in targets:
        post = job.get("scored_by")
        if post == "claude":
            claude_rescored += 1
        elif post == "regex" and pre_scored_by.get(job.get("id")) == "regex":
            # No-op for the user — Claude was probably down.
            regex_fallback += 1
        elif post:
            # title-filter, regex-from-null, etc — a real transition.
            claude_rescored += 1
        else:
            failed += 1

    _emit({
        "ok": True,
        # Kept for back-compat — UI reads it for the headline number.
        "rescored": claude_rescored,
        "claude_rescored": claude_rescored,
        "regex_fallback": regex_fallback,
        "failed": failed,
        "missing": missing,
    }, 0)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("delete").set_defaults(func=cmd_delete)
    sub.add_parser("rate").set_defaults(func=cmd_rate)
    sub.add_parser("app-status").set_defaults(func=cmd_app_status)
    sub.add_parser("applied-import").set_defaults(func=cmd_applied_import)
    sub.add_parser("add-manual").set_defaults(func=cmd_add_manual)
    sub.add_parser("rescore").set_defaults(func=cmd_rescore)
    sub.add_parser("push-to-end").set_defaults(func=cmd_push_to_end)
    args = p.parse_args()
    try:
        args.func(args)
    except Exception as e:
        _emit({"ok": False, "error": f"{type(e).__name__}: {e}"}, 1)


if __name__ == "__main__":
    main()
