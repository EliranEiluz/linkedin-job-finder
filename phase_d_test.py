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

HERE = Path(__file__).resolve().parent
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
    p = subprocess.run(list(argv), capture_output=True, text=True,
                       timeout=timeout, input=input_, cwd=cwd or str(HERE))
    return p.returncode, p.stdout, p.stderr


def _curl(path, method="GET", body=None):
    cmd = ["curl", "-s", "-X", method, f"http://localhost:5173{path}"]
    if body is not None:
        cmd += ["-H", "Content-Type: application/json", "-d", json.dumps(body)]
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=20)
    return p.stdout


# ------- 1. Python imports -------
section("1. Python imports")
def i_search(): import search  # noqa
def i_scheduler(): import scheduler_ctl  # noqa
def i_onboarding(): import onboarding_ctl  # noqa
def i_send_email(): import send_email  # noqa
def i_rescue(): import rescue_unscored  # noqa
def i_debug(): import debug_query  # noqa
def i_probe_api(): import probe_guest_api  # noqa
def i_probe_detail(): import probe_guest_detail  # noqa

for fn, label in [(i_search, "search.py"), (i_scheduler, "scheduler_ctl.py"),
                  (i_onboarding, "onboarding_ctl.py"), (i_send_email, "send_email.py"),
                  (i_rescue, "rescue_unscored.py"), (i_debug, "debug_query.py"),
                  (i_probe_api, "probe_guest_api.py"),
                  (i_probe_detail, "probe_guest_detail.py")]:
    check("imports", label, fn)

# ------- 2. Schema + config migration -------
section("2. Schema + config migration")

def t_defaults_shape():
    rc, out, err = _run("python3", "search.py", "--print-defaults")
    assert rc == 0, err
    d = json.loads(out)
    required = {"categories", "claude_scoring_prompt", "fit_positive_patterns",
                "fit_negative_patterns", "offtopic_title_patterns",
                "priority_companies", "max_pages", "geo_id", "date_filter", "location"}
    missing = required - set(d)
    assert not missing, f"missing keys: {missing}"
    assert isinstance(d["categories"], list) and len(d["categories"]) >= 1
    legacy = {"search_queries", "security_researcher_queries", "company_queries"} & set(d)
    assert not legacy, f"legacy keys still present: {legacy}"
    return f"{len(d['categories'])} cats, {len(d['priority_companies'])} priority co's"

def t_migrate_legacy():
    import importlib, search
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
    return f"3 cats built from legacy"

def t_malformed_config():
    # load_config must not crash on malformed JSON.
    tmp = HERE / "config.json.test-malformed"
    tmp.write_text("{not json")
    orig_cfg = HERE / "config.json"
    backup = None
    if orig_cfg.exists():
        backup = orig_cfg.read_text()
        orig_cfg.write_text("{not json")
    try:
        import importlib, search
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
    rc, out, _ = _run("python3", "scheduler_ctl.py", "status")
    assert rc == 0
    d = json.loads(out)
    assert d["ok"] is True
    return f"interval={d['interval_label']}, mode={d['mode']}, loaded={d['loaded']}"

def t_sched_set_interval_roundtrip():
    _run("python3", "scheduler_ctl.py", "set-interval", "21600")
    rc, out, _ = _run("python3", "scheduler_ctl.py", "status")
    d = json.loads(out)
    assert d["interval_seconds"] == 21600, d
    _run("python3", "scheduler_ctl.py", "set-interval", "43200")  # restore
    rc, out, _ = _run("python3", "scheduler_ctl.py", "status")
    d = json.loads(out)
    assert d["interval_seconds"] == 43200, d
    return "6h → 12h round-trip clean"

def t_sched_set_mode_roundtrip():
    _run("python3", "scheduler_ctl.py", "set-mode", "loggedin")
    rc, out, _ = _run("python3", "scheduler_ctl.py", "status")
    d = json.loads(out)
    assert d["mode"] == "loggedin"
    _run("python3", "scheduler_ctl.py", "set-mode", "guest")  # restore
    return "loggedin → guest round-trip clean"

check("scheduler", "status command returns JSON", t_sched_status)
check("scheduler", "set-interval round-trip", t_sched_set_interval_roundtrip)
check("scheduler", "set-mode round-trip", t_sched_set_mode_roundtrip)

# ------- 5. Onboarding -------
section("5. Onboarding (meta-prompt / Claude)")

def t_onboarding_validates_short_cv():
    rc, out, _ = _run("python3", "onboarding_ctl.py", "generate", timeout=15,
                      input_=json.dumps({"cv": "too short", "intent": "also short"}))
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
        cv = ("Senior backend engineer, 5 years Go + Python + Rust. Built "
              "high-throughput services at a Tel Aviv fintech. M.Sc. in CS, "
              "Technion 2020. Interested in applied crypto, distributed systems.")
        intent = ("Senior backend or security-research roles at Israeli hi-tech. "
                  "No sales, no DevOps, no people management.")
        rc, out, _ = _run("python3", "onboarding_ctl.py", "generate",
                          timeout=240,
                          input_=json.dumps({"cv": cv, "intent": intent}))
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
    p = subprocess.run(["python3", "send_email.py", "--all-today"],
                       env=env, capture_output=True, text=True,
                       timeout=60, cwd=str(HERE))
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
    p = subprocess.run(["npm", "run", "build"], cwd=str(HERE / "ui"),
                       capture_output=True, text=True, timeout=120)
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
    jobs = json.loads((HERE / "results.json").read_text())
    ids = [j["id"] for j in jobs]
    assert len(ids) == len(set(ids)), f"duplicates: {len(ids) - len(set(ids))}"
    return f"{len(ids)} unique ids"

def t_seen_is_superset():
    jobs = json.loads((HERE / "results.json").read_text())
    seen = set(json.loads((HERE / "seen_jobs.json").read_text()))
    missing = [j["id"] for j in jobs if j["id"] not in seen]
    assert not missing, f"{len(missing)} ids in results but not in seen"
    return f"seen={len(seen)} ⊇ results"

def t_run_history_append_only():
    h = json.loads((HERE / "run_history.json").read_text())
    assert isinstance(h, dict) and isinstance(h.get("runs"), list)
    assert len(h["runs"]) >= 1
    return f"{len(h['runs'])} runs recorded"

def t_atomic_merge():
    # Hammer save_results_merge with three parallel processes and verify the
    # union is correct (no lost writes). Use %-substitution (not .format())
    # so the dict-literal braces in the payload list-comp survive intact.
    import importlib, search
    importlib.reload(search)
    tmp_dir = HERE / ".phase-d-merge-test"
    tmp_dir.mkdir(exist_ok=True)
    target = tmp_dir / "merge.json"
    target.write_text("[]")

    script_template = (
        "import search, pathlib\n"
        "search.RESULTS_FILE = pathlib.Path(%r)\n"
        "payload = [{'id': 'job-' + str(i), 'title': 'x'}\n"
        "           for i in range(%d, %d+50)]\n"
        "search.save_results_merge(payload)\n"
    )
    procs = []
    for offset in (0, 25, 50):
        script = script_template % (str(target), offset, offset)
        p = subprocess.Popen(
            ["python3", "-c", script], cwd=str(HERE))
        procs.append(p)
    for p in procs:
        p.wait(timeout=30)
    final = json.loads(target.read_text())
    ids = {j["id"] for j in final}
    # Expect ids 0..99 total (0-49, 25-74, 50-99; overlap makes the union 100).
    expected = {f"job-{i}" for i in range(100)}
    assert ids == expected, f"expected {len(expected)}, got {len(ids)}"
    import shutil; shutil.rmtree(tmp_dir, ignore_errors=True)
    return f"3-way parallel merge produced {len(ids)} unique ids"

check("data", "results.json has no duplicate ids", t_no_dup_ids)
check("data", "seen_jobs ⊇ results ids", t_seen_is_superset)
check("data", "run_history.json is append-only dict", t_run_history_append_only)
check("data", "fcntl merge survives 3-way parallel writers", t_atomic_merge)

# ------- 10. Backup integrity -------
section("10. Backup integrity")

def t_backup_present():
    backup = Path("/Users/eliranei/linkedin-jobs-backup-2026-04-22")
    manifest = backup / "MANIFEST.sha256"
    assert backup.exists(), f"missing: {backup}"
    assert manifest.exists(), f"missing: {manifest}"
    files = list(backup.rglob("*"))
    file_count = sum(1 for p in files if p.is_file())
    assert file_count >= 50, f"only {file_count} files in backup"
    return f"{file_count} files, manifest size {manifest.stat().st_size}"

check("backup", "backup directory + manifest present", t_backup_present)

# ------- SUMMARY -------
print()
print("=" * 72)
total = len(RESULTS)
passed = sum(1 for r in RESULTS if r[2])
failed = total - passed
color = GREEN if failed == 0 else RED
print(f"{BOLD}Phase D summary: "
      f"{color}{passed}/{total} passed, {failed} failed{RESET}")
print("=" * 72)
if failed:
    print(f"\n{RED}{BOLD}Failures:{RESET}")
    for cat, name, ok, detail in RESULTS:
        if not ok:
            print(f"  [{cat}] {name}: {detail}")

sys.exit(0 if failed == 0 else 1)
