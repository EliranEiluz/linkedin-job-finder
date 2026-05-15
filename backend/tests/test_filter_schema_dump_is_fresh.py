"""Freshness check for shared/filterStateSchema.json.

The dumped JSON is the on-the-wire contract between the UI Zod source
of truth and the Python ctl. If someone edits ui/src/filterStateSchema.ts
but forgets to re-run `npm run schema:dump`, the backend will be reading
a stale schema. This test catches that at CI time.

The signal is the embedded `_meta.source_mtime_unix` — the dumper writes
the source file's mtime into the dumped JSON. We compare against the
source's CURRENT mtime; if the source is newer, dump is stale.

Edge cases handled:
  - First-run scenario where the dump doesn't exist yet: test fails with
    a clear "run npm run schema:dump" hint.
  - Source-mtime parity (newly checked-out repo where everything has the
    same mtime): passes; equality is fine.
  - Dump newer than source (e.g. someone re-dumped without touching the
    source): passes; only "source newer than dump" is a failure.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
SOURCE = REPO_ROOT / "ui" / "src" / "filterStateSchema.ts"
DUMP = REPO_ROOT / "shared" / "filterStateSchema.json"


def _hint(why: str) -> str:
    return (
        f"{why}\n"
        "  Run `cd ui && npm run schema:dump` to regenerate "
        f"{DUMP.relative_to(REPO_ROOT)}.\n"
        "  This file is the on-the-wire contract for corpus_nl_ctl — a stale "
        "dump means backend validation drifts from the UI's Zod schema."
    )


def test_schema_dump_exists() -> None:
    """The dump file must exist — first-run safety."""
    assert DUMP.exists(), _hint(f"schema dump missing at {DUMP}")


def test_schema_dump_is_fresh() -> None:
    """Source mtime must be <= the mtime recorded in the dump."""
    if not SOURCE.exists():
        pytest.skip(f"source file not found at {SOURCE} — non-standard checkout")

    source_mtime = int(SOURCE.stat().st_mtime)
    try:
        payload = json.loads(DUMP.read_text())
    except Exception as e:
        pytest.fail(_hint(f"dump unparseable as JSON: {e}"))

    meta = payload.get("_meta") if isinstance(payload, dict) else None
    if not isinstance(meta, dict):
        pytest.fail(_hint("dump is missing the _meta header"))

    recorded = meta.get("source_mtime_unix")
    if not isinstance(recorded, int):
        pytest.fail(_hint("_meta.source_mtime_unix missing or not an int"))

    # Allow equality (newly checked-out repo) and dump-newer (re-run
    # without touching source). Only "source ahead of dump" fails.
    if source_mtime > recorded:
        pytest.fail(
            _hint(
                f"source file is newer than dump "
                f"(source mtime {source_mtime} > dump-recorded {recorded})"
            )
        )


def test_schema_dump_carries_filter_state_shape() -> None:
    """Lightweight schema-shape pin so a structural change in the Zod
    schema doesn't silently land without anyone noticing. We just check
    the required top-level keys + a representative enum field — full
    structural equivalence is the Zod schema's own concern."""
    payload = json.loads(DUMP.read_text())
    schema = payload.get("schema")
    assert isinstance(schema, dict), "dump missing top-level schema object"
    assert schema.get("type") == "object"
    props = schema.get("properties") or {}
    # These are the static-vocabulary fields that MUST exist for the ctl
    # to work — adding/removing one is the schema-edit moment we want
    # this test to make visible.
    for key in (
        "categories",
        "fits",
        "scoredBy",
        "sources",
        "priority",
        "applied",
        "scoreMin",
        "scoreMax",
        "dateQuick",
        "search",
    ):
        assert key in props, f"static field {key!r} missing from dump"
    # Spot-check: fits should be array-of-enum with the 4 canonical buckets.
    fits = props["fits"]
    items = fits.get("items") or {}
    enum = items.get("enum") or []
    assert set(enum) == {"good", "ok", "skip", "unscored"}, f"fits enum drift: {enum}"
