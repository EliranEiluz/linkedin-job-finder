"""Tests for backend/ctl/corpus_ctl.py.

corpus_ctl mutates `results.json` and `seen_jobs.json` at the repo ROOT.
We use the run_ctl fixture (subprocess + tmp-cwd-relative ROOT) so each
test gets a fresh fake-repo with no real corpus risk.

Coverage:
- delete       — happy path, missing-id reporting, validation.
- rate         — set/clear rating + comment tri-state.
- app-status   — transition logging, status validation, note tri-state.
- applied-import — bulk migration semantics, idempotence.
- push-to-end  — flag set / clear, missing-id reporting.
- rescore      — empty / missing only path (the network round-trip
                 path needs HTTP mocking inside the subprocess; out
                 of scope, deferred to test_search_io.py).
- add-manual   — duplicate-id rejection (the only easy-to-test path
                 without standing up a fake LinkedIn).
"""

from __future__ import annotations

import json
from pathlib import Path


def _seed_corpus(repo: Path, jobs: list[dict]) -> None:
    """Write results.json into the fake repo so the ctl can read it."""
    (repo / "results.json").write_text(json.dumps(jobs))


# ---------------------------------------------------------------------------
# delete
# ---------------------------------------------------------------------------


def test_corpus_delete_removes_jobs(run_ctl, tmp_path: Path) -> None:
    _seed_corpus(
        tmp_path,
        [
            {"id": "1", "title": "A"},
            {"id": "2", "title": "B"},
            {"id": "3", "title": "C"},
        ],
    )
    rc, out, _err = run_ctl("corpus_ctl.py", ["delete"], stdin_payload={"ids": ["1", "3"]})
    assert rc == 0, out
    assert out["deleted"] == 2
    assert out["missing"] == []
    assert out["kept_in_seen"] == 2
    remaining = json.loads((tmp_path / "results.json").read_text())
    assert [j["id"] for j in remaining] == ["2"]
    seen = set(json.loads((tmp_path / "seen_jobs.json").read_text()))
    assert seen == {"1", "3"}


def test_corpus_delete_reports_missing_ids(run_ctl, tmp_path: Path) -> None:
    _seed_corpus(tmp_path, [{"id": "1"}])
    rc, out, _err = run_ctl("corpus_ctl.py", ["delete"], stdin_payload={"ids": ["1", "missing-id"]})
    assert rc == 0, out
    assert out["deleted"] == 1
    assert out["missing"] == ["missing-id"]


def test_corpus_delete_validation_empty_ids(run_ctl, tmp_path: Path) -> None:  # noqa: ARG001
    rc, out, _err = run_ctl("corpus_ctl.py", ["delete"], stdin_payload={"ids": []})
    assert rc == 1
    assert "non-empty array" in out["error"]


def test_corpus_delete_validation_non_string_ids(run_ctl, tmp_path: Path) -> None:  # noqa: ARG001
    rc, out, _err = run_ctl("corpus_ctl.py", ["delete"], stdin_payload={"ids": [123]})
    assert rc == 1
    assert "non-empty array of strings" in out["error"]


# ---------------------------------------------------------------------------
# rate
# ---------------------------------------------------------------------------


def test_corpus_rate_sets_rating(run_ctl, tmp_path: Path) -> None:
    _seed_corpus(tmp_path, [{"id": "1", "title": "X"}])
    rc, out, _err = run_ctl("corpus_ctl.py", ["rate"], stdin_payload={"id": "1", "rating": 5})
    assert rc == 0, out
    assert out["rating"] == 5
    assert out["rated_at"]
    rows = json.loads((tmp_path / "results.json").read_text())
    assert rows[0]["rating"] == 5
    assert rows[0]["rated_at"]


def test_corpus_rate_clears_with_null(run_ctl, tmp_path: Path) -> None:
    _seed_corpus(tmp_path, [{"id": "1", "rating": 4, "comment": "good"}])
    rc, out, _err = run_ctl("corpus_ctl.py", ["rate"], stdin_payload={"id": "1", "rating": None})
    assert rc == 0, out
    rows = json.loads((tmp_path / "results.json").read_text())
    assert "rating" not in rows[0]
    # Comment untouched (the `comment` key was absent in the payload).
    assert rows[0].get("comment") == "good"


def test_corpus_rate_writes_comment(run_ctl, tmp_path: Path) -> None:
    _seed_corpus(tmp_path, [{"id": "1"}])
    rc, _, _ = run_ctl(
        "corpus_ctl.py",
        ["rate"],
        stdin_payload={"id": "1", "rating": 3, "comment": "interesting team"},
    )
    assert rc == 0
    rows = json.loads((tmp_path / "results.json").read_text())
    assert rows[0]["comment"] == "interesting team"


def test_corpus_rate_clears_comment_with_null(run_ctl, tmp_path: Path) -> None:
    _seed_corpus(tmp_path, [{"id": "1", "comment": "old"}])
    rc, _, _ = run_ctl(
        "corpus_ctl.py",
        ["rate"],
        stdin_payload={"id": "1", "rating": None, "comment": None},
    )
    assert rc == 0
    rows = json.loads((tmp_path / "results.json").read_text())
    assert "comment" not in rows[0]


def test_corpus_rate_invalid_value(run_ctl, tmp_path: Path) -> None:
    _seed_corpus(tmp_path, [{"id": "1"}])
    rc, out, _ = run_ctl("corpus_ctl.py", ["rate"], stdin_payload={"id": "1", "rating": 99})
    assert rc == 1
    assert "rating must be" in out["error"]


def test_corpus_rate_missing_id(run_ctl, tmp_path: Path) -> None:
    _seed_corpus(tmp_path, [{"id": "1"}])
    rc, out, _ = run_ctl("corpus_ctl.py", ["rate"], stdin_payload={"id": "nope", "rating": 5})
    assert rc == 1
    assert "not found" in out["error"]


# ---------------------------------------------------------------------------
# app-status
# ---------------------------------------------------------------------------


def test_corpus_app_status_sets_initial(run_ctl, tmp_path: Path) -> None:
    _seed_corpus(tmp_path, [{"id": "1"}])
    rc, out, _ = run_ctl(
        "corpus_ctl.py",
        ["app-status"],
        stdin_payload={"id": "1", "status": "applied"},
    )
    assert rc == 0, out
    assert out["status"] == "applied"
    assert out["history_len"] == 1
    rows = json.loads((tmp_path / "results.json").read_text())
    assert rows[0]["app_status"] == "applied"
    assert len(rows[0]["app_status_history"]) == 1


def test_corpus_app_status_logs_only_real_transitions(run_ctl, tmp_path: Path) -> None:
    _seed_corpus(tmp_path, [{"id": "1"}])
    # Set to applied twice — second call should NOT double-log.
    run_ctl("corpus_ctl.py", ["app-status"], stdin_payload={"id": "1", "status": "applied"})
    run_ctl("corpus_ctl.py", ["app-status"], stdin_payload={"id": "1", "status": "applied"})
    rows = json.loads((tmp_path / "results.json").read_text())
    assert len(rows[0]["app_status_history"]) == 1


def test_corpus_app_status_invalid_status(run_ctl, tmp_path: Path) -> None:
    _seed_corpus(tmp_path, [{"id": "1"}])
    rc, out, _ = run_ctl(
        "corpus_ctl.py",
        ["app-status"],
        stdin_payload={"id": "1", "status": "ghosted"},
    )
    assert rc == 1
    assert "status must be one of" in out["error"]


def test_corpus_app_status_note_tri_state(run_ctl, tmp_path: Path) -> None:
    _seed_corpus(tmp_path, [{"id": "1"}])
    # Set with note
    run_ctl(
        "corpus_ctl.py",
        ["app-status"],
        stdin_payload={"id": "1", "status": "applied", "note": "via referral"},
    )
    rows = json.loads((tmp_path / "results.json").read_text())
    assert rows[0]["app_notes"] == "via referral"
    # Status change WITHOUT note key — note must be preserved.
    run_ctl(
        "corpus_ctl.py",
        ["app-status"],
        stdin_payload={"id": "1", "status": "screening"},
    )
    rows = json.loads((tmp_path / "results.json").read_text())
    assert rows[0]["app_notes"] == "via referral"
    # Explicit null clears the note.
    run_ctl(
        "corpus_ctl.py",
        ["app-status"],
        stdin_payload={"id": "1", "status": "screening", "note": None},
    )
    rows = json.loads((tmp_path / "results.json").read_text())
    assert "app_notes" not in rows[0]


# ---------------------------------------------------------------------------
# applied-import
# ---------------------------------------------------------------------------


def test_corpus_applied_import_bulk(run_ctl, tmp_path: Path) -> None:
    _seed_corpus(
        tmp_path,
        [
            {"id": "1"},
            {"id": "2", "app_status": "interview"},  # already past new
            {"id": "3"},
        ],
    )
    rc, out, _ = run_ctl(
        "corpus_ctl.py",
        ["applied-import"],
        stdin_payload={"applied_ids": ["1", "2", "3", "missing"]},
    )
    assert rc == 0, out
    assert out["imported"] == 2  # ids 1 + 3
    assert out["skipped_already_set"] == 1  # id 2
    assert out["skipped_not_in_corpus"] == 1  # missing


def test_corpus_applied_import_empty_ok(run_ctl, tmp_path: Path) -> None:
    _seed_corpus(tmp_path, [])
    rc, out, _ = run_ctl("corpus_ctl.py", ["applied-import"], stdin_payload={"applied_ids": []})
    assert rc == 0
    assert out["imported"] == 0


def test_corpus_applied_import_validation(run_ctl, tmp_path: Path) -> None:  # noqa: ARG001
    rc, out, _ = run_ctl(
        "corpus_ctl.py", ["applied-import"], stdin_payload={"applied_ids": "not a list"}
    )
    assert rc == 1
    assert "applied_ids must be" in out["error"]


# ---------------------------------------------------------------------------
# push-to-end
# ---------------------------------------------------------------------------


def test_corpus_push_to_end_sets_flag(run_ctl, tmp_path: Path) -> None:
    _seed_corpus(tmp_path, [{"id": "1"}, {"id": "2"}])
    rc, out, _ = run_ctl(
        "corpus_ctl.py",
        ["push-to-end"],
        stdin_payload={"ids": ["1"], "pushed": True},
    )
    assert rc == 0, out
    assert out["updated"] == 1
    rows = json.loads((tmp_path / "results.json").read_text())
    by_id = {r["id"]: r for r in rows}
    assert by_id["1"]["pushed_to_end"] is True
    assert by_id["2"].get("pushed_to_end") is None


def test_corpus_push_to_end_clears_flag(run_ctl, tmp_path: Path) -> None:
    _seed_corpus(tmp_path, [{"id": "1", "pushed_to_end": True}])
    rc, out, _ = run_ctl(
        "corpus_ctl.py",
        ["push-to-end"],
        stdin_payload={"ids": ["1"], "pushed": False},
    )
    assert rc == 0
    assert out["updated"] == 1
    rows = json.loads((tmp_path / "results.json").read_text())
    assert rows[0]["pushed_to_end"] is None


def test_corpus_push_to_end_idempotent(run_ctl, tmp_path: Path) -> None:
    """Setting the flag twice should report 0 updates the second time."""
    _seed_corpus(tmp_path, [{"id": "1"}])
    run_ctl("corpus_ctl.py", ["push-to-end"], stdin_payload={"ids": ["1"], "pushed": True})
    rc, out, _ = run_ctl(
        "corpus_ctl.py",
        ["push-to-end"],
        stdin_payload={"ids": ["1"], "pushed": True},
    )
    assert rc == 0
    assert out["updated"] == 0


def test_corpus_push_to_end_missing_reported(run_ctl, tmp_path: Path) -> None:
    _seed_corpus(tmp_path, [{"id": "1"}])
    rc, out, _ = run_ctl(
        "corpus_ctl.py",
        ["push-to-end"],
        stdin_payload={"ids": ["1", "ghost"], "pushed": True},
    )
    assert rc == 0
    assert "ghost" in out["missing"]


def test_corpus_push_to_end_pushed_must_be_bool(run_ctl, tmp_path: Path) -> None:  # noqa: ARG001
    rc, out, _ = run_ctl(
        "corpus_ctl.py",
        ["push-to-end"],
        stdin_payload={"ids": ["1"], "pushed": "yes"},
    )
    assert rc == 1
    assert "pushed must be a boolean" in out["error"]


# ---------------------------------------------------------------------------
# rescore — minimal coverage. The network/Claude paths are too heavy to
# stub from a subprocess; we only verify the validation + missing-only path.
# ---------------------------------------------------------------------------


def test_corpus_rescore_validation_empty_ids(run_ctl, tmp_path: Path) -> None:  # noqa: ARG001
    rc, out, _ = run_ctl("corpus_ctl.py", ["rescore"], stdin_payload={"ids": []})
    assert rc == 1
    assert "non-empty array" in out["error"]


def test_corpus_rescore_all_missing_no_op(run_ctl, tmp_path: Path) -> None:
    """Every requested id is absent from results.json — short-circuit
    to a no-op without spending network round-trips."""
    _seed_corpus(tmp_path, [])
    rc, out, _ = run_ctl(
        "corpus_ctl.py", ["rescore"], stdin_payload={"ids": ["ghost-1", "ghost-2"]}
    )
    assert rc == 0
    assert out["rescored"] == 0
    assert out["failed"] == 0
    assert sorted(out["missing"]) == ["ghost-1", "ghost-2"]


# ---------------------------------------------------------------------------
# add-manual — duplicate ID short-circuit (no network needed).
# ---------------------------------------------------------------------------


def test_corpus_add_manual_duplicate_returns_409_shape(run_ctl, tmp_path: Path) -> None:
    """Existing id in the corpus → ok=false + existing_id field. The HTTP
    layer maps this rc=1+ existing_id to 409. Subprocess never hits LinkedIn
    for a dupe — short-circuited by the dedup pass."""
    _seed_corpus(tmp_path, [{"id": "4395123456", "title": "Existing"}])
    rc, out, _ = run_ctl(
        "corpus_ctl.py",
        ["add-manual"],
        stdin_payload={"url_or_id": "4395123456"},
    )
    assert rc == 1
    assert out["ok"] is False
    assert out["existing_id"] == "4395123456"
    assert "already in corpus" in out["error"]


def test_corpus_add_manual_validation_empty(run_ctl, tmp_path: Path) -> None:  # noqa: ARG001
    rc, out, _ = run_ctl("corpus_ctl.py", ["add-manual"], stdin_payload={"url_or_id": ""})
    assert rc == 1
    assert "must not be empty" in out["error"]


def test_corpus_add_manual_validation_oversize(run_ctl, tmp_path: Path) -> None:  # noqa: ARG001
    rc, out, _ = run_ctl(
        "corpus_ctl.py",
        ["add-manual"],
        stdin_payload={"url_or_id": "x" * 600},
    )
    assert rc == 1
    assert "exceeds max" in out["error"]


def test_corpus_add_manual_unparseable(run_ctl, tmp_path: Path) -> None:  # noqa: ARG001
    rc, out, _ = run_ctl(
        "corpus_ctl.py",
        ["add-manual"],
        stdin_payload={"url_or_id": "https://google.com/foo"},
    )
    assert rc == 1
    assert "could not extract job ID" in out["error"]


# ---------------------------------------------------------------------------
# extract_job_id — pure helper. Importable directly.
# ---------------------------------------------------------------------------


def test_extract_job_id_from_various_url_shapes() -> None:
    import corpus_ctl

    eq = corpus_ctl.extract_job_id
    assert eq("4395123456") == "4395123456"
    assert (
        eq("https://www.linkedin.com/jobs/view/staff-eng-foo-at-bar-4395123456?refId=abc")
        == "4395123456"
    )
    assert eq("https://www.linkedin.com/jobs/view/4395123456/") == "4395123456"
    assert eq("https://www.linkedin.com/jobs/search/?currentJobId=4395123456") == "4395123456"
    assert (
        eq("https://www.linkedin.com/jobs/search-results/?currentJobId=4395123456&q=foo")
        == "4395123456"
    )
    # Foreign URL
    assert eq("https://example.com/jobs/view/4395123456/") is None
    # Bare 7-digit number is too short
    assert eq("1234567") is None
    # 13-digit number too long
    assert eq("1234567890123") is None
    # Garbage
    assert eq("") is None
    assert eq("not a url") is None
