#!/usr/bin/env python3
"""
Re-fetch descriptions + Claude-score any jobs in results.json whose `fit` is
null (typically because they were scraped with --no-enrich). Uses the guest
description endpoint so no browser/account is needed.

Usage:
  python3 rescue_unscored.py           # process all unscored jobs
  python3 rescue_unscored.py --limit 5 # just the first 5
  python3 rescue_unscored.py --dry-run # show counts, don't mutate
"""

import argparse
import json
import sys
import time

import search
from search import (
    _apply_claude_scoring, _apply_regex_fallback, _atomic_merge_json,
    _compute_hot, _guest_session, _load_cv_text, BATCH_SIZE,
    claude_batch_score, fetch_description_guest, RESULTS_FILE,
    is_obviously_offtopic,
)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None,
                    help="cap the number of jobs processed (default: all)")
    ap.add_argument("--dry-run", action="store_true",
                    help="print counts without modifying results.json")
    args = ap.parse_args()

    # Load + find unscored jobs. "Unscored" = fit is None.
    with open(RESULTS_FILE) as f:
        corpus = json.load(f)
    unscored = [j for j in corpus if j.get("fit") is None]
    print(f"Corpus: {len(corpus)} jobs, {len(unscored)} unscored.")
    if args.limit:
        unscored = unscored[: args.limit]
        print(f"Limited to {len(unscored)}.")
    if not unscored:
        return
    if args.dry_run:
        for j in unscored:
            print(f"  would re-score: {j['title'][:50]} @ {j['company'][:25]}")
        return

    # Load active config so CLAUDE_BATCH_SCORING_PROMPT / regex fallbacks reflect
    # the user's current scoring prompt.
    search.load_config()
    cv_text = _load_cv_text()

    # Stage 1: title pre-filter — cheaply skip obvious garbage.
    session = _guest_session()
    title_filtered = 0
    for job in list(unscored):
        reason = is_obviously_offtopic(job.get("title", ""))
        if reason and not job.get("priority"):
            job["fit"] = "skip"
            job["score"] = 1
            job["fit_reasons"] = [f"title: matches /{reason}/"]
            job["scored_by"] = "title-filter"
            job["hot"] = _compute_hot(job)
            unscored.remove(job)
            title_filtered += 1
    print(f"Title pre-filter removed {title_filtered} obvious skips.")

    # Stage 2: fetch descriptions via the guest endpoint. Use the same
    # rate-limit-friendly throttle as _enrich_descriptions: 1.5-3s between
    # fetches + 10s cool-down every 20. fetch_description_guest itself
    # retries 429 with Retry-After honored.
    import random as _random
    print(f"\nFetching descriptions for {len(unscored)} jobs…")
    for i, job in enumerate(unscored):
        short = job.get("title", "")[:55]
        print(f"  [{i+1}/{len(unscored)}] {short} @ {job.get('company', '')[:22]}")
        try:
            desc, diag = fetch_description_guest(session, job["id"])
        except Exception as e:
            desc, diag = "", f"error:{str(e)[:60]}"
        if diag != "ok":
            print(f"    ⚠ {diag}")
        job["_desc"] = desc
        if i < len(unscored) - 1:
            time.sleep(_random.uniform(1.5, 3.0))
            if (i + 1) % 20 == 0:
                print(f"    … 20-fetch cool-down (10s)")
                time.sleep(10.0)

    # Stage 3: Claude batch scoring.
    to_score = [j for j in unscored if j.get("_desc")]
    if to_score:
        print(f"\nScoring {len(to_score)} via Claude in batches of {BATCH_SIZE}…")
        for i in range(0, len(to_score), BATCH_SIZE):
            batch = to_score[i:i + BATCH_SIZE]
            n = i // BATCH_SIZE + 1
            total = (len(to_score) + BATCH_SIZE - 1) // BATCH_SIZE
            print(f"  batch {n}/{total} ({len(batch)} jobs)…")
            scored_map = claude_batch_score(cv_text, batch) if cv_text else None
            for job in batch:
                scoring = scored_map.get(str(job["id"])) if scored_map else None
                if scoring:
                    _apply_claude_scoring(job, scoring)
                else:
                    _apply_regex_fallback(job, job.get("_desc", ""))
                # Recompute the derived `hot` flag right after fit/score land —
                # mirrors the main scrape pipeline (search.py:_compute_hot is
                # called after _apply_claude_scoring / _apply_regex_fallback in
                # process_one_job). Without this, rescued rows would keep their
                # stale `hot` value from the previous scoring attempt.
                job["hot"] = _compute_hot(job)

    # Stage 4: regex fallback for anything still unscored, then re-derive hot.
    for job in unscored:
        if job.get("fit") is None:
            _apply_regex_fallback(job, job.get("_desc", ""))
            job["hot"] = _compute_hot(job)
        job.pop("_desc", None)

    # Persist via the same atomic-merge primitive the scraper uses, so a
    # concurrent scheduled run can't clobber the rescued rows. Only the rows
    # this tool actually mutated are written back; every other row in the
    # on-disk corpus passes through untouched (rating / app_status / pushed_to_end
    # edits made between our load and our write are preserved). Idempotent:
    # re-running on an already-scored corpus is a no-op because `unscored`
    # filters on fit is None up top — touched_by_id is empty.
    touched_by_id = {j["id"]: j for j in unscored if j.get("id")}
    # Title-filter rows were drained out of `unscored` in stage 1 but still
    # need to be persisted; pull them from `corpus`.
    for j in corpus:
        jid = j.get("id")
        if jid and j.get("scored_by") == "title-filter" and jid not in touched_by_id:
            touched_by_id[jid] = j

    def _merge_rescued(current):
        existing = current if isinstance(current, list) else []
        out: list = []
        for r in existing:
            if isinstance(r, dict) and r.get("id") in touched_by_id:
                # Preserve any user-edited fields that may have landed on the
                # on-disk row between our read and our write. The rescued
                # values for fit/score/scored_by/etc. win; everything else
                # falls back to the on-disk row.
                merged = dict(r)
                merged.update(touched_by_id[r["id"]])
                out.append(merged)
            else:
                out.append(r)
        return out

    _atomic_merge_json(RESULTS_FILE, _merge_rescued)

    # Summary.
    from collections import Counter
    c = Counter(j.get("fit") for j in unscored)
    by_src = Counter(j.get("scored_by") for j in unscored)
    print(f"\n{'='*55}")
    print(f"Rescued {len(unscored)} jobs.")
    print(f"  fit distribution  : {dict(c)}")
    print(f"  scored_by         : {dict(by_src)}")
    print(f"  good hits         : {[j['title'][:60] for j in unscored if j.get('fit') == 'good']}")


if __name__ == "__main__":
    main()
