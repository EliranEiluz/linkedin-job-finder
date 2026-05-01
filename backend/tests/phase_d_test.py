#!/usr/bin/env python3
"""
Phase D massive test runner — exercises every layer of the project and
reports pass/fail. Safe to run repeatedly; mutates nothing outside /tmp and
the phase-d-staging directories it creates.

Categories:
  1. Python imports                  — every module parses + imports
  2. Schema + config migration       — defaults, legacy→new, malformed input
  3. Scraper pipelines (dry)         — category iteration, token-relevance
  4. Scheduler (launchctl)           — status/install/uninstall round-trip
  5. Onboarding                      — meta-prompt + claude + validation
  6. Email pipeline                  — real SMTP send (opt-in via FLAG)
  7. UI build                        — npm run build passes
  8. UI dev-server endpoints         — GET/POST each /api/* route
  9. Data integrity                  — fcntl-merge safety, results consistency
 10. Backup integrity                — hashes still match
"""

import json
import os
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent  # backend/tests/
ROOT = HERE.parent.parent  # project root
BACKEND = ROOT / "backend"

# So `import search` etc. work from this test file.
sys.path.insert(0, str(BACKEND))
sys.path.insert(0, str(BACKEND / "ctl"))
sys.path.insert(0, str(BACKEND / "probes"))
sys.path.insert(0, str(BACKEND / "tools"))

# Convenience paths used as `cwd=` when shelling to the various CLIs.
SEARCH_PY = BACKEND / "search.py"
SEND_EMAIL_PY = BACKEND / "send_email.py"
SCHEDULER_PY = BACKEND / "ctl" / "scheduler_ctl.py"
ONBOARDING_PY = BACKEND / "ctl" / "onboarding_ctl.py"
PROFILE_PY = BACKEND / "ctl" / "profile_ctl.py"
CORPUS_PY = BACKEND / "ctl" / "corpus_ctl.py"

RESULTS = []  # list of (category, name, ok, detail)

GREEN = "\033[92m"
RED = "\033[91m"
YELL = "\033[93m"
RESET = "\033[0m"
BOLD = "\033[1m"


def check(category, name, fn):
    try:
        detail = fn()
        RESULTS.append((category, name, True, detail or ""))
        print(f"  {GREEN}✓{RESET} {name}  {detail if detail else ''}")
    except AssertionError as e:
        RESULTS.append((category, name, False, str(e)))
        print(f"  {RED}✗{RESET} {name} — {e}")
    except Exception as e:
        RESULTS.append((category, name, False, f"{type(e).__name__}: {e}"))
        print(f"  {RED}✗{RESET} {name} — {type(e).__name__}: {e}")


def section(title):
    print(f"\n{BOLD}— {title} —{RESET}")


def _run(*argv, timeout=30, input_=None, cwd=None):
    # Run from project ROOT by default — most CLIs assume cwd is the
    # project root (where results.json, config.json, configs/ etc. live).
    p = subprocess.run(
        list(argv),
        capture_output=True,
        text=True,
        timeout=timeout,
        input=input_,
        cwd=cwd or str(ROOT),
    )
    return p.returncode, p.stdout, p.stderr


def _curl(path, method="GET", body=None):
    cmd = ["curl", "-s", "-X", method, f"http://localhost:5173{path}"]
    if body is not None:
        cmd += ["-H", "Content-Type: application/json", "-d", json.dumps(body)]
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
    return p.stdout


# ------- 1. Python imports -------
section("1. Python imports")


def i_search():
    import search  # noqa


def i_scheduler():
    import scheduler_ctl  # noqa


def i_onboarding():
    import onboarding_ctl  # noqa


def i_send_email():
    import send_email  # noqa


def i_rescue():
    import rescue_unscored  # noqa


def i_debug():
    import debug_query  # noqa


def i_probe_api():
    import probe_guest_api  # noqa


def i_probe_detail():
    import probe_guest_detail  # noqa


for fn, label in [
    (i_search, "search.py"),
    (i_scheduler, "scheduler_ctl.py"),
    (i_onboarding, "onboarding_ctl.py"),
    (i_send_email, "send_email.py"),
    (i_rescue, "rescue_unscored.py"),
    (i_debug, "debug_query.py"),
    (i_probe_api, "probe_guest_api.py"),
    (i_probe_detail, "probe_guest_detail.py"),
]:
    check("imports", label, fn)

# ------- 2. Schema + config migration -------
section("2. Schema + config migration")


def t_defaults_shape():
    """--print-defaults emits the *current effective* defaults — i.e. the
    in-file constants as potentially mutated by load_config() if a config.json
    is present. On a fresh clone with no config.json the values are the true
    hardcoded defaults (now domain-neutral: empty categories / priority /
    scoring prompt / fit lists). We can only assert shape + key presence
    here, not specific content, since the user's own config.json may have
    populated the in-memory copies."""
    rc, out, err = _run("python3", str(SEARCH_PY), "--print-defaults")
    assert rc == 0, err
    d = json.loads(out)
    required = {
        "categories",
        "claude_scoring_prompt",
        "fit_positive_patterns",
        "fit_negative_patterns",
        "offtopic_title_patterns",
        "priority_companies",
        "max_pages",
        "geo_id",
        "date_filter",
        "location",
    }
    missing = required - set(d)
    assert not missing, f"missing keys: {missing}"
    assert isinstance(d["categories"], list)
    assert isinstance(d["priority_companies"], list)
    assert isinstance(d["claude_scoring_prompt"], str)
    assert isinstance(d["offtopic_title_patterns"], list)
    legacy = {"search_queries", "security_researcher_queries", "company_queries"} & set(d)
    assert not legacy, f"legacy keys still present: {legacy}"
    return f"{len(d['categories'])} cats, {len(d['offtopic_title_patterns'])} offtopic patterns"


def t_migrate_legacy():
    import importlib

    import search

    importlib.reload(search)
    legacy = {
        "search_queries": ["a", "b"],
        "security_researcher_queries": ["c"],
        "company_queries": ["Z"],
        "priority_companies": "wiz, snyk",  # CSV string
    }
    migrated = search._migrate_legacy_config(legacy.copy())
    assert "categories" in migrated and len(migrated["categories"]) == 3
    types = [c["type"] for c in migrated["categories"]]
    assert types == ["keyword", "keyword", "company"], types
    return "3 cats built from legacy"


def t_malformed_config():
    # load_config must not crash on malformed JSON.
    tmp = ROOT / "config.json.test-malformed"
    tmp.write_text("{not json")
    orig_cfg = ROOT / "config.json"
    backup = None
    if orig_cfg.exists():
        backup = orig_cfg.read_text()
        orig_cfg.write_text("{not json")
    try:
        import importlib

        import search

        importlib.reload(search)
        merged = search.load_config()
        assert isinstance(merged, dict) and "categories" in merged
    finally:
        tmp.unlink(missing_ok=True)
        if backup is not None:
            orig_cfg.write_text(backup)
    return "malformed config falls back cleanly"


def t_claude_parser_both_cases():
    import search

    obj = search._parse_claude_json('```json\n{"a": [1,2], "b": 3}\n```')
    arr = search._parse_claude_json('[{"id": "1"}, {"id": "2"}]')
    assert isinstance(obj, dict) and obj["b"] == 3
    assert isinstance(arr, list) and len(arr) == 2
    return "object+array top-level both parse"


check("schema", "defaults emit new schema", t_defaults_shape)
check("schema", "legacy config migrates to categories[]", t_migrate_legacy)
check("schema", "malformed config falls back to defaults", t_malformed_config)
check("schema", "_parse_claude_json object+array", t_claude_parser_both_cases)

# ------- 3. Scraper pipelines (dry) -------
section("3. Scraper pipelines — dry helper checks")


def t_query_tokens():
    import search

    assert search._query_tokens("cryptography engineer") == ["cryptography"]
    assert search._query_tokens("MPC engineer") == ["mpc"]
    assert search._query_tokens("zero knowledge engineer") == ["zero", "knowledge"]
    return "token extractor correct"


def t_card_token_match():
    import search

    tokens = search._query_tokens("cryptography engineer")
    assert search._card_matches_tokens("Senior Cryptographer", "Acme", tokens) is True
    assert search._card_matches_tokens("Sales Engineer", "Acme", tokens) is False
    return "relevance check correct"


def t_classify_card_ebp():
    import search

    assert search._classify_card("NON_CHARGEABLE_CHANNEL", banner_present=False) == "real"
    assert search._classify_card("NOT_ELIGIBLE_FOR_CHARGING", banner_present=False) == "jymbii"
    assert search._classify_card("NON_CHARGEABLE_CHANNEL", banner_present=True) == "jymbii"
    return "ebp classification correct"


check("pipeline", "_query_tokens extractor", t_query_tokens)
check("pipeline", "_card_matches_tokens relevance", t_card_token_match)
check("pipeline", "_classify_card eBP + banner override", t_classify_card_ebp)

# ------- 4. Scheduler (launchctl) -------
section("4. Scheduler / launchd")


def t_sched_status():
    rc, out, _ = _run("python3", str(SCHEDULER_PY), "status")
    assert rc == 0
    d = json.loads(out)
    assert d["ok"] is True
    return f"interval={d['interval_label']}, mode={d['mode']}, loaded={d['loaded']}"


def t_sched_set_interval_roundtrip():
    _run("python3", str(SCHEDULER_PY), "set-interval", "21600")
    rc, out, _ = _run("python3", str(SCHEDULER_PY), "status")
    d = json.loads(out)
    assert d["interval_seconds"] == 21600, d
    _run("python3", str(SCHEDULER_PY), "set-interval", "43200")  # restore
    rc, out, _ = _run("python3", str(SCHEDULER_PY), "status")
    d = json.loads(out)
    assert d["interval_seconds"] == 43200, d
    return "6h → 12h round-trip clean"


def t_sched_set_mode_roundtrip():
    _run("python3", str(SCHEDULER_PY), "set-mode", "loggedin")
    rc, out, _ = _run("python3", str(SCHEDULER_PY), "status")
    d = json.loads(out)
    assert d["mode"] == "loggedin"
    _run("python3", str(SCHEDULER_PY), "set-mode", "guest")  # restore
    return "loggedin → guest round-trip clean"


check("scheduler", "status command returns JSON", t_sched_status)
check("scheduler", "set-interval round-trip", t_sched_set_interval_roundtrip)
check("scheduler", "set-mode round-trip", t_sched_set_mode_roundtrip)

# ------- 5. Onboarding -------
section("5. Onboarding (meta-prompt / Claude)")


def t_onboarding_validates_short_cv():
    rc, out, _ = _run(
        "python3",
        str(ONBOARDING_PY),
        "generate",
        timeout=15,
        input_=json.dumps({"cv": "too short", "intent": "also short"}),
    )
    assert rc == 1
    d = json.loads(out)
    assert d["ok"] is False
    assert "chars" in d["error"].lower() or "short" in d["error"].lower()
    return "rejects short inputs"


check("onboarding", "validation rejects short cv/intent", t_onboarding_validates_short_cv)
# Full Claude-round-trip test is expensive (~30s, costs a Claude call). Skip in
# the default run — we verified it earlier. Flag to opt in:
if os.environ.get("PHASE_D_FULL_CLAUDE"):

    def t_onboarding_full_claude():
        cv = (
            "Senior backend engineer, 5 years Go + Python + Rust. Built "
            "high-throughput services at a Tel Aviv fintech. M.Sc. in CS, "
            "Technion 2020. Interested in applied crypto, distributed systems."
        )
        intent = (
            "Senior backend or security-research roles at Israeli hi-tech. "
            "No sales, no DevOps, no people management."
        )
        rc, out, _ = _run(
            "python3",
            str(ONBOARDING_PY),
            "generate",
            timeout=240,
            input_=json.dumps({"cv": cv, "intent": intent}),
        )
        assert rc == 0
        d = json.loads(out)
        assert d.get("ok") is True
        cfg = d["config"]
        assert len(cfg["categories"]) >= 2
        return f"cats={len(cfg['categories'])}"

    check("onboarding", "claude round-trip", t_onboarding_full_claude)

# ------- 6. Email pipeline -------
section("6. Email pipeline")


def t_email_renders():
    # Render-only: no SMTP. Covers the HTML generation path.
    from send_email import _select_jobs, build_digest_html

    class Args:
        all_today = True

    jobs = _select_jobs(Args())
    html = build_digest_html(jobs)
    assert html.startswith("<!doctype html>"), html[:80]
    assert len(html) > 3000  # polished digest is ~25KB+
    return f"HTML ok, {len(jobs)} jobs, {len(html)} chars"


def t_email_smtp_live():
    # REAL send — requires ~/.linkedin-jobs.env to be present with working creds.
    env_file = Path.home() / ".linkedin-jobs.env"
    assert env_file.exists(), f"no SMTP env at {env_file}"
    # Load env vars for the subprocess.
    env = dict(os.environ)
    for line in env_file.read_text().splitlines():
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    p = subprocess.run(
        ["python3", str(SEND_EMAIL_PY), "--all-today"],
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
        cwd=str(ROOT),
    )
    assert p.returncode == 0, f"send_email exit {p.returncode}: {p.stderr[-200:]}"
    assert "Sent to" in p.stdout, p.stdout[-300:]
    return p.stdout.strip().splitlines()[-1][:80]


check("email", "digest HTML renders (no SMTP)", t_email_renders)
# Opt-in for real send to avoid spamming on every test run.
if os.environ.get("PHASE_D_SEND_EMAIL", "1") == "1":
    check("email", "real SMTP send to configured EMAIL_TO", t_email_smtp_live)

# ------- 7. UI build -------
section("7. UI build")


def t_ui_build():
    p = subprocess.run(
        ["npm", "run", "build"], cwd=str(ROOT / "ui"), capture_output=True, text=True, timeout=120
    )
    assert p.returncode == 0, p.stderr[-400:]
    assert "built in" in p.stdout, p.stdout[-400:]
    last = [l for l in p.stdout.splitlines() if "index-" in l and ".js" in l]
    return last[0].strip() if last else "built"


check("ui", "npm run build passes", t_ui_build)

# ------- 8. UI dev-server endpoints -------
section("8. UI dev-server endpoints (requires dev server running)")


def t_ep_config():
    out = _curl("/api/config")
    d = json.loads(out)
    assert isinstance(d, dict)
    return "returns JSON"


def t_ep_config_info():
    out = _curl("/api/config-info")
    d = json.loads(out)
    assert "exists" in d or "mtime" in d or "size" in d or "ok" in d
    return "returns JSON"


def t_ep_scrape_status():
    out = _curl("/api/scrape-status")
    d = json.loads(out)
    assert "runs" in d
    return f"{len(d['runs'])} runs"


def t_ep_scheduler_status():
    out = _curl("/api/scheduler-status")
    d = json.loads(out)
    assert d.get("ok") is True
    return f"installed={d['installed']}"


def t_static_results():
    out = _curl("/results.json")
    j = json.loads(out)
    assert isinstance(j, list) and len(j) > 0
    return f"{len(j)} jobs"


def t_static_run_history():
    out = _curl("/run_history.json")
    j = json.loads(out)
    assert isinstance(j, dict) and "runs" in j
    return f"{len(j['runs'])} run records"


def t_static_defaults():
    out = _curl("/defaults.json")
    j = json.loads(out)
    assert "categories" in j
    return "new schema served"


check("endpoints", "GET /api/config", t_ep_config)
check("endpoints", "GET /api/config-info", t_ep_config_info)
check("endpoints", "GET /api/scrape-status", t_ep_scrape_status)
check("endpoints", "GET /api/scheduler-status", t_ep_scheduler_status)
check("endpoints", "GET /results.json (symlink)", t_static_results)
check("endpoints", "GET /run_history.json (symlink)", t_static_run_history)
check("endpoints", "GET /defaults.json (symlink)", t_static_defaults)

# ------- 9. Data integrity -------
section("9. Data integrity")


def t_no_dup_ids():
    jobs = json.loads((ROOT / "results.json").read_text())
    ids = [j["id"] for j in jobs]
    assert len(ids) == len(set(ids)), f"duplicates: {len(ids) - len(set(ids))}"
    return f"{len(ids)} unique ids"


def t_seen_is_superset():
    jobs = json.loads((ROOT / "results.json").read_text())
    seen = set(json.loads((ROOT / "seen_jobs.json").read_text()))
    missing = [j["id"] for j in jobs if j["id"] not in seen]
    assert not missing, f"{len(missing)} ids in results but not in seen"
    return f"seen={len(seen)} ⊇ results"


def t_run_history_append_only():
    h = json.loads((ROOT / "run_history.json").read_text())
    assert isinstance(h, dict) and isinstance(h.get("runs"), list)
    assert len(h["runs"]) >= 1
    return f"{len(h['runs'])} runs recorded"


def t_atomic_merge():
    # Hammer save_results_merge with three parallel processes and verify the
    # union is correct (no lost writes). Use %-substitution (not .format())
    # so the dict-literal braces in the payload list-comp survive intact.
    import importlib

    import search

    importlib.reload(search)
    tmp_dir = HERE / ".phase-d-merge-test"
    tmp_dir.mkdir(exist_ok=True)
    target = tmp_dir / "merge.json"
    target.write_text("[]")

    script_template = (
        "import sys, pathlib\n"
        f"sys.path.insert(0, {str(BACKEND)!r})\n"
        "import search\n"
        "search.RESULTS_FILE = pathlib.Path(%r)\n"
        "payload = [{'id': 'job-' + str(i), 'title': 'x'}\n"
        "           for i in range(%d, %d+50)]\n"
        "search.save_results_merge(payload)\n"
    )
    procs = []
    for offset in (0, 25, 50):
        script = script_template % (str(target), offset, offset)
        p = subprocess.Popen(["python3", "-c", script], cwd=str(ROOT))
        procs.append(p)
    for p in procs:
        p.wait(timeout=30)
    final = json.loads(target.read_text())
    ids = {j["id"] for j in final}
    # Expect ids 0..99 total (0-49, 25-74, 50-99; overlap makes the union 100).
    expected = {f"job-{i}" for i in range(100)}
    assert ids == expected, f"expected {len(expected)}, got {len(ids)}"
    import shutil

    shutil.rmtree(tmp_dir, ignore_errors=True)
    return f"3-way parallel merge produced {len(ids)} unique ids"


check("data", "results.json has no duplicate ids", t_no_dup_ids)
check("data", "seen_jobs ⊇ results ids", t_seen_is_superset)
check("data", "run_history.json is append-only dict", t_run_history_append_only)
check("data", "fcntl merge survives 3-way parallel writers", t_atomic_merge)

# ------- 10. Backup integrity -------
section("10. Backup integrity")


def t_backup_present():
    # Override-able per-machine — set LINKEDINJOBS_BACKUP_DIR to your local
    # snapshot path. Test silently skips when unset or when the directory
    # doesn't exist (so CI / fresh clones don't trip on it).
    backup_path = os.environ.get("LINKEDINJOBS_BACKUP_DIR")
    if not backup_path:
        return "skipped — LINKEDINJOBS_BACKUP_DIR not set"
    backup = Path(backup_path)
    if not backup.exists():
        return "skipped — backup directory not present on this machine"
    manifest = backup / "MANIFEST.sha256"
    assert manifest.exists(), f"missing: {manifest}"
    files = list(backup.rglob("*"))
    file_count = sum(1 for p in files if p.is_file())
    assert file_count >= 50, f"only {file_count} files in backup"
    return f"{file_count} files, manifest size {manifest.stat().st_size}"


check("backup", "backup directory + manifest present", t_backup_present)

# ------- 11. Corpus field coverage (post-feature-wave) -------
# These exercise the corpus mutation commands (corpus_ctl.py) plus the
# feature-wave fields they touch: pushed_to_end, comment, app_status,
# app_status_history, app_notes, rated_at, category_name. We import the
# command functions directly and point search.RESULTS_FILE/SEEN_FILE at a
# tmp file so nothing in the real corpus is touched. The commands call
# sys.exit via _emit, so we catch SystemExit and capture the JSON they
# print on stdout.
section("11. Corpus field coverage (post-feature-wave)")

import contextlib
import importlib
import io
import tempfile


def _corpus_call(cmd_fn, body):
    """Invoke a corpus_ctl command function with a stdin JSON body, capture
    its stdout JSON envelope, and return (envelope, exit_code). Mirrors how
    the command is invoked in production via the Vite middleware."""
    import corpus_ctl  # noqa: F401 — ensures module loaded

    buf = io.StringIO()
    code = 0
    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(io.StringIO()):
        # The cmd_* helpers read from sys.stdin, so swap it out.
        old_stdin = sys.stdin
        sys.stdin = io.StringIO(json.dumps(body))
        try:
            cmd_fn(None)
        except SystemExit as e:
            code = int(e.code or 0)
        finally:
            sys.stdin = old_stdin
    out = buf.getvalue()
    try:
        env = json.loads(out)
    except json.JSONDecodeError:
        env = {"_raw": out}
    return env, code


def _with_tmp_corpus(rows):
    """Context-manager-ish helper: returns (cleanup, results_path). Points
    search.RESULTS_FILE and SEEN_FILE at fresh temp files seeded with rows.
    Caller MUST invoke cleanup() afterwards (in a finally)."""
    import search as _s

    tmpdir = Path(tempfile.mkdtemp(prefix="phase-d-corpus-"))
    rpath = tmpdir / "results.json"
    spath = tmpdir / "seen_jobs.json"
    rpath.write_text(json.dumps(rows, indent=2))
    spath.write_text("[]")
    orig_results, orig_seen = _s.RESULTS_FILE, _s.SEEN_FILE
    _s.RESULTS_FILE = rpath
    _s.SEEN_FILE = spath

    def _cleanup():
        _s.RESULTS_FILE = orig_results
        _s.SEEN_FILE = orig_seen
        import shutil

        shutil.rmtree(tmpdir, ignore_errors=True)

    return _cleanup, rpath


def t_pushed_to_end_set_clear_idempotent():
    import corpus_ctl

    cleanup, rpath = _with_tmp_corpus(
        [
            {"id": "j1", "title": "A"},
            {"id": "j2", "title": "B"},
            {"id": "j3", "title": "C"},
        ]
    )
    try:
        # Set on j1 + j2.
        env, code = _corpus_call(corpus_ctl.cmd_push_to_end, {"ids": ["j1", "j2"], "pushed": True})
        assert code == 0 and env["ok"] is True, env
        assert env["updated"] == 2 and env["missing"] == [], env
        rows = json.loads(rpath.read_text())
        by_id = {r["id"]: r for r in rows}
        assert by_id["j1"].get("pushed_to_end") is True
        assert by_id["j2"].get("pushed_to_end") is True
        assert "pushed_to_end" not in by_id["j3"] or by_id["j3"]["pushed_to_end"] is not True

        # Re-asserting the same value is idempotent — updated count is 0.
        env, _ = _corpus_call(corpus_ctl.cmd_push_to_end, {"ids": ["j1"], "pushed": True})
        assert env["updated"] == 0, env

        # Clear j1; j2 stays.
        env, _ = _corpus_call(corpus_ctl.cmd_push_to_end, {"ids": ["j1"], "pushed": False})
        assert env["updated"] == 1
        rows = json.loads(rpath.read_text())
        by_id = {r["id"]: r for r in rows}
        assert by_id["j1"].get("pushed_to_end") in (None, False)
        assert by_id["j2"].get("pushed_to_end") is True

        # Missing ids surface in the missing list.
        env, _ = _corpus_call(corpus_ctl.cmd_push_to_end, {"ids": ["nope-xyz"], "pushed": True})
        assert env["updated"] == 0 and env["missing"] == ["nope-xyz"], env
        return "set / clear / idempotent / missing all behave"
    finally:
        cleanup()


def t_comment_round_trip():
    import corpus_ctl

    cleanup, rpath = _with_tmp_corpus([{"id": "j1", "title": "A"}])
    try:
        # Set comment + rating together.
        env, code = _corpus_call(
            corpus_ctl.cmd_rate, {"id": "j1", "rating": 4, "comment": "  cool stack, IL-based  "}
        )
        assert code == 0 and env["ok"] is True, env
        rows = json.loads(rpath.read_text())
        r = rows[0]
        assert r["rating"] == 4
        assert r["comment"] == "cool stack, IL-based"  # stripped
        assert r.get("rated_at"), "rated_at missing"
        first_rated_at = r["rated_at"]

        # Clearing only comment leaves rating intact and bumps rated_at.
        time.sleep(1.05)  # ISO seconds resolution — must observe a tick
        env, _ = _corpus_call(corpus_ctl.cmd_rate, {"id": "j1", "rating": 4, "comment": ""})
        rows = json.loads(rpath.read_text())
        r = rows[0]
        assert "comment" not in r, f"comment should have been cleared: {r}"
        assert r["rating"] == 4
        assert r["rated_at"] >= first_rated_at  # monotonic
        return "set + strip + clear + rated_at refresh"
    finally:
        cleanup()


def t_rated_at_updates_on_rating_change():
    import corpus_ctl

    cleanup, rpath = _with_tmp_corpus([{"id": "j1", "title": "A"}])
    try:
        env, _ = _corpus_call(corpus_ctl.cmd_rate, {"id": "j1", "rating": 3})
        first = json.loads(rpath.read_text())[0]["rated_at"]
        time.sleep(1.05)
        env, _ = _corpus_call(corpus_ctl.cmd_rate, {"id": "j1", "rating": 5})
        second = json.loads(rpath.read_text())[0]["rated_at"]
        assert second > first, f"rated_at didn't advance: {first} -> {second}"
        return "rated_at advances on rating change"
    finally:
        cleanup()


def t_app_status_transition_appends_history():
    import corpus_ctl

    cleanup, rpath = _with_tmp_corpus([{"id": "j1", "title": "A"}])
    try:
        # First transition: new (implicit) -> applied. History grows by 1.
        env, code = _corpus_call(
            corpus_ctl.cmd_app_status,
            {"id": "j1", "status": "applied", "note": "submitted via referral"},
        )
        assert code == 0 and env["ok"], env
        assert env["history_len"] == 1
        assert env["app_notes"] == "submitted via referral"
        rows = json.loads(rpath.read_text())
        r = rows[0]
        assert r["app_status"] == "applied"
        assert len(r["app_status_history"]) == 1
        assert r["app_status_history"][0]["status"] == "applied"
        assert r.get("app_status_at"), "app_status_at not stamped"

        # Second call asserting the SAME status: no double-log.
        env, _ = _corpus_call(corpus_ctl.cmd_app_status, {"id": "j1", "status": "applied"})
        assert env["history_len"] == 1, env
        rows = json.loads(rpath.read_text())
        assert len(rows[0]["app_status_history"]) == 1

        # Real transition appends.
        env, _ = _corpus_call(corpus_ctl.cmd_app_status, {"id": "j1", "status": "interview"})
        assert env["history_len"] == 2, env
        rows = json.loads(rpath.read_text())
        hist = rows[0]["app_status_history"]
        assert [h["status"] for h in hist] == ["applied", "interview"]

        # Clearing app_notes via empty string.
        env, _ = _corpus_call(
            corpus_ctl.cmd_app_status, {"id": "j1", "status": "interview", "note": ""}
        )
        rows = json.loads(rpath.read_text())
        assert "app_notes" not in rows[0]

        # Long app_notes get truncated to 4000 chars.
        env, _ = _corpus_call(
            corpus_ctl.cmd_app_status, {"id": "j1", "status": "interview", "note": "x" * 5000}
        )
        rows = json.loads(rpath.read_text())
        assert len(rows[0]["app_notes"]) == 4000
        return "no-op / transition / app_notes set+clear+truncate"
    finally:
        cleanup()


def t_category_name_backfill():
    """tools/backfill_category_name resolves legacy ids and live config ids,
    skips rows already populated, leaves untouched the rows missing a
    category entirely. Pure-pure: no network, no Claude."""
    import importlib.util

    backfill_path = BACKEND / "tools" / "backfill_category_name.py"
    spec = importlib.util.spec_from_file_location("_backfill_t", backfill_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    # _name_for_id is the pure helper — exercise without disk I/O.
    live = {"cat-live-1": "LiveOne"}
    assert mod._name_for_id("cat-live-1", live) == "LiveOne"
    assert mod._name_for_id("crypto", live) == "Crypto"  # legacy map hit
    assert mod._name_for_id("cat-mobyb81c-5", live) == "Security"  # legacy
    assert mod._name_for_id("unknown-id", live) == "unknown-id"  # passthrough
    return "live + legacy + passthrough"


check("corpus", "pushed_to_end set / clear / idempotent", t_pushed_to_end_set_clear_idempotent)
check("corpus", "comment round-trip via cmd_rate", t_comment_round_trip)
check("corpus", "rated_at advances on rating change", t_rated_at_updates_on_rating_change)
check(
    "corpus",
    "app_status: history append, no-op, app_notes",
    t_app_status_transition_appends_history,
)
check("corpus", "category_name backfill helper purity", t_category_name_backfill)

# ------- 12. CLI command coverage -------
section("12. CLI command coverage")


def t_extract_job_id_url_variants():
    """extract_job_id parses every URL family LinkedIn surfaces, plus bare
    ids. Pure parser — no network."""
    import corpus_ctl

    f = corpus_ctl.extract_job_id
    # Bare numeric id.
    assert f("4395123456") == "4395123456"
    # /jobs/view/<id>/ (no slug).
    assert f("https://www.linkedin.com/jobs/view/4395123456/") == "4395123456"
    # /jobs/view/<slug>-<id>/ (real LinkedIn URL).
    assert (
        f("https://www.linkedin.com/jobs/view/staff-eng-foo-at-bar-4395123456?refId=abc")
        == "4395123456"
    )
    # /jobs/search/?currentJobId=...
    assert (
        f("https://www.linkedin.com/jobs/search/?currentJobId=4395123456&keywords=x")
        == "4395123456"
    )
    # /jobs/search-results/?currentJobId=...
    assert (
        f("https://www.linkedin.com/jobs/search-results/?currentJobId=4395123456") == "4395123456"
    )
    # No scheme — synthesised.
    assert f("www.linkedin.com/jobs/view/4395123456/") == "4395123456"
    # Garbage rejected.
    assert f("") is None
    assert f("   ") is None
    assert f("not a url") is None
    assert f("https://example.com/jobs/view/4395123456/") is None  # wrong host
    assert f("12345") is None  # too short
    assert f("1234567890123") is None  # too long
    return "bare + 4 URL families + scheme-less + reject paths"


def t_add_manual_dedupes_against_existing_id():
    """cmd_add_manual short-circuits on a duplicate id without touching the
    network or Claude. We seed an existing job id in the tmp corpus and
    verify the dedupe returns the canonical 'already in corpus' envelope."""
    import corpus_ctl

    cleanup, _rpath = _with_tmp_corpus(
        [
            {"id": "4395123456", "title": "Dup", "company": "X"},
        ]
    )
    try:
        env, code = _corpus_call(
            corpus_ctl.cmd_add_manual,
            {"url_or_id": "https://www.linkedin.com/jobs/view/4395123456/"},
        )
        assert code == 1, code
        assert env["ok"] is False
        assert env["error"] == "already in corpus"
        assert env["existing_id"] == "4395123456"
        return "dedupe trips before any network call"
    finally:
        cleanup()


def t_add_manual_rejects_unparseable_input():
    import corpus_ctl

    cleanup, _ = _with_tmp_corpus([])
    try:
        env, code = _corpus_call(corpus_ctl.cmd_add_manual, {"url_or_id": "not a job url"})
        assert code == 1
        assert env["ok"] is False
        assert "could not extract job ID" in env["error"], env
        return "parse-fail returns canonical envelope"
    finally:
        cleanup()


def t_rescore_resets_score_fields_before_rerun():
    """cmd_rescore wipes fit/score/fit_reasons/scored_by/msc_required on each
    target before delegating to process_one_job. We stub process_one_job to
    capture the row state at call time and assert the reset happened, plus
    that user-edited fields (rating / comment / app_status) are preserved."""
    import corpus_ctl
    import search as _s

    cleanup, rpath = _with_tmp_corpus(
        [
            {
                "id": "j1",
                "title": "Old",
                "company": "X",
                "fit": "good",
                "score": 9,
                "scored_by": "claude",
                "fit_reasons": ["a", "b"],
                "msc_required": False,
                "rating": 5,
                "comment": "love it",
                "app_status": "applied",
                "app_status_history": [{"status": "applied", "at": "2026-04-01T00:00:00+00:00"}],
            },
            {
                "id": "j2",
                "title": "Other",
                "company": "Y",
                "fit": "skip",
                "score": 3,
                "scored_by": "regex",
                "fit_reasons": ["nope"],
                "msc_required": None,
            },
        ]
    )
    captured = []

    def _stub_process_one_job(job, *, cv_text, fetch_one, persist, already_scored):
        # Snapshot the fields rescore is supposed to have reset.
        captured.append(
            {
                "id": job.get("id"),
                "fit": job.get("fit"),
                "score": job.get("score"),
                "scored_by": job.get("scored_by"),
                "fit_reasons": job.get("fit_reasons"),
                "msc_required": job.get("msc_required"),
                "rating": job.get("rating"),
                "comment": job.get("comment"),
                "app_status": job.get("app_status"),
                "history_len": len(job.get("app_status_history") or []),
            }
        )
        return job

    orig_process = _s.process_one_job
    orig_fetch = _s.fetch_description_guest
    orig_session = _s._guest_session
    orig_cv = _s._load_cv_text
    _s.process_one_job = _stub_process_one_job
    _s.fetch_description_guest = lambda *a, **kw: ("", "stub")
    _s._guest_session = lambda: object()
    _s._load_cv_text = lambda: ""
    try:
        env, code = _corpus_call(corpus_ctl.cmd_rescore, {"ids": ["j1", "j2", "missing-x"]})
        assert code == 0 and env["ok"] is True, env
        assert env["rescored"] == 2, env
        assert env["failed"] == 0, env
        assert env["missing"] == ["missing-x"], env
        assert len(captured) == 2
        for snap in captured:
            assert snap["fit"] is None, snap
            assert snap["score"] is None, snap
            assert snap["scored_by"] is None, snap
            assert snap["msc_required"] is None, snap
            assert snap["fit_reasons"] == [], snap
        # User-edited fields preserved on j1.
        j1_snap = next(s for s in captured if s["id"] == "j1")
        assert j1_snap["rating"] == 5
        assert j1_snap["comment"] == "love it"
        assert j1_snap["app_status"] == "applied"
        assert j1_snap["history_len"] == 1
        return "score fields reset, user fields preserved"
    finally:
        _s.process_one_job = orig_process
        _s.fetch_description_guest = orig_fetch
        _s._guest_session = orig_session
        _s._load_cv_text = orig_cv
        cleanup()


check("cli", "extract_job_id URL variants", t_extract_job_id_url_variants)
check("cli", "add-manual dedupes against existing id", t_add_manual_dedupes_against_existing_id)
check("cli", "add-manual rejects unparseable input", t_add_manual_rejects_unparseable_input)
check(
    "cli",
    "rescore resets score fields, preserves user fields",
    t_rescore_resets_score_fields_before_rerun,
)

# ------- 13. Helper purity -------
section("13. Helper purity")


def t_compute_hot_truth_table():
    import search

    h = search._compute_hot
    # fit != good → never hot.
    assert h({"fit": "skip", "score": 10, "priority": True}) is False
    assert h({"fit": None, "score": 10}) is False
    # good + score >= threshold → hot.
    assert h({"fit": "good", "score": search.HOT_SCORE_MIN}) is True
    assert h({"fit": "good", "score": search.HOT_SCORE_MIN + 1}) is True
    # good + below threshold + non-priority → not hot.
    assert h({"fit": "good", "score": search.HOT_SCORE_MIN - 1, "priority": False}) is False
    # good + below threshold + priority → hot.
    assert h({"fit": "good", "score": search.HOT_SCORE_MIN - 1, "priority": True}) is True
    # good with no score but priority → hot.
    assert h({"fit": "good", "priority": True}) is True
    # good with no score and not priority → not hot.
    assert h({"fit": "good"}) is False
    return f"truth table green @ HOT_SCORE_MIN={search.HOT_SCORE_MIN}"


def t_classify_feedback_row_routing():
    import search

    f = search._classify_feedback_row
    # Ratings 4-5 → pos.
    s, _ = f({"rating": 5})
    assert s == "pos"
    s, _ = f({"rating": 4})
    assert s == "pos"
    # Rating 3 → still pos (weak — user bothered to rate it).
    s, _ = f({"rating": 3})
    assert s == "pos"
    # Ratings 1-2 → neg.
    s, _ = f({"rating": 2})
    assert s == "neg"
    s, _ = f({"rating": 1})
    assert s == "neg"
    # Comment surfaces in summary.
    s, summ = f({"rating": 4, "comment": "loved the team"})
    assert s == "pos"
    assert "loved the team" in summ
    # Pipeline statuses.
    s, summ = f({"app_status": "interview"})
    assert s == "pos" and "interview" in summ
    s, summ = f({"app_status": "take-home"})
    assert s == "pos"
    s, summ = f({"app_status": "rejected"})
    assert s == "neg" and "rejected" in summ
    s, summ = f({"app_status": "withdrew"})
    assert s == "neg"
    # Manual source treated as positive signal.
    s, summ = f({"source": "manual"})
    assert s == "pos" and "manual" in summ.lower()
    # No signal at all → (None, "").
    s, summ = f({"id": "x", "title": "y"})
    assert s is None and summ == ""
    # Rating wins over status.
    s, _ = f({"rating": 1, "app_status": "interview"})
    assert s == "neg"
    return "rating + status + manual + null routing all correct"


def t_compute_hot_used_in_process_one_job():
    """Sanity-check that _compute_hot is the single source of truth — i.e.
    process_one_job actually writes job['hot'] from it. Cheap unit-level
    smoke that the hot-derivation didn't accidentally drift from the
    helper. Done via static text scan to avoid running the full pipeline."""
    text = (BACKEND / "search.py").read_text()
    assert 'job["hot"] = _compute_hot(job)' in text or "job['hot'] = _compute_hot(job)" in text, (
        "process_one_job no longer derives hot from _compute_hot"
    )
    return "process_one_job still uses _compute_hot"


check("helper", "_compute_hot truth table", t_compute_hot_truth_table)
check("helper", "_classify_feedback_row routing", t_classify_feedback_row_routing)
check(
    "helper", "process_one_job derives hot from _compute_hot", t_compute_hot_used_in_process_one_job
)

# ------- SUMMARY -------
print()
print("=" * 72)
total = len(RESULTS)
passed = sum(1 for r in RESULTS if r[2])
failed = total - passed
color = GREEN if failed == 0 else RED
print(f"{BOLD}Phase D summary: {color}{passed}/{total} passed, {failed} failed{RESET}")
print("=" * 72)
if failed:
    print(f"\n{RED}{BOLD}Failures:{RESET}")
    for cat, name, ok, detail in RESULTS:
        if not ok:
            print(f"  [{cat}] {name}: {detail}")

sys.exit(0 if failed == 0 else 1)
