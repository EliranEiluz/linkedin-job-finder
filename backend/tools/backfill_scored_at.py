#!/usr/bin/env python3
"""One-shot migration: fill `scored_at` on every results.json row that's
missing it, using `found_at` as the proxy.

Why: `scored_at` was added later than `found_at`, so older rows have no
record of when they were scored. The corpus UI sorts/filters on it; without
the field, those rows look "never scored" forever. We don't actually know
when the legacy scoring happened, so falling back to `found_at` gives a
plausible upper bound (a row can't have been scored before it was scraped).

Idempotent. Atomic. Touches only rows where `scored_at` is missing or null.

Usage:
    python3 backend/tools/backfill_scored_at.py
"""
from __future__ import annotations

import sys
from pathlib import Path

# Add backend/ to sys.path so we can import sibling `search` module.
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import search  # noqa: E402 — needs the path shim above


def _backfill(current: object) -> list:
    rows = current if isinstance(current, list) else []
    filled = 0
    skipped_no_found = 0
    for row in rows:
        if not isinstance(row, dict):
            continue
        if row.get("scored_at"):
            continue
        found_at = row.get("found_at")
        if not found_at:
            skipped_no_found += 1
            continue
        row["scored_at"] = found_at
        filled += 1
    print(f"  filled scored_at on {filled} row(s)", file=sys.stderr)
    if skipped_no_found:
        print(
            f"  skipped {skipped_no_found} row(s) missing both scored_at AND found_at",
            file=sys.stderr,
        )
    return rows


def main() -> int:
    path = search.RESULTS_FILE
    if not path.exists():
        print(f"results.json not found at {path}", file=sys.stderr)
        return 1
    print(f"Backfilling scored_at in {path}...", file=sys.stderr)
    search._atomic_merge_json(path, _backfill)
    print("Done.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
