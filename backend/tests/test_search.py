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
def test_is_obviously_offtopic(title: str, is_offtopic: bool) -> None:
    result = search.is_obviously_offtopic(title)
    if is_offtopic:
        assert result is not None, f"expected a regex match for {title!r}"
    else:
        assert result is None, f"expected NO match for {title!r} but matched {result!r}"


def test_is_obviously_offtopic_returns_pattern_string() -> None:
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

    monkeypatch.setattr(pathlib, "Path", _patched_path)
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

    monkeypatch.setattr(pathlib, "Path", _patched_path)
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

    monkeypatch.setattr(pathlib, "Path", _patched_path)
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
    assert search.score_jobs_in_batches([], "cv") is None


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
    result = search.score_jobs_in_batches(jobs, "cv text")
    assert result is True
    assert calls == [8, 8, 1]
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
    result = search.score_jobs_in_batches(jobs, "cv text")
    assert result is False  # never scored anything via Claude
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
        # Unknown provider name -> fallback
        ({"name": "fake"}, {"name": "auto"}),
        # Non-dict -> fallback
        ("junk", {"name": "auto"}),
        ({}, {"name": "auto"}),
        # Empty model is dropped (gemini is in _VALID_LLM_PROVIDER_NAMES;
        # NOTE: 'openai' is NOT — see search.py:890 _VALID_LLM_PROVIDER_NAMES.
        # That set omits openai while llm/__init__.py PROVIDERS includes it,
        # so an openai config is silently downgraded to {"name": "auto"}.
        # Bug noted in final report — backend/search.py:890.
        ({"name": "gemini", "model": "  "}, {"name": "gemini"}),
    ],
)
def test_normalize_llm_provider(raw: object, expected: dict) -> None:
    assert search._normalize_llm_provider(raw, fallback={"name": "auto"}) == expected


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
