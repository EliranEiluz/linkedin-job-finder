#!/usr/bin/env python3
"""One-shot backfill of `source: null` jobs in results.json.

Pre-`source` tagging, every scrape went through the loggedin Playwright path
(guest mode shipped later). 42 jobs in results.json have `source` missing or
None; this script tags them as "loggedin". Atomic write via temp+rename so a
crash mid-write can't truncate the file.
"""

import json
import os
import sys
from pathlib import Path

RESULTS = Path(__file__).parent / "results.json"


def main() -> int:
    if not RESULTS.exists():
        print(f"results.json not found at {RESULTS}", file=sys.stderr)
        return 1

    with RESULTS.open("r", encoding="utf-8") as f:
        jobs = json.load(f)

    if not isinstance(jobs, list):
        print("results.json root must be a JSON array", file=sys.stderr)
        return 1

    updated = 0
    for j in jobs:
        if not isinstance(j, dict):
            continue
        if j.get("source") is None or "source" not in j:
            j["source"] = "loggedin"
            updated += 1

    tmp = RESULTS.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(jobs, f, ensure_ascii=False, indent=2)
    os.replace(tmp, RESULTS)

    print(f"backfilled source=loggedin on {updated} job(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
