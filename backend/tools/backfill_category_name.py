#!/usr/bin/env python3
"""One-shot backfill: write `category_name` on every results.json row that
doesn't already have it. Maps known legacy ids to their original names
(so the UI badge shows 'Security' not 'cat mobyb81c 5'). For rows whose
`category` is in the active config, resolves via the config. Idempotent.

Run with the project root as the cwd:
    python3 backend/tools/backfill_category_name.py
"""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
RESULTS = ROOT / "results.json"
CONFIG = ROOT / "config.json"

# Legacy mapping for rows scraped under config schemas the user has since
# overwritten. These are the ids that have been observed in this user's
# corpus + the names they originally referred to.
LEGACY_NAME_FOR_ID: dict[str, str] = {
    # Original wizard-generated ids (mid-April 2026 onboarding):
    "cat-mobyb81c-4": "Keywords",
    "cat-mobyb81c-5": "Security",
    "cat-mobyb81c-6": "Companies",
    # Pre-generic-categories legacy strings:
    "crypto": "Crypto",
    "security_researcher": "Security",
    "company": "Company",
    "manual": "Manual",
}


def _name_for_id(cat_id: str, live: dict[str, str]) -> str:
    if cat_id in live:
        return live[cat_id]
    return LEGACY_NAME_FOR_ID.get(cat_id, cat_id)


def main() -> int:
    if not RESULTS.exists():
        print(f"no results.json at {RESULTS}; nothing to do")
        return 0
    rows = json.loads(RESULTS.read_text())

    live: dict[str, str] = {}
    if CONFIG.exists():
        try:
            cfg = json.loads(CONFIG.read_text())
            for c in cfg.get("categories", []) or []:
                if c.get("id") and c.get("name"):
                    live[c["id"]] = c["name"]
        except Exception as e:
            print(f"WARN: couldn't read config.json — falling back to legacy map only ({e})")

    touched = 0
    for r in rows:
        if r.get("category_name"):
            continue
        cat_id = r.get("category")
        if not cat_id:
            continue
        r["category_name"] = _name_for_id(cat_id, live)
        touched += 1

    RESULTS.write_text(json.dumps(rows, indent=2, ensure_ascii=False))
    print(f"backfilled category_name on {touched} of {len(rows)} rows")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
