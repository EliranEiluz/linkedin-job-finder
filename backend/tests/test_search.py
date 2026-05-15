"""Pytest tests for backend/search.py pure helpers.

These cover the small, side-effect-free functions inside search.py — the
ones that drive the bulk of the scraper's behavior but never touch the
network, the browser, or the LLM. Heavy I/O paths
(scrape_query_guest / fetch_description / process_one_job)
are exercised separately in test_search_io.py with `responses`-mocked HTTP.

Style:
- Heavy use of pytest.mark.parametrize so adding a case = adding one row.
- Each test names the property it's asserting; no test asserts >1 thing
  unless they're cohesive (e.g. "(score, fit) -> hot").
- Existing phase_d_test.py covered some of these — we re-cover here in the
  proper pytest idiom and add edge cases that script can't easily express.
"""

from __future__ import annotations

import contextlib
import json
from pathlib import Path

import pytest
import search

# ---------------------------------------------------------------------------
# _compute_hot — single source of truth for "noteworthy match" flag.
# Replicates phase_d's truth table and adds priority/score interaction edges.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("job", "expected_hot"),
    [
        # Default: fit must be 'good' for any hot path to fire.
        ({"fit": "skip", "score": 10, "priority": True}, False),
        ({"fit": "ok", "score": 10, "priority": True}, False),
        ({"fit": None, "score": 10, "priority": True}, False),
        # fit='good' + high score
        ({"fit": "good", "score": 10, "priority": False}, True),
        ({"fit": "good", "score": 8, "priority": False}, True),  # threshold edge
        ({"fit": "good", "score": 7, "priority": False}, False),
        # fit='good' + low score, but priority company
        ({"fit": "good", "score": 1, "priority": True}, True),
        ({"fit": "good", "score": 5, "priority": True}, True),
        # fit='good' + missing score field
        ({"fit": "good", "priority": True}, True),
        ({"fit": "good", "priority": False}, False),
        # Score as float — must be treated like int.
        ({"fit": "good", "score": 8.0, "priority": False}, True),
        ({"fit": "good", "score": 7.99, "priority": False}, False),
        # Score as a non-numeric string — guard against bad data; only priority can rescue.
        ({"fit": "good", "score": "huge", "priority": False}, False),
        ({"fit": "good", "score": "huge", "priority": True}, True),
        # Empty dict — no fit, no score, no priority.
        ({}, False),
    ],
)
def test_compute_hot(job: dict, expected_hot: bool) -> None:
    assert search._compute_hot(job) is expected_hot


# ---------------------------------------------------------------------------
# is_obviously_offtopic — title pre-filter regex matrix.
# ---------------------------------------------------------------------------


@pytest.fixture
def _use_default_offtopic_patterns(monkeypatch: pytest.MonkeyPatch) -> None:
    """Force `OFFTOPIC_TITLE_PATTERNS` to the hardcoded defaults for the
    duration of a test, regardless of what the repo-root config.json
    happens to override it to. Without this, running pytest from the
    project root with a user-tuned config.json would shadow the source
    defaults and silently make these regex tests test the user's config
    instead of the in-file defaults."""
    monkeypatch.setattr(
        search,
        "OFFTOPIC_TITLE_PATTERNS",
        list(search._DEFAULT_OFFTOPIC_TITLE_PATTERNS),
    )


@pytest.mark.parametrize(
    ("title", "is_offtopic"),
    [
        # On-topic IC titles — must NOT match.
        ("Senior Software Engineer", False),
        ("Staff Backend Engineer", False),
        ("Principal Engineer", False),
        ("Backend Developer", False),
        ("Site Reliability Engineer", False),
        ("Security Engineer", False),
        # Seniority extremes — should match.
        ("Software Engineering Intern", True),
        ("Internship Program 2026", True),
        ("Junior Software Engineer", True),
        ("Entry Level Backend Developer", True),
        ("Graduate Software Engineer", True),
        ("VP of Engineering", True),
        ("Vice President of Platform", True),
        ("Director of Security", True),
        ("Head of Backend", True),
        ("Chief Technology Officer", True),
        # Non-IC tracks — should match.
        ("Sales Engineer", True),
        ("Pre-Sales Engineer", True),
        ("Account Executive", True),
        ("SDR — Inbound", True),
        ("Product Manager", True),
        ("Senior Project Manager", True),
        ("Program Manager II", True),
        ("Marketing Manager", True),
        ("Community Manager", True),
        ("Customer Success Engineer", True),
        ("Developer Relations Engineer", True),
        ("DevRel Lead", True),
        ("Developer Evangelist", True),
        ("QA Engineer", True),
        ("Quality Assurance Tester", True),
        # Whitespace + case insensitivity.
        ("  STAFF  ENGINEER  ", False),
        ("staff engineer (verified)", False),
        # Empty / None inputs.
        ("", False),
    ],
)
def test_is_obviously_offtopic(
    title: str, is_offtopic: bool, _use_default_offtopic_patterns: None
) -> None:
    result = search.is_obviously_offtopic(title)
    if is_offtopic:
        assert result is not None, f"expected a regex match for {title!r}"
    else:
        assert result is None, f"expected NO match for {title!r} but matched {result!r}"


def test_is_obviously_offtopic_returns_pattern_string(
    _use_default_offtopic_patterns: None,
) -> None:
    """When a title matches, the helper returns the *which* regex matched —
    used in fit_reasons display so the user sees why a job was demoted."""
    result = search.is_obviously_offtopic("Marketing Manager")
    assert isinstance(result, str)
    assert "marketing" in result.lower()


# ---------------------------------------------------------------------------
# _classify_feedback_row — per-row sentiment + summary classifier for the
# few-shot loop. Lifted from phase_d into the proper parametrize idiom.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("row", "expected_sentiment", "summary_substr"),
    [
        # Non-dict input
        ("not a dict", None, ""),
        (None, None, ""),
        # No usable signal
        ({}, None, ""),
        ({"title": "Foo"}, None, ""),
        # Star rating happy paths
        ({"rating": 5}, "pos", "rated 5/5"),
        ({"rating": 4}, "pos", "rated 4/5"),
        ({"rating": 3}, "pos", "rated 3/5"),  # 3 -> weak positive
        ({"rating": 2}, "neg", "rated 2/5"),
        ({"rating": 1}, "neg", "rated 1/5"),
        # Out-of-range rating ignored
        ({"rating": 0}, None, ""),
        ({"rating": 6}, None, ""),
        # Rating with comment — comment surfaces in summary
        ({"rating": 5, "comment": "loved this"}, "pos", "loved this"),
        # app_status positive bucket
        ({"app_status": "interview"}, "pos", "interview"),
        ({"app_status": "INTERVIEW"}, "pos", "interview"),  # case-insensitive
        ({"app_status": "take-home"}, "pos", "take-home"),
        ({"app_status": "screening"}, "pos", "screening"),
        ({"app_status": "offer"}, "pos", "offer"),
        # app_status negative bucket
        ({"app_status": "rejected"}, "neg", "rejected"),
        ({"app_status": "withdrew"}, "neg", "withdrew"),
        # app_status neutral / missing
        ({"app_status": "applied"}, None, ""),
        ({"app_status": "new"}, None, ""),
        ({"app_status": ""}, None, ""),
        # source = manual
        ({"source": "manual"}, "pos", "manually added"),
        # Rating beats app_status (highest priority)
        ({"rating": 5, "app_status": "rejected"}, "pos", "rated 5/5"),
    ],
)
def test_classify_feedback_row(
    row: object, expected_sentiment: str | None, summary_substr: str
) -> None:
    sentiment, summary = search._classify_feedback_row(row)  # type: ignore[arg-type]
    assert sentiment == expected_sentiment
    if summary_substr:
        assert summary_substr.lower() in summary.lower()


# ---------------------------------------------------------------------------
# _detect_system_timezone — three resolution paths (symlink / TZ env / UTC).
# ---------------------------------------------------------------------------


def test_detect_system_timezone_from_etc_localtime_symlink(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The Linux/macOS happy path resolves /etc/localtime via its symlink
    target. We mock Path.resolve / Path.exists rather than touching the real
    /etc filesystem so the test runs deterministically in CI."""

    # Point the function at a fake "/etc/localtime" pointing at "Asia/Jerusalem".
    class _FakeLink:
        @staticmethod
        def exists() -> bool:
            return True

        @staticmethod
        def resolve() -> Path:
            # macOS-shaped target: /var/db/timezone/zoneinfo/Asia/Jerusalem
            return Path("/var/db/timezone/zoneinfo/Asia/Jerusalem")

    # Patch only the very local Path use inside _detect_system_timezone.
    # The function does `from pathlib import Path` inside the body, so we
    # patch via builtins.
    import pathlib

    real_path = pathlib.Path

    def _patched_path(arg: object) -> object:
        if str(arg) == "/etc/localtime":
            return _FakeLink()
        return real_path(arg)

    monkeypatch.setattr(search, "Path", _patched_path)
    # Make sure TZ env doesn't short-circuit before our patched symlink is consulted.
    monkeypatch.delenv("TZ", raising=False)
    assert search._detect_system_timezone() == "Asia/Jerusalem"


def test_detect_system_timezone_from_tz_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Container / k8s pattern: TZ env var set explicitly. Must beat the
    Python-locale fallback but yield to the symlink path. We make the symlink
    path miss to isolate the env branch."""
    import pathlib

    real_path = pathlib.Path

    def _patched_path(arg: object) -> object:
        if str(arg) == "/etc/localtime":

            class _Missing:
                @staticmethod
                def exists() -> bool:
                    return False

                @staticmethod
                def resolve() -> Path:  # pragma: no cover — exists() short-circuits
                    return Path("/dev/null")

            return _Missing()
        return real_path(arg)

    monkeypatch.setattr(search, "Path", _patched_path)
    monkeypatch.setenv("TZ", "Europe/Berlin")
    # Non-IANA Windows fallback should NOT be hit on darwin / linux.
    monkeypatch.setattr(search, "_detect_windows_timezone", lambda: None)
    assert search._detect_system_timezone() == "Europe/Berlin"


def test_detect_system_timezone_falls_through_to_utc(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When every detection path returns None, the function falls back to
    'UTC' rather than raising or returning a POSIX abbreviation."""
    import pathlib

    real_path = pathlib.Path

    def _patched_path(arg: object) -> object:
        if str(arg) == "/etc/localtime":

            class _Missing:
                @staticmethod
                def exists() -> bool:
                    return False

                @staticmethod
                def resolve() -> Path:  # pragma: no cover — exists() short-circuits
                    return Path("/dev/null")

            return _Missing()
        return real_path(arg)

    monkeypatch.setattr(search, "Path", _patched_path)
    monkeypatch.delenv("TZ", raising=False)
    monkeypatch.setattr(search, "_detect_windows_timezone", lambda: None)

    # Patch datetime.now().astimezone().tzinfo to return None-shaped object.
    class _NoIANA:
        def __str__(self) -> str:
            return "PST"  # POSIX abbrev — should be rejected by the "/" check

    class _Aware:
        def astimezone(self) -> object:
            class _Z:
                tzinfo = _NoIANA()

            return _Z()

    class _DT:
        @staticmethod
        def now() -> _Aware:
            return _Aware()

    import datetime as dt_mod

    monkeypatch.setattr(dt_mod, "datetime", _DT)
    assert search._detect_system_timezone() == "UTC"


# ---------------------------------------------------------------------------
# check_msc / check_fit — regex fallback scorer (used only when no LLM is
# reachable, so it's important these stay deterministic).
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("desc", "expected"),
    [
        ("We require an MSc in Computer Science", True),
        ("M.Sc. preferred", True),
        ("Master's degree required", True),
        ("Master of Science in Engineering", True),
        ("Graduate degree expected", True),
        ("Postgraduate qualification helpful", True),
        ("Bachelor's degree required", False),
        ("Just a CS undergrad position", False),
        ("", False),
        # M.S. in <subject> — the pattern requires a period after S.
        ("M.S. in Mathematics", True),
        ("Ms. in Engineering", True),
        # Bare "MS in" (no period) does NOT match the current MSC_PATTERNS.
        # This is a deliberate choice: MS-prefixed words ("MS Office", "MS Word")
        # would over-match. Documented for the next reader.
        ("MS in Computer Science", False),
        # Don't false-positive on unrelated words containing 'ms'
        ("We use systems with timestamps", False),
    ],
)
def test_check_msc(desc: str, expected: bool) -> None:
    assert search.check_msc(desc) is expected


def test_check_fit_with_empty_pattern_lists(monkeypatch: pytest.MonkeyPatch) -> None:
    """With no positive/negative patterns configured the fallback returns
    'ok' (neutral) — this is the unconfigured-profile baseline. Asserting
    so a future change doesn't accidentally swap default to 'skip'."""
    monkeypatch.setattr(search, "FIT_POSITIVE", [])
    monkeypatch.setattr(search, "FIT_NEGATIVE", [])
    label, reasons = search.check_fit("any description text")
    assert label == "ok"
    assert reasons == []


def test_check_fit_with_patterns(monkeypatch: pytest.MonkeyPatch) -> None:
    """Score = positives - 2*negatives. >=2 -> good, >=0 -> ok, else skip."""
    monkeypatch.setattr(search, "FIT_POSITIVE", [r"\brust\b", r"\bgo\b"])
    monkeypatch.setattr(search, "FIT_NEGATIVE", [r"\bphp\b"])

    # 2 positives, 0 negatives → score=2 → good
    label, reasons = search.check_fit("we use rust and go in production")
    assert label == "good"
    assert "+\\brust\\b" in reasons
    assert "+\\bgo\\b" in reasons

    # 1 positive, 1 negative → score = 1 - 2 = -1 → skip
    label, _ = search.check_fit("rust and php codebase")
    assert label == "skip"

    # 1 positive, 0 negative → score=1 → ok
    label, _ = search.check_fit("we use go for everything")
    assert label == "ok"


# ---------------------------------------------------------------------------
# _strip_html — defensive HTML scrubber for LinkedIn description shapes.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("html", "expected"),
    [
        ("<p>Hello world</p>", "Hello world"),
        ("<div><p>Hello</p><p>World</p></div>", "Hello World"),
        ("Plain text — no tags", "Plain text — no tags"),
        ("", ""),
        ("<br/>", ""),
        # Self-closing + nested
        (
            "<ul><li>One</li><li>Two<br/></li></ul>",
            "One Two",
        ),
        # Whitespace collapse
        ("<p>Hello\n\n\n   world</p>", "Hello world"),
        # Tags without close should still strip
        ("<div>One<div>Two", "One Two"),
        # Embedded scripts get stripped of tags but content remains (not a security feature)
        ("<script>alert(1)</script>safe", "alert(1) safe"),
    ],
)
def test_strip_html(html: str, expected: str) -> None:
    assert search._strip_html(html) == expected


# ---------------------------------------------------------------------------
# _atomic_merge_json — the read-modify-write helper used for results.json /
# seen_jobs.json / run_history.json. Concurrency is hard to assert via unit
# tests; we cover the I/O edges (ENOENT, malformed, mutator return shape).
# ---------------------------------------------------------------------------


def test_atomic_merge_json_creates_file_when_missing(tmp_path: Path) -> None:
    target = tmp_path / "new.json"
    assert not target.exists()
    search._atomic_merge_json(target, lambda current: ["x"] if current is None else current)
    assert target.exists()
    assert json.loads(target.read_text()) == ["x"]


def test_atomic_merge_json_recovers_from_malformed_file(tmp_path: Path) -> None:
    """If the existing file isn't valid JSON, the mutator should see `current=None`
    rather than crash. This is what keeps the scraper resilient to half-written
    state files (e.g. after a crash mid-write)."""
    target = tmp_path / "bad.json"
    target.write_text("{not json")

    captured = {}

    def _mut(current: object) -> list:
        captured["current"] = current
        return ["recovered"]

    search._atomic_merge_json(target, _mut)
    assert captured["current"] is None
    assert json.loads(target.read_text()) == ["recovered"]


def test_atomic_merge_json_empty_file_treated_as_none(tmp_path: Path) -> None:
    target = tmp_path / "empty.json"
    target.write_text("")
    captured: dict = {}
    search._atomic_merge_json(
        target,
        lambda current: captured.update({"c": current}) or [1, 2, 3],  # type: ignore[func-returns-value]
    )
    assert captured["c"] is None


def test_atomic_merge_json_round_trips_dict(tmp_path: Path) -> None:
    target = tmp_path / "runs.json"
    search._atomic_merge_json(target, lambda _: {"runs": [{"a": 1}]})
    payload = json.loads(target.read_text())
    assert payload == {"runs": [{"a": 1}]}


# ---------------------------------------------------------------------------
# _load_cv_text — stable behavior on missing / empty / large files. CV
# is read every batch so a bad path here breaks every scoring call.
# ---------------------------------------------------------------------------


def test_load_cv_text_missing_file_returns_empty(
    tmp_repo: Path,  # noqa: ARG001 — fixture redirects search.CV_FILE
) -> None:
    # tmp_repo points CV_FILE at <tmp>/cv.txt which does not exist.
    assert search._load_cv_text() == ""


def test_load_cv_text_present(tmp_repo: Path) -> None:
    (tmp_repo / "cv.txt").write_text("Senior engineer with 5 years experience")
    assert "Senior engineer" in search._load_cv_text()


def test_load_cv_text_empty_file(tmp_repo: Path) -> None:
    (tmp_repo / "cv.txt").write_text("")
    assert search._load_cv_text() == ""


# ---------------------------------------------------------------------------
# _parse_claude_json — the LLM-output JSON extractor. Same logic lives in
# llm/_shared.py:parse_json_response (asserted in test_llm_shared.py).
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ('[{"id": "1"}]', [{"id": "1"}]),
        ('{"foo": "bar"}', {"foo": "bar"}),
        # Code-fence wrapped
        ('```json\n[{"id":"1"}]\n```', [{"id": "1"}]),
        ('```\n{"a":1}\n```', {"a": 1}),
        # Junk before/after — we extract the first balanced bracket pair
        ('preamble [{"id":"1"}] tail', [{"id": "1"}]),
        ('blah {"a":1} more', {"a": 1}),
        # Strings containing brackets must not throw off bracket counting
        ('{"k": "[ ]"}', {"k": "[ ]"}),
        # Empty input
        ("", None),
        ("   ", None),
        # No JSON at all
        ("nothing here", None),
        # Object with array value (the original bug — array-first scan
        # would falsely pick the inner array). Object opener appears first
        # so we must parse the outer object.
        ('{"jobs": [{"id": "1"}]}', {"jobs": [{"id": "1"}]}),
    ],
)
def test_parse_claude_json(raw: str, expected: object) -> None:
    assert search._parse_claude_json(raw) == expected


# ---------------------------------------------------------------------------
# claude_batch_score — wrap the LLM provider, dict-by-id keying.
# ---------------------------------------------------------------------------


def test_claude_batch_score_returns_none_on_empty_inputs() -> None:
    assert search.claude_batch_score("", [{"id": "1"}]) is None
    assert search.claude_batch_score("cv text", []) is None


def test_claude_batch_score_keys_results_by_id(monkeypatch: pytest.MonkeyPatch) -> None:
    """The provider returns a list; the helper keys it by `id` so the
    caller can do O(1) lookups per job. Mock the provider's score_batch
    so we don't need a real LLM."""
    fake_arr = [
        {"id": "1", "fit": "good", "score": 9},
        {"id": "2", "fit": "skip", "score": 2},
        # Entry with no id — should be silently dropped
        {"fit": "ok"},
    ]

    import backend.llm as llm_pkg

    monkeypatch.setattr(llm_pkg, "score_batch", lambda _cv, _b: fake_arr)
    out = search.claude_batch_score("cv", [{"id": "1"}, {"id": "2"}])
    assert out == {"1": fake_arr[0], "2": fake_arr[1]}


def test_claude_batch_score_returns_none_when_provider_returns_none(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import backend.llm as llm_pkg

    monkeypatch.setattr(llm_pkg, "score_batch", lambda _cv, _b: None)
    assert search.claude_batch_score("cv", [{"id": "1"}]) is None


# ---------------------------------------------------------------------------
# score_jobs_in_batches — batching math + regex fallback path.
# ---------------------------------------------------------------------------


def test_score_jobs_in_batches_no_jobs_returns_none() -> None:
    # Empty job list: scored_anything is None, all counters are 0.
    scored, filtered_out, completed, failed = search.score_jobs_in_batches([], "cv")
    assert scored is None
    assert filtered_out == 0
    assert completed == 0
    assert failed == 0


def test_score_jobs_in_batches_uses_batch_size(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """BATCH_SIZE jobs/call. A 17-job list = 3 batches (8/8/1)."""
    monkeypatch.setattr(search, "BATCH_SIZE", 8)
    calls: list[int] = []

    def _fake(_cv: str, batch: list[dict]) -> dict:
        calls.append(len(batch))
        return {str(j["id"]): {"fit": "ok", "score": 5} for j in batch}

    monkeypatch.setattr(search, "claude_batch_score", _fake)
    jobs = [{"id": str(i), "_desc": "desc"} for i in range(17)]
    scored, _filtered_out, completed, failed = search.score_jobs_in_batches(jobs, "cv text")
    assert scored is True
    assert completed == 3
    assert failed == 0
    # ThreadPoolExecutor.as_completed yields in finish-order, not submit-order,
    # so the batches-of-8/8/1 may arrive in any sequence — sort to assert size.
    assert sorted(calls) == [1, 8, 8]
    # All jobs scored, transient _desc cleaned up
    for j in jobs:
        assert j["fit"] == "ok"
        assert "_desc" not in j


def test_score_jobs_in_batches_falls_back_to_regex_per_batch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When the LLM returns None for a whole batch, every job in that batch
    gets the regex-fallback path applied."""
    monkeypatch.setattr(search, "claude_batch_score", lambda _cv, _b: None)
    monkeypatch.setattr(search, "FIT_POSITIVE", [])
    monkeypatch.setattr(search, "FIT_NEGATIVE", [])
    jobs = [{"id": "a", "_desc": "x"}, {"id": "b", "_desc": "y"}]
    scored, _filtered_out, completed, failed = search.score_jobs_in_batches(jobs, "cv text")
    assert scored is False  # never scored anything via Claude
    assert completed == 1
    assert failed == 0
    for j in jobs:
        assert j["scored_by"] == "regex"
        assert j["fit"] == "ok"


def test_score_jobs_in_batches_partial_claude_partial_regex(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Common partial-failure shape: Claude scores some ids, others fall
    through to regex. Both mutations should land on the right rows."""

    def _fake(_cv: str, batch: list[dict]) -> dict:
        # Score only the first id in the batch.
        first = batch[0]
        return {str(first["id"]): {"fit": "good", "score": 9}}

    monkeypatch.setattr(search, "claude_batch_score", _fake)
    monkeypatch.setattr(search, "FIT_POSITIVE", [])
    monkeypatch.setattr(search, "FIT_NEGATIVE", [])
    jobs = [{"id": "a", "_desc": "x"}, {"id": "b", "_desc": "y"}]
    search.score_jobs_in_batches(jobs, "cv")
    assert jobs[0]["scored_by"] == "claude"
    assert jobs[0]["fit"] == "good"
    assert jobs[1]["scored_by"] == "regex"


# ---------------------------------------------------------------------------
# _build_user_feedback_examples — the few-shot loop. Stratification +
# interleaving + recency sort are the meat of the helper. We only assert
# the user-visible properties (count, ordering, contents) — internal
# bucket math gets re-verified via the same observable surface.
# ---------------------------------------------------------------------------


def test_feedback_examples_empty_corpus_returns_empty_string(tmp_path: Path) -> None:
    """No file -> "" so callers can unconditionally concat."""
    assert search._build_user_feedback_examples(corpus_path=tmp_path / "missing.json") == ""


def test_feedback_examples_skips_zero_signal_rows(tmp_path: Path) -> None:
    p = tmp_path / "results.json"
    p.write_text(json.dumps([{"id": "1", "title": "X"}]))  # no rating, no app_status
    assert search._build_user_feedback_examples(corpus_path=p) == ""


def test_feedback_examples_renders_block_with_rated_rows(tmp_path: Path) -> None:
    p = tmp_path / "results.json"
    rows = [
        {
            "id": "1",
            "title": "Senior Engineer",
            "company": "Acme",
            "rating": 5,
            "rated_at": "2026-04-15T10:00:00",
        },
        {
            "id": "2",
            "title": "Junior Dev",
            "company": "Foo Inc",
            "rating": 1,
            "rated_at": "2026-04-14T10:00:00",
        },
    ]
    p.write_text(json.dumps(rows))
    out = search._build_user_feedback_examples(corpus_path=p, cap=10)
    assert "<user_feedback_examples>" in out
    assert "</user_feedback_examples>" in out
    assert "rated 5/5" in out
    assert "rated 1/5" in out


def test_feedback_examples_respects_cap(tmp_path: Path) -> None:
    p = tmp_path / "results.json"
    # 4 positives, 4 negatives — cap=4 should yield exactly 4 example lines.
    rows = []
    for i in range(4):
        rows.append({"id": f"p{i}", "title": "X", "rating": 5, "rated_at": f"2026-04-{15 - i:02d}"})
    for i in range(4):
        rows.append({"id": f"n{i}", "title": "Y", "rating": 1, "rated_at": f"2026-04-{15 - i:02d}"})
    p.write_text(json.dumps(rows))
    out = search._build_user_feedback_examples(corpus_path=p, cap=4)
    # Each example is a single line starting with `- "`.
    line_count = sum(1 for ln in out.splitlines() if ln.startswith('- "'))
    assert line_count == 4


def test_feedback_examples_zero_cap_skips_block(tmp_path: Path) -> None:
    p = tmp_path / "results.json"
    p.write_text(json.dumps([{"id": "1", "rating": 5}]))
    assert search._build_user_feedback_examples(corpus_path=p, cap=0) == ""


# ---------------------------------------------------------------------------
# Issue #124 — hard-pinned few-shot examples. Pinned ids prepended in
# config order before the recency-sorted fillers; excess pinned beyond
# the cap drops from the tail; pinned ids absent from results.json drop
# silently; recency fillers exclude any id already in the pinned section.
# ---------------------------------------------------------------------------


def test_few_shot_includes_pinned_first(tmp_path: Path) -> None:
    """3 pinned + a pool of recent rated jobs → the first 3 lines are the
    pinned rows in config order, then the recency-sorted fillers.
    """
    p = tmp_path / "results.json"
    rows: list[dict] = []
    # 3 pinned positive jobs with older timestamps than the recent ones.
    for pid in ("p1", "p2", "p3"):
        rows.append(
            {
                "id": pid,
                "title": f"Pinned {pid}",
                "company": f"Co {pid}",
                "rating": 5,
                "rated_at": "2025-01-01T00:00:00",
            },
        )
    # 10 recent positive jobs — newer timestamps so they'd otherwise dominate.
    for i in range(10):
        rows.append(
            {
                "id": f"r{i}",
                "title": f"Recent {i}",
                "company": f"Co r{i}",
                "rating": 5,
                "rated_at": f"2026-05-{(i % 28) + 1:02d}T10:00:00",
            },
        )
    # Add some negative signals so the stratifier has something to do
    # in the filler section.
    for i in range(3):
        rows.append(
            {
                "id": f"n{i}",
                "title": f"Bad {i}",
                "company": f"Co n{i}",
                "rating": 1,
                "rated_at": f"2026-04-{(i % 28) + 1:02d}T10:00:00",
            },
        )
    p.write_text(json.dumps(rows))

    out = search._build_user_feedback_examples(
        corpus_path=p,
        cap=8,
        pinned_ids=["p1", "p2", "p3"],
    )
    lines = [ln for ln in out.splitlines() if ln.startswith('- "')]
    # First three lines must be the three pinned rows, in pinned-order.
    assert lines[0].startswith('- "Pinned p1"')
    assert lines[1].startswith('- "Pinned p2"')
    assert lines[2].startswith('- "Pinned p3"')
    # Recency fillers come after — at least one and at most cap - pinned.
    assert len(lines) <= 8


def test_few_shot_drops_pinned_when_deleted(tmp_path: Path) -> None:
    """A pinned id missing from results.json is silently dropped at READ time;
    its slot is reclaimed by the recency-fill section so the prompt isn't
    short-changed.
    """
    p = tmp_path / "results.json"
    rows = [
        {"id": "real", "title": "Real Pinned", "rating": 5, "rated_at": "2025-01-01"},
        {"id": "f1", "title": "Filler 1", "rating": 5, "rated_at": "2026-05-01T10:00:00"},
        {"id": "f2", "title": "Filler 2", "rating": 5, "rated_at": "2026-05-02T10:00:00"},
    ]
    p.write_text(json.dumps(rows))

    out = search._build_user_feedback_examples(
        corpus_path=p,
        cap=5,
        pinned_ids=["ghost", "real", "also-ghost"],
    )
    # `ghost` and `also-ghost` are dropped silently — they don't appear in
    # the output at all (no "user-pinned (no rating)" placeholder for them).
    assert "ghost" not in out
    # `real` survived the resolution.
    assert "Real Pinned" in out
    # Fillers picked up to fill the remaining slots.
    assert "Filler 1" in out
    assert "Filler 2" in out


def test_few_shot_pinned_excess_truncates_end(tmp_path: Path) -> None:
    """pinned=8 with cap=5 → last 3 pinned dropped (tail), no recency-fillers."""
    p = tmp_path / "results.json"
    rows: list[dict] = []
    for i in range(8):
        rows.append(
            {
                "id": f"p{i}",
                "title": f"Pin {i}",
                "rating": 5,
                "rated_at": f"2025-01-{(i % 28) + 1:02d}T00:00:00",
            },
        )
    # Add a fresh recency-positive row that should NOT appear (no room).
    rows.append(
        {
            "id": "fresh",
            "title": "Fresh Filler",
            "rating": 5,
            "rated_at": "2026-12-31T23:59:59",
        },
    )
    p.write_text(json.dumps(rows))

    pinned = [f"p{i}" for i in range(8)]
    out = search._build_user_feedback_examples(corpus_path=p, cap=5, pinned_ids=pinned)
    lines = [ln for ln in out.splitlines() if ln.startswith('- "')]
    # Exactly 5 example lines — pinned tail dropped, NO fillers.
    assert len(lines) == 5
    # The first 5 pinned (in pinned-order) are present; p5, p6, p7 are NOT.
    assert all(f'"Pin {i}"' in lines[i] for i in range(5))
    for dropped_idx in (5, 6, 7):
        assert f'"Pin {dropped_idx}"' not in out
    # The fresh row never reaches the prompt because pinned consumed every slot.
    assert "Fresh Filler" not in out


def test_normalize_pinned_examples_dedups_and_filters() -> None:
    """The normalizer rejects non-strings, empties, whitespace-only, and
    duplicates — preserving original (first-occurrence) order."""
    assert search._normalize_pinned_examples(["", "  ", "a", "a", "b"]) == ["a", "b"]
    # Mixed-type tolerance: numbers / dicts / None entries get dropped silently.
    assert search._normalize_pinned_examples(["x", 7, None, {"id": "y"}, "y"]) == [
        "x",
        "y",
    ]
    # Order-preserving dedup — first occurrence wins.
    assert search._normalize_pinned_examples(["b", "a", "b", "a"]) == ["b", "a"]
    # Non-list payloads collapse to [].
    assert search._normalize_pinned_examples("a,b,c") == []
    assert search._normalize_pinned_examples(None) == []
    assert search._normalize_pinned_examples({"a": 1}) == []


def test_pin_example_endpoint_round_trip() -> None:
    """Mirrors the /api/corpus/pin-example middleware logic at the unit level:
    appending an id then removing it must round-trip through the normalizer
    cleanly. Validates that pinning twice is idempotent (dedup at append
    time) and that unpinning a non-pinned id is a no-op.
    """
    current = search._normalize_pinned_examples([])
    assert current == []

    # First POST with pinned=true → list is ["a"].
    appended = current + ["a"]
    after_pin = search._normalize_pinned_examples(appended)
    assert after_pin == ["a"]

    # Second POST with pinned=true (same id) → still ["a"] (idempotent).
    appended_again = after_pin + ["a"]
    assert search._normalize_pinned_examples(appended_again) == ["a"]

    # Add a second id → list is ["a", "b"] (insertion order preserved).
    after_pin = search._normalize_pinned_examples([*after_pin, "b"])
    assert after_pin == ["a", "b"]

    # POST with pinned=false on "a" → list is ["b"].
    after_unpin = search._normalize_pinned_examples([x for x in after_pin if x != "a"])
    assert after_unpin == ["b"]

    # Unpinning an id that isn't in the list is a no-op (filter is a no-op).
    no_op = search._normalize_pinned_examples([x for x in after_unpin if x != "ghost"])
    assert no_op == ["b"]


def test_pinned_unrated_labeled_correctly(tmp_path: Path) -> None:
    """A pinned row with no rating / kanban / manual signal still reaches the
    prompt, labelled with the canonical PINNED_UNRATED_SUMMARY."""
    p = tmp_path / "results.json"
    rows = [
        # No rating, no app_status, no source="manual" — would normally be
        # invisible to the few-shot loop. But because the user pinned it,
        # the prompt must include it.
        {"id": "naked", "title": "Naked Pin", "company": "X Co"},
        # A positive filler so the prompt isn't empty regardless.
        {"id": "p", "title": "Filler", "rating": 5, "rated_at": "2026-05-01T10:00:00"},
    ]
    p.write_text(json.dumps(rows))

    out = search._build_user_feedback_examples(
        corpus_path=p,
        cap=5,
        pinned_ids=["naked"],
    )
    assert "Naked Pin" in out
    # The canonical "user-pinned (no rating)" marker reaches the prompt so
    # the LLM can tell this example is curation, not classification.
    assert search.PINNED_UNRATED_SUMMARY in out


# ---------------------------------------------------------------------------
# _normalize_categories / _normalize_llm_provider — config validation.
# ---------------------------------------------------------------------------


def test_normalize_categories_drops_malformed_entries() -> None:
    fb: list[dict] = [{"id": "fb", "name": "FB", "type": "keyword", "queries": []}]
    out = search._normalize_categories(
        [
            {"id": "c1", "name": "Real", "type": "keyword", "queries": ["x"]},
            "junk",
            {"queries": ["no id, no name, no type"]},  # gets a synthesized id
            {"id": "c2", "name": "Bad type", "type": "weird", "queries": []},  # type sanitized
        ],
        fallback=fb,
    )
    # "junk" dropped; c1, synthesized, c2 kept
    assert len(out) == 3
    assert out[0]["id"] == "c1"
    assert out[2]["type"] == "keyword"  # 'weird' sanitized


def test_normalize_categories_falls_back_when_all_invalid() -> None:
    fb: list[dict] = [{"id": "fb", "name": "FB", "type": "keyword", "queries": []}]
    assert search._normalize_categories(["junk", 123], fallback=fb) == fb
    assert search._normalize_categories("not a list", fallback=fb) == fb


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ({"name": "auto"}, {"name": "auto"}),
        (
            {"name": "claude_cli", "model": "sonnet-4-5"},
            {"name": "claude_cli", "model": "sonnet-4-5"},
        ),
        ({"name": "  GEMINI "}, {"name": "gemini"}),  # case + whitespace tolerant
        # All six concrete providers must round-trip without coercion.
        ({"name": "claude_cli"}, {"name": "claude_cli"}),
        ({"name": "claude_sdk"}, {"name": "claude_sdk"}),
        ({"name": "gemini"}, {"name": "gemini"}),
        ({"name": "openai"}, {"name": "openai"}),
        ({"name": "openrouter"}, {"name": "openrouter"}),
        ({"name": "ollama"}, {"name": "ollama"}),
        # Unknown provider name -> fallback
        ({"name": "fake"}, {"name": "auto"}),
        # Non-dict -> fallback
        ("junk", {"name": "auto"}),
        ({}, {"name": "auto"}),
        # Whitespace-only model is dropped, name is kept.
        ({"name": "gemini", "model": "  "}, {"name": "gemini"}),
    ],
)
def test_normalize_llm_provider(raw: object, expected: dict) -> None:
    assert search._normalize_llm_provider(raw, fallback={"name": "auto"}) == expected


def test_normalize_llm_provider_openai_round_trips_with_model() -> None:
    """Regression: pre-2026-05 the validator omitted 'openai' from
    _VALID_LLM_PROVIDER_NAMES, so wizard-saved openai configs were silently
    coerced to {'name': 'auto'} on every load_config(). Locks the fix in."""
    raw = {"name": "openai", "model": "gpt-4o"}
    assert search._normalize_llm_provider(raw, fallback={"name": "auto"}) == raw


def test_load_config_preserves_openai_provider(tmp_repo: Path) -> None:
    """End-to-end: write a config.json with llm_provider.name='openai',
    call load_config(), confirm it isn't coerced to 'auto'. The wizard's
    save path is now safe."""
    cfg_payload = {
        "categories": [],
        "llm_provider": {"name": "openai", "model": "gpt-4o-mini"},
    }
    (tmp_repo / "config.json").write_text(json.dumps(cfg_payload))
    loaded = search.load_config()
    assert loaded["llm_provider"] == {"name": "openai", "model": "gpt-4o-mini"}


# ---------------------------------------------------------------------------
# _migrate_legacy_config — schema migration from pre-2026-04-22 format.
# ---------------------------------------------------------------------------


def test_migrate_legacy_config_passthrough_when_categories_present() -> None:
    cfg = {"categories": [{"id": "x", "name": "X", "type": "keyword", "queries": []}]}
    assert search._migrate_legacy_config(cfg) is cfg
    assert cfg["categories"][0]["id"] == "x"


def test_migrate_legacy_config_builds_categories_from_legacy_keys() -> None:
    cfg = {
        "search_queries": ["python", "rust"],
        "company_queries": ["Acme"],
    }
    out = search._migrate_legacy_config(cfg)
    cats = out["categories"]
    assert len(cats) == 2
    crypto = next(c for c in cats if c["id"] == "crypto")
    assert crypto["queries"] == ["python", "rust"]
    company = next(c for c in cats if c["id"] == "company")
    assert company["type"] == "company"


def test_migrate_legacy_config_no_legacy_keys_no_categories_added() -> None:
    cfg = {"max_pages": 5}
    out = search._migrate_legacy_config(cfg)
    assert "categories" not in out


# ---------------------------------------------------------------------------
# _clean_title — LinkedIn double-rendering of titles.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("Senior Engineer\nSenior Engineer", "Senior Engineer"),
        ("Senior Engineer with verification", "Senior Engineer"),
        ("Senior Engineer (verified)", "Senior Engineer"),
        ("Foo\n\n\nBar", "Foo"),
        ("", ""),
        ("   ", ""),
        ("Just one line", "Just one line"),
    ],
)
def test_clean_title(raw: str, expected: str) -> None:
    assert search._clean_title(raw) == expected


# ---------------------------------------------------------------------------
# _build_stealth_js — locale -> navigator.languages array.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("locale", "expected_langs"),
    [
        ("en-US", ["en-US", "en"]),
        ("fr-FR", ["fr-FR", "fr", "en"]),
        ("ja-JP", ["ja-JP", "ja", "en"]),
        # Bare base locale: we don't dupe.
        ("en", ["en"]),
        # Missing -> default
        ("", ["en-US", "en"]),
    ],
)
def test_build_stealth_js(locale: str, expected_langs: list[str]) -> None:
    js = search._build_stealth_js(locale)
    assert json.dumps(expected_langs) in js
    # Stealth must hide the webdriver property; the script accesses it as
    # a property name string, not via dot syntax.
    assert "'webdriver'" in js


# ---------------------------------------------------------------------------
# load_results / save_results_merge — end-to-end round-trip via the
# fixtures so the test never touches the real corpus.
# ---------------------------------------------------------------------------


def test_save_results_merge_dedupes_by_id(tmp_repo: Path) -> None:
    search.save_results_merge([{"id": "1", "title": "First"}])
    search.save_results_merge([{"id": "1", "title": "Should not overwrite"}])
    on_disk = json.loads((tmp_repo / "results.json").read_text())
    assert len(on_disk) == 1
    assert on_disk[0]["title"] == "First"


def test_save_results_merge_appends_new(tmp_repo: Path) -> None:
    search.save_results_merge([{"id": "a", "title": "A"}])
    search.save_results_merge([{"id": "b", "title": "B"}])
    on_disk = json.loads((tmp_repo / "results.json").read_text())
    assert {j["id"] for j in on_disk} == {"a", "b"}


def test_save_seen_merges_into_existing_set(tmp_repo: Path) -> None:
    search.save_seen({"1", "2"})
    search.save_seen({"2", "3"})
    on_disk = set(json.loads((tmp_repo / "seen_jobs.json").read_text()))
    assert on_disk == {"1", "2", "3"}


def test_load_seen_handles_missing_file(tmp_repo: Path) -> None:  # noqa: ARG001
    assert search.load_seen() == set()


def test_load_results_handles_missing_file(tmp_repo: Path) -> None:  # noqa: ARG001
    assert search.load_results() == []


def test_load_results_returns_empty_on_non_list_payload(tmp_repo: Path) -> None:
    (tmp_repo / "results.json").write_text(json.dumps({"runs": []}))
    assert search.load_results() == []


def test_append_run_history_caps_at_n(tmp_repo: Path) -> None:
    """The cap keeps run_history.json from growing unbounded."""
    for i in range(5):
        search._append_run_history({"i": i}, cap=3)
    runs = json.loads((tmp_repo / "run_history.json").read_text())["runs"]
    # 5 appended, capped at 3 — only the last 3 survive.
    assert [r["i"] for r in runs] == [2, 3, 4]


# ---------------------------------------------------------------------------
# _category_name_for_id — depends on module-level _ACTIVE_CONFIG.
# ---------------------------------------------------------------------------


def test_category_name_for_id_resolves_from_active_config(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        search,
        "_ACTIVE_CONFIG",
        {"categories": [{"id": "ml", "name": "Machine Learning"}]},
    )
    assert search._category_name_for_id("ml") == "Machine Learning"


def test_category_name_for_id_falls_back_to_id(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(search, "_ACTIVE_CONFIG", {"categories": []})
    assert search._category_name_for_id("unknown") == "unknown"


# ---------------------------------------------------------------------------
# _detect_system_locale — env var parsing.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("env", "expected"),
    [
        ({"LC_ALL": "en_US.UTF-8"}, "en-US"),
        ({"LANG": "fr_FR.UTF-8"}, "fr-FR"),
        ({"LANG": "ja_JP@cjk"}, "ja-JP"),
        # POSIX / C locale -> default fallback
        ({"LANG": "C"}, "en-US"),
        ({"LANG": "POSIX"}, "en-US"),
        # LC_ALL beats LANG
        ({"LC_ALL": "de_DE.UTF-8", "LANG": "fr_FR.UTF-8"}, "de-DE"),
        # Nothing set -> default
        ({}, "en-US"),
    ],
)
def test_detect_system_locale(env: dict, expected: str, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("LC_ALL", raising=False)
    monkeypatch.delenv("LANG", raising=False)
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    assert search._detect_system_locale() == expected


# ---------------------------------------------------------------------------
# Parallel batch scoring — _retry_score_batch + score_jobs_in_batches.
# Validates the ThreadPoolExecutor wiring + retry-with-backoff added in
# 2026-05 to bring scoring wall-clock from ~5-11min sequential to ~90-180s.
# ---------------------------------------------------------------------------


def _stub_jobs(n: int) -> list[dict]:
    """Cheap synthetic batch-shaped jobs. Just need an `id` field plus the
    couple of keys _apply_*_fallback / _apply_claude_scoring touch."""
    return [
        {"id": f"job{i}", "title": "Engineer", "_desc": "python role", "company": "Co"}
        for i in range(n)
    ]


def test_retry_score_batch_retries_on_transient_then_succeeds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """First two attempts raise, third returns a valid scoring map. Helper
    must end up with exactly three calls and the success result, sleeping
    twice with the documented exponential schedule."""
    calls: list[int] = []
    sleeps: list[float] = []

    def fake_score(cv: str, batch: list[dict]) -> dict:
        calls.append(len(calls))
        if len(calls) <= 2:
            raise ConnectionError("transient")
        return {"job0": {"fit": "good", "score": 9}}

    monkeypatch.setattr(search, "claude_batch_score", fake_score)
    out = search._retry_score_batch(
        "cv",
        [{"id": "job0"}],
        sleep=lambda s: sleeps.append(s),
    )
    assert out == {"job0": {"fit": "good", "score": 9}}
    assert len(calls) == 3
    # Default backoff: base=1.0, factor=4 -> [1.0, 4.0]
    assert sleeps == [1.0, 4.0]


def test_retry_score_batch_gives_up_after_max_retries(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """All four attempts raise — helper returns None and the caller's regex
    fallback handles the miss. We must see exactly max_retries+1 calls."""
    calls: list[int] = []

    def always_raise(cv: str, batch: list[dict]) -> dict:
        calls.append(0)
        raise TimeoutError("rate limited")

    monkeypatch.setattr(search, "claude_batch_score", always_raise)
    out = search._retry_score_batch("cv", [{"id": "j"}], sleep=lambda s: None)
    assert out is None
    # 1 initial + max_retries (3) retries = 4 total calls.
    assert len(calls) == search._BATCH_MAX_RETRIES + 1


def test_retry_score_batch_skips_retry_on_permanent_401(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """401/403 surfaces as None on the first failed attempt — no point in
    burning the full retry budget on a bad API key."""
    calls: list[int] = []

    class _AuthError(Exception):
        status_code = 401

    def auth_fail(cv: str, batch: list[dict]) -> dict:
        calls.append(0)
        raise _AuthError("Unauthorized")

    monkeypatch.setattr(search, "claude_batch_score", auth_fail)
    out = search._retry_score_batch("cv", [{"id": "j"}], sleep=lambda s: None)
    assert out is None
    assert len(calls) == 1  # bailed immediately


def test_retry_score_batch_skips_retry_on_permanent_403(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Same as 401 but via response.status_code (httpx-style nested attr)."""

    class _Resp:
        status_code = 403
        headers = {}

    class _ForbiddenError(Exception):
        def __init__(self) -> None:
            super().__init__("Forbidden")
            self.response = _Resp()

    calls: list[int] = []

    def forbid(cv: str, batch: list[dict]) -> dict:
        calls.append(0)
        raise _ForbiddenError()

    monkeypatch.setattr(search, "claude_batch_score", forbid)
    out = search._retry_score_batch("cv", [{"id": "j"}], sleep=lambda s: None)
    assert out is None
    assert len(calls) == 1


def test_retry_score_batch_honors_retry_after_header(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When the exception carries a Retry-After header, we sleep for that
    interval instead of the exponential default. Anthropic + OpenAI rate
    limit responses include this and we must obey it."""
    sleeps: list[float] = []

    class _Resp:
        status_code = 429
        headers = {"retry-after": "7"}

    class _RateLimitError(Exception):
        def __init__(self) -> None:
            super().__init__("rate limited")
            self.response = _Resp()

    state = {"n": 0}

    def maybe_succeed(cv: str, batch: list[dict]) -> dict:
        state["n"] += 1
        if state["n"] == 1:
            raise _RateLimitError()
        return {"j": {"fit": "ok", "score": 5}}

    monkeypatch.setattr(search, "claude_batch_score", maybe_succeed)
    out = search._retry_score_batch("cv", [{"id": "j"}], sleep=lambda s: sleeps.append(s))
    assert out == {"j": {"fit": "ok", "score": 5}}
    assert sleeps == [7.0]


def test_score_jobs_in_batches_continues_when_one_batch_fails_repeatedly(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """End-to-end: many jobs split into >2 batches; one batch raises every
    attempt, the rest succeed. After the parallel run, every job ends up
    scored — the failed batch via regex fallback, the rest via claude.
    No exception escapes."""
    jobs = _stub_jobs(search.BATCH_SIZE * 3)  # exactly 3 batches
    bad_idx = 1  # second batch

    def variable_score(cv: str, batch: list[dict]) -> dict:
        if any(j["id"] == jobs[bad_idx * search.BATCH_SIZE]["id"] for j in batch):
            raise ConnectionError("network blip")
        return {j["id"]: {"fit": "good", "score": 8, "reasons": ["match"]} for j in batch}

    monkeypatch.setattr(search, "claude_batch_score", variable_score)
    # Skip the real backoff sleep so the test runs fast.
    monkeypatch.setattr(search.time, "sleep", lambda s: None)

    scored, _filtered_out, completed, failed = search.score_jobs_in_batches(jobs, "cv")
    assert scored is True  # at least one batch succeeded
    # `_retry_score_batch` swallows the ConnectionError per its retry envelope
    # and returns None — so the bad batch is "completed" from the executor's
    # POV (no exception escaped) but its scoring map is None, hence regex
    # fallback. `batches_failed` stays at 0 for this shape; it would only
    # increment if something escaped the retry envelope.
    assert completed == 3
    assert failed == 0
    # Bad batch -> regex fallback applied.
    bad_batch = jobs[bad_idx * search.BATCH_SIZE : (bad_idx + 1) * search.BATCH_SIZE]
    for j in bad_batch:
        assert j["scored_by"] == "regex"
    # Other batches -> claude scoring applied.
    other = jobs[: search.BATCH_SIZE] + jobs[2 * search.BATCH_SIZE :]
    for j in other:
        assert j["scored_by"] == "claude"
        assert j["score"] == 8


def test_score_jobs_in_batches_runs_batches_in_parallel(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Crude concurrency check: if all batches sleep 0.3s and there are 4 of
    them, sequential would take 1.2s; parallel (max_workers=4) should finish
    in well under 0.6s. We assert <0.9s to leave generous headroom for slow
    CI machines while still catching a regression to sequential."""
    import threading
    import time as time_mod

    jobs = _stub_jobs(search.BATCH_SIZE * 4)
    in_flight: list[int] = []
    max_concurrent = {"v": 0}
    lock = threading.Lock()

    def slow_score(cv: str, batch: list[dict]) -> dict:
        with lock:
            in_flight.append(1)
            if len(in_flight) > max_concurrent["v"]:
                max_concurrent["v"] = len(in_flight)
        time_mod.sleep(0.3)
        with lock:
            in_flight.pop()
        return {j["id"]: {"fit": "ok", "score": 5, "reasons": []} for j in batch}

    monkeypatch.setattr(search, "claude_batch_score", slow_score)
    t0 = time_mod.monotonic()
    search.score_jobs_in_batches(jobs, "cv")
    elapsed = time_mod.monotonic() - t0
    # 4 batches * 0.3s sequential = 1.2s; parallel should be ~0.3s.
    assert elapsed < 0.9, f"score_jobs_in_batches ran sequentially: {elapsed:.2f}s"
    # And we observed real concurrency (>=2 batches in flight at once).
    assert max_concurrent["v"] >= 2


# ---------------------------------------------------------------------------
# Per-batch streaming writes — score_jobs_in_batches(persist_per_batch=True)
# writes each batch's seen ids + corpus rows under fcntl lock as the futures
# complete, instead of holding everything in RAM until end of run.
# Crash safety + live UI progress.
# ---------------------------------------------------------------------------


def test_score_jobs_in_batches_writes_per_batch(
    tmp_repo: Path,  # noqa: ARG001 — fixture redirects RESULTS_FILE / SEEN_FILE
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With persist_per_batch=True, save_results_merge + save_seen fire once
    per completed batch — NOT once with everything at end. Spy on both
    helpers to count invocations."""
    monkeypatch.setattr(search, "BATCH_SIZE", 2)
    monkeypatch.setattr(
        search, "_ACTIVE_CONFIG", {"corpus_filter": {"min_fit": None, "min_score": None}}
    )

    def deterministic(_cv: str, batch: list[dict]) -> dict:
        return {str(j["id"]): {"fit": "good", "score": 8, "reasons": []} for j in batch}

    monkeypatch.setattr(search, "claude_batch_score", deterministic)

    save_results_calls: list[int] = []
    save_seen_calls: list[int] = []
    real_save_results = search.save_results_merge
    real_save_seen = search.save_seen

    def spy_save_results(new_jobs: list) -> None:
        save_results_calls.append(len(new_jobs))
        real_save_results(new_jobs)

    def spy_save_seen(seen: set) -> None:
        save_seen_calls.append(len(seen))
        real_save_seen(seen)

    monkeypatch.setattr(search, "save_results_merge", spy_save_results)
    monkeypatch.setattr(search, "save_seen", spy_save_seen)

    jobs = [{"id": f"j{i}", "_desc": "desc"} for i in range(6)]
    scored, filtered_out, completed, failed = search.score_jobs_in_batches(
        jobs, "cv", persist_per_batch=True
    )

    assert scored is True
    assert filtered_out == 0
    assert completed == 3  # 6 jobs / batch_size 2 = 3 batches
    assert failed == 0
    # One write per batch — NOT one big write at the end.
    assert len(save_results_calls) == 3, (
        f"expected 3 per-batch save_results_merge calls, got {save_results_calls}"
    )
    assert len(save_seen_calls) == 3, f"expected 3 per-batch save_seen calls, got {save_seen_calls}"


def test_score_jobs_in_batches_partial_failure_continues(
    tmp_repo: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """4 batches; batch index 1's future raises (simulating an unexpected
    error that escapes _retry_score_batch's envelope). The remaining 3
    batches must still complete and persist, batches_failed must be 1."""
    monkeypatch.setattr(search, "BATCH_SIZE", 2)
    monkeypatch.setattr(
        search, "_ACTIVE_CONFIG", {"corpus_filter": {"min_fit": None, "min_score": None}}
    )

    def scorer(_cv: str, batch: list[dict]) -> dict:
        return {str(j["id"]): {"fit": "ok", "score": 5, "reasons": []} for j in batch}

    monkeypatch.setattr(search, "claude_batch_score", scorer)

    # Inject a hard failure into _retry_score_batch for batch index 1's ids.
    # _retry_score_batch normally swallows; raising directly bypasses its
    # envelope, surfaces at the executor, and triggers the per-batch except.
    real_retry = search._retry_score_batch
    bad_ids = {"j2", "j3"}  # batch index 1 = jobs 2,3

    def flaky_retry(cv_text: str, batch: list[dict], **kw):  # type: ignore[no-untyped-def]
        if any(j["id"] in bad_ids for j in batch):
            raise RuntimeError("simulated unrecoverable batch failure")
        return real_retry(cv_text, batch, **kw)

    monkeypatch.setattr(search, "_retry_score_batch", flaky_retry)

    jobs = [{"id": f"j{i}", "_desc": "desc"} for i in range(8)]  # 4 batches of 2
    scored, _filtered_out, completed, failed = search.score_jobs_in_batches(
        jobs, "cv", persist_per_batch=True
    )

    assert scored is True
    assert completed == 3
    assert failed == 1

    # Surviving batches' ids must be in results.json + seen_jobs.json.
    on_disk_results = json.loads((tmp_repo / "results.json").read_text())
    on_disk_seen = set(json.loads((tmp_repo / "seen_jobs.json").read_text()))
    surviving_ids = {f"j{i}" for i in range(8)} - bad_ids
    persisted_ids = {j["id"] for j in on_disk_results}
    assert surviving_ids <= persisted_ids, (
        f"expected surviving batches in corpus, got {persisted_ids}"
    )
    assert surviving_ids <= on_disk_seen
    # The failed batch's ids should NOT have been persisted (the future
    # raised before _finalize_batch ran for that batch).
    assert not (bad_ids & persisted_ids)


def test_score_jobs_in_batches_filter_applied_per_batch(
    tmp_repo: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With corpus_filter min_fit='good', only good-fit jobs land in
    results.json; seen_jobs.json gets every scored id regardless."""
    monkeypatch.setattr(search, "BATCH_SIZE", 2)
    monkeypatch.setattr(
        search, "_ACTIVE_CONFIG", {"corpus_filter": {"min_fit": "good", "min_score": None}}
    )

    # Two batches: first all "good", second all "ok" (must be filtered out).
    def scorer(_cv: str, batch: list[dict]) -> dict:
        out = {}
        for j in batch:
            fit = "good" if j["id"].startswith("g") else "ok"
            out[str(j["id"])] = {"fit": fit, "score": 8, "reasons": []}
        return out

    monkeypatch.setattr(search, "claude_batch_score", scorer)

    jobs = [
        {"id": "g1", "_desc": "x"},
        {"id": "g2", "_desc": "x"},
        {"id": "ok1", "_desc": "x"},
        {"id": "ok2", "_desc": "x"},
    ]
    scored, filtered_out, completed, failed = search.score_jobs_in_batches(
        jobs, "cv", persist_per_batch=True
    )

    assert scored is True
    assert completed == 2
    assert failed == 0
    assert filtered_out == 2  # both "ok" jobs dropped

    on_disk_results = json.loads((tmp_repo / "results.json").read_text())
    on_disk_seen = set(json.loads((tmp_repo / "seen_jobs.json").read_text()))
    corpus_ids = {j["id"] for j in on_disk_results}
    assert corpus_ids == {"g1", "g2"}, f"only 'good' jobs should be in corpus, got {corpus_ids}"
    # Every scored id — pass or fail filter — lands in seen so it never
    # burns another LLM call on the next run.
    assert on_disk_seen == {"g1", "g2", "ok1", "ok2"}


def test_score_jobs_in_batches_crash_preserves_completed_batches(
    tmp_repo: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """If a fatal error rips through the executor partway through, the
    batches that ran to completion + their per-batch writes must survive on
    disk. Simulated by sleeping in the third batch's mock to ensure the
    first two finish first, then raising SystemExit out of the as_completed
    loop via a SystemExit (which bypasses the executor's exception envelope
    — it's a BaseException, not Exception)."""
    import threading
    import time as time_mod

    monkeypatch.setattr(search, "BATCH_SIZE", 2)
    monkeypatch.setattr(
        search, "_ACTIVE_CONFIG", {"corpus_filter": {"min_fit": None, "min_score": None}}
    )

    completed_event = threading.Event()

    def scorer(_cv: str, batch: list[dict]) -> dict:
        if any(j["id"] in {"j4", "j5"} for j in batch):
            # Wait until first two batches' results are written, then bail.
            completed_event.wait(timeout=5.0)
            raise SystemExit("simulated crash mid-scoring")
        return {str(j["id"]): {"fit": "ok", "score": 5, "reasons": []} for j in batch}

    monkeypatch.setattr(search, "claude_batch_score", scorer)

    # Wrap save_results_merge so we trip completed_event once the first two
    # batches have persisted — then the third batch (sleeping in scorer)
    # is allowed to crash.
    real_save_results = search.save_results_merge
    persist_count = {"n": 0}

    def trip_after_two(new_jobs: list) -> None:
        real_save_results(new_jobs)
        persist_count["n"] += 1
        if persist_count["n"] >= 2:
            completed_event.set()

    monkeypatch.setattr(search, "save_results_merge", trip_after_two)

    jobs = [{"id": f"j{i}", "_desc": "x"} for i in range(6)]  # 3 batches of 2
    # SystemExit is a BaseException — it escapes ThreadPoolExecutor's
    # standard envelope and propagates out of as_completed. We catch it at
    # the test level (matching the user spec: "simulate by having the 3rd
    # batch's future raise SystemExit and catching it at the test level").
    with contextlib.suppress(SystemExit):
        search.score_jobs_in_batches(jobs, "cv", persist_per_batch=True)

    on_disk_results = json.loads((tmp_repo / "results.json").read_text())
    on_disk_seen = set(json.loads((tmp_repo / "seen_jobs.json").read_text()))
    surviving_ids = {j["id"] for j in on_disk_results}
    # First two batches' rows survived the simulated crash because they were
    # written eagerly per-batch. The fact that the third batch crashed
    # mid-flight didn't roll them back.
    assert {"j0", "j1", "j2", "j3"} <= surviving_ids, (
        f"completed batches should survive crash, got {surviving_ids}"
    )
    assert {"j0", "j1", "j2", "j3"} <= on_disk_seen


# ---------------------------------------------------------------------------
# _passes_corpus_filter — post-scoring gate (issue #117).
# ---------------------------------------------------------------------------


def _set_corpus_filter(
    monkeypatch: pytest.MonkeyPatch,
    *,
    min_fit: str | None = None,
    min_score: int | None = None,
) -> None:
    monkeypatch.setattr(
        search,
        "_ACTIVE_CONFIG",
        {"corpus_filter": {"min_fit": min_fit, "min_score": min_score}},
    )


# Cross product of (min_fit ∈ {None, "ok", "good"}) × (min_score ∈ {None, 5})
# × representative (fit, score) pairs. 24 cases.
@pytest.mark.parametrize(
    ("min_fit", "min_score", "job_fit", "job_score", "expected"),
    [
        # min_fit=None, min_score=None — filter off, everything passes.
        (None, None, "good", 10, True),
        (None, None, "ok", 5, True),
        (None, None, "skip", 1, True),
        (None, None, None, None, True),
        # min_fit=None, min_score=5 — only score matters.
        (None, 5, "good", 10, True),
        (None, 5, "ok", 5, True),  # threshold edge: equal passes
        (None, 5, "good", 4, False),
        (None, 5, "skip", 1, False),
        (None, 5, "good", None, False),  # missing score treated as 0
        # min_fit="ok", min_score=None — fit must be at least "ok".
        ("ok", None, "good", 10, True),
        ("ok", None, "ok", 5, True),
        ("ok", None, "skip", 1, False),
        ("ok", None, None, 5, False),  # null fit < bad
        # min_fit="good", min_score=None — fit must be "good".
        ("good", None, "good", 10, True),
        ("good", None, "ok", 5, False),
        ("good", None, "skip", 1, False),
        # min_fit="good", min_score=5 — both gates apply.
        ("good", 5, "good", 10, True),
        ("good", 5, "good", 4, False),
        ("good", 5, "ok", 10, False),
        # Non-numeric score with score gate set — treated as 0.
        (None, 5, "good", "huge", False),
        # Score=0 with min_score=0 — boundary passes.
        (None, 0, "ok", 0, True),
        # min_fit="ok" + score gate off — fit gate alone decides.
        ("ok", None, "ok", None, True),
    ],
)
def test_passes_corpus_filter_matrix(
    monkeypatch: pytest.MonkeyPatch,
    min_fit: str | None,
    min_score: int | None,
    job_fit: str | None,
    job_score: object,
    expected: bool,
) -> None:
    _set_corpus_filter(monkeypatch, min_fit=min_fit, min_score=min_score)
    job = {"fit": job_fit, "score": job_score}
    assert search._passes_corpus_filter(job) is expected


def test_passes_corpus_filter_missing_active_config(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """_ACTIVE_CONFIG=None (defensive — never happens at runtime today)
    must not crash the helper. It should treat that as "filter off"."""
    monkeypatch.setattr(search, "_ACTIVE_CONFIG", None)
    assert search._passes_corpus_filter({"fit": "skip", "score": 0}) is True


def test_passes_corpus_filter_missing_corpus_filter_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Active config without the corpus_filter key (legacy / pre-feature
    in-memory configs) treats the filter as off."""
    monkeypatch.setattr(search, "_ACTIVE_CONFIG", {"some_other_field": True})
    assert search._passes_corpus_filter({"fit": "skip", "score": 0}) is True


def test_normalize_corpus_filter_drops_unknown_min_fit() -> None:
    out = search._normalize_corpus_filter({"min_fit": "bad", "min_score": 5})
    # "bad" isn't a valid min_fit (the rank baseline) — drop it.
    assert out == {"min_fit": None, "min_score": 5}


def test_normalize_corpus_filter_drops_out_of_range_score() -> None:
    assert search._normalize_corpus_filter({"min_fit": None, "min_score": 99}) == {
        "min_fit": None,
        "min_score": None,
    }
    assert search._normalize_corpus_filter({"min_fit": None, "min_score": -1}) == {
        "min_fit": None,
        "min_score": None,
    }


def test_normalize_corpus_filter_rejects_bool_score() -> None:
    """bool is a subclass of int but True/False have no meaning here."""
    assert search._normalize_corpus_filter({"min_score": True}) == {
        "min_fit": None,
        "min_score": None,
    }


def test_normalize_corpus_filter_non_dict_payload() -> None:
    assert search._normalize_corpus_filter("not a dict") == {
        "min_fit": None,
        "min_score": None,
    }
    assert search._normalize_corpus_filter(None) == {
        "min_fit": None,
        "min_score": None,
    }


def test_hardcoded_defaults_include_corpus_filter() -> None:
    """The schema must include corpus_filter so the UI's defaults.json
    round-trip materializes the field on first load. Both sub-fields
    null = filter disabled = pre-feature behavior."""
    defaults = search._hardcoded_defaults()
    assert defaults["corpus_filter"] == {"min_fit": None, "min_score": None}


def test_load_config_migration_injects_corpus_filter(
    tmp_repo: Path,
) -> None:
    """Legacy config.json (no corpus_filter key) loads with the disabled-
    filter shape and behaves identically to today."""
    (tmp_repo / "config.json").write_text(
        json.dumps(
            {
                "categories": [],
                "location": "Remote",
                "date_filter": "",
                "geo_id": "",
                "max_pages": 3,
                "priority_companies": [],
            }
        )
    )
    cfg = search.load_config()
    assert cfg["corpus_filter"] == {"min_fit": None, "min_score": None}


def test_load_config_normalizes_malformed_corpus_filter(tmp_repo: Path) -> None:
    """Malformed corpus_filter block doesn't break load_config — it
    silently falls back to the disabled-filter shape."""
    (tmp_repo / "config.json").write_text(
        json.dumps(
            {
                "categories": [],
                "location": "Remote",
                "date_filter": "",
                "geo_id": "",
                "max_pages": 3,
                "priority_companies": [],
                "corpus_filter": {"min_fit": "garbage", "min_score": "five"},
            }
        )
    )
    cfg = search.load_config()
    assert cfg["corpus_filter"] == {"min_fit": None, "min_score": None}


def test_load_config_accepts_valid_corpus_filter(tmp_repo: Path) -> None:
    (tmp_repo / "config.json").write_text(
        json.dumps(
            {
                "categories": [],
                "location": "Remote",
                "date_filter": "",
                "geo_id": "",
                "max_pages": 3,
                "priority_companies": [],
                "corpus_filter": {"min_fit": "good", "min_score": 7},
            }
        )
    )
    cfg = search.load_config()
    assert cfg["corpus_filter"] == {"min_fit": "good", "min_score": 7}


# ---------------------------------------------------------------------------
# _record_run_history — surfaces filtered_out count (issue #117).
# ---------------------------------------------------------------------------


def test_record_run_history_includes_filtered_out(
    tmp_repo: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The run_history.json entry must carry totals.filtered_out so the
    UI's Corpus Filter card can surface "X filtered last run"."""
    from argparse import Namespace
    from datetime import datetime
    from time import perf_counter

    args = Namespace(all=False, no_enrich=False, all_time=False, pages=None)
    search._record_run_history(
        args,
        new_jobs=[
            {"id": "1", "fit": "good", "scored_by": "claude"},
            {"id": "2", "fit": "ok", "scored_by": "claude"},
            {"id": "3", "fit": "skip", "scored_by": "title-filter"},
        ],
        diagnosis_counts={"ok": 2, "error": 0},
        per_query_stats=[],
        run_errors=[],
        started_at=datetime.now(),
        started_perf=perf_counter() - 1.0,
        max_pages=3,
        filtered_out=4,
    )
    raw = json.loads((tmp_repo / "run_history.json").read_text())
    runs = raw["runs"]
    assert len(runs) == 1
    assert runs[0]["totals"]["filtered_out"] == 4


def test_record_run_history_defaults_filtered_out_zero(
    tmp_repo: Path,
) -> None:
    """Callers that don't pass filtered_out (legacy callers, mock-call
    paths) get 0 — the default — so older history rows stay parseable."""
    from argparse import Namespace
    from datetime import datetime
    from time import perf_counter

    args = Namespace(all=False, no_enrich=False, all_time=False, pages=None)
    search._record_run_history(
        args,
        new_jobs=[],
        diagnosis_counts={"ok": 0, "error": 0},
        per_query_stats=[],
        run_errors=[],
        started_at=datetime.now(),
        started_perf=perf_counter() - 1.0,
        max_pages=3,
    )
    raw = json.loads((tmp_repo / "run_history.json").read_text())
    assert raw["runs"][0]["totals"]["filtered_out"] == 0


def test_record_run_history_includes_batch_counts(
    tmp_repo: Path,
) -> None:
    """run_history.json must carry totals.batches_completed and
    totals.batches_failed so the UI can surface partial-failure runs."""
    from argparse import Namespace
    from datetime import datetime
    from time import perf_counter

    args = Namespace(all=False, no_enrich=False, all_time=False, pages=None)
    search._record_run_history(
        args,
        new_jobs=[],
        diagnosis_counts={"ok": 0, "error": 0},
        per_query_stats=[],
        run_errors=[],
        started_at=datetime.now(),
        started_perf=perf_counter() - 1.0,
        max_pages=3,
        filtered_out=2,
        batches_completed=5,
        batches_failed=1,
    )
    raw = json.loads((tmp_repo / "run_history.json").read_text())
    totals = raw["runs"][0]["totals"]
    assert totals["filtered_out"] == 2
    assert totals["batches_completed"] == 5
    assert totals["batches_failed"] == 1


def test_record_run_history_defaults_batch_counts_zero(
    tmp_repo: Path,
) -> None:
    """Legacy callers that don't pass the new fields get 0 — keeps older
    history rows parseable and the UI's "show failures" badge silent."""
    from argparse import Namespace
    from datetime import datetime
    from time import perf_counter

    args = Namespace(all=False, no_enrich=False, all_time=False, pages=None)
    search._record_run_history(
        args,
        new_jobs=[],
        diagnosis_counts={"ok": 0, "error": 0},
        per_query_stats=[],
        run_errors=[],
        started_at=datetime.now(),
        started_perf=perf_counter() - 1.0,
        max_pages=3,
    )
    totals = json.loads((tmp_repo / "run_history.json").read_text())["runs"][0]["totals"]
    assert totals["batches_completed"] == 0
    assert totals["batches_failed"] == 0


# ---------------------------------------------------------------------------
# Manual-add bypass — process_one_job with persist=True writes through the
# scoring branch's save_results_merge directly (not via the corpus-filter
# gate in main()). A manually added job with fit=None must still land in
# the corpus even when the filter is set to its strictest mode.
# ---------------------------------------------------------------------------


def test_manual_add_bypasses_corpus_filter(
    tmp_repo: Path, monkeypatch: pytest.MonkeyPatch, sample_job: dict
) -> None:
    """Manual-add (process_one_job(persist=True)) writes to results.json
    via save_results_merge BEFORE the main loop's gate runs. So even with
    the filter on its strictest setting, the manual-added row lands."""
    _set_corpus_filter(monkeypatch, min_fit="good", min_score=10)

    # Patch out fetch / claude / regex so process_one_job exercises just
    # its title-filter + persist path. A non-offtopic title with no LLM
    # backend leaves fit=None, score=None — exactly the shape a user-
    # typed URL produces before LinkedIn metadata is scraped.
    monkeypatch.setattr(search, "claude_batch_score", lambda _cv, _jobs: None)
    monkeypatch.setattr(
        search,
        "_apply_regex_fallback",
        lambda job, _desc: job,
    )

    def fake_fetch(_job: dict) -> tuple[str, str]:
        return "", "empty"

    job = dict(sample_job)
    job["title"] = "Site Reliability Engineer"  # not offtopic
    search.process_one_job(
        job,
        cv_text="",
        fetch_one=fake_fetch,
        persist=True,
        already_scored=False,
    )

    # Manual-add row must be on disk even though it has fit=None.
    on_disk = json.loads((tmp_repo / "results.json").read_text())
    assert any(j.get("id") == sample_job["id"] for j in on_disk), (
        "manual-added job was unexpectedly dropped — corpus filter must not "
        "apply to the process_one_job(persist=True) write path."
    )
