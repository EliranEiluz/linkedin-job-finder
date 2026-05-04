# Architecture

How `linkedin-job-finder` is shaped, end to end. Read this before
[DEVELOPER.md](./DEVELOPER.md) — the contributor guide assumes the
vocabulary introduced here.

This is a single-user desktop tool: one user, one repo clone, one Python
process tree, one browser tab. There is no server to deploy and no
multi-tenant data model. Every "API" is a Vite dev-middleware route that
spawns a Python script.

## Repo layout

- **`backend/`** — all Python. `search.py` is the scraper plus LLM
  scoring orchestrator (CLI entrypoint), `send_digest.py` builds the
  HTML digest and dispatches it to enabled notification channels,
  `send_email.py` is a thin back-compat shim, and `run.py` is the
  cross-platform scheduler entry point that the OS scheduler invokes.
- **`backend/ctl/`** — JSON-CLI control surfaces the UI shells to
  through Vite middleware. One script per concern: `scheduler_ctl.py`,
  `profile_ctl.py`, `onboarding_ctl.py`, `corpus_ctl.py`,
  `config_suggest_ctl.py`, `notifications_ctl.py`, `llm_ctl.py`,
  `preflight_ctl.py`, `cv_extract_ctl.py`. `_common.py` holds the
  shared stdin/stdout + atomic-write helpers.
- **`backend/ctl/scheduler/`** — OS-specific scheduler backends:
  `launchd.py`, `systemd_user.py`, `schtasks.py`, all behind the ABC in
  `base.py`. The right one is chosen at runtime by `platform.system()`.
- **`backend/llm/`** — LLM provider abstraction. `__init__.py` exports
  `score_batch`, `complete`, `test_provider` plus the `PROVIDERS`
  registry. One file per provider (`claude_cli`, `claude_sdk`,
  `gemini`, `openai`, `openrouter`, `ollama`), all subclassing
  `LLMProvider` from `base.py`. `_shared.py` has parsing helpers used
  by every provider.
- **`backend/tools/`** — one-shot maintenance scripts:
  `backfill_category_name.py`, `backfill_scored_at.py`,
  `rescue_unscored.py`. Run by hand, not from the UI.
- **`backend/probes/`** — diagnostic scripts for poking the LinkedIn
  endpoints directly while debugging scraper changes. Not user-facing.
- **`backend/tests/`** — `pytest` suite. `conftest.py` sets up the
  `tmp_repo` and `run_ctl` fixtures so tests never touch the real
  on-disk corpus. `phase_d_test.py` is a script-style legacy harness
  excluded from the main run via `--ignore`.
- **`ui/`** — Vite + React + TypeScript app. Configuration in
  `vite.config.ts` (which carries the dev middleware), tests run with
  Vitest.
- **`ui/src/`** — React components, one tab per top-level page
  (`CorpusPage`, `ApplicationsPage`, `ConfigPage`, `RunHistoryPage`,
  `OnboardingPage`) plus shared atoms (FilterPanel, JobsTable,
  ChipInput, etc.) and pure-logic modules (`filters.ts`,
  `configMigrate.ts`, `api.ts`, `hooks.ts`).
- **`ui/middleware/`** — Node helpers shared by the Vite middleware:
  `runCtl.ts` (the spawn-and-pipe wrapper around ctl scripts),
  `http.ts` (`readJsonBody`, `sendJson`), `paths.ts` (centralized
  filesystem and timeout constants).
- **`docs/`** — this file plus [DEVELOPER.md](./DEVELOPER.md) and
  `assets/` (the README hero GIF).
- **`.github/`** — CI workflow (`workflows/ci.yml`), issue + PR
  templates, dependabot config.

## End-to-end data flow

```
                 ┌──────────────────────────────────────────────┐
                 │   Browser (http://localhost:5173)            │
                 │   React UI: Corpus / Tracker / Crawler /     │
                 │             Run History / Setup tabs         │
                 └──────────────────────┬───────────────────────┘
                                        │ fetch /api/...
                                        │ fetch /results.json
                                        │ fetch /digest.html
                                        ▼
                 ┌──────────────────────────────────────────────┐
                 │   Vite dev server (Node, ui/vite.config.ts)  │
                 │   middleware:                                │
                 │     - root JSON pass-through (results,       │
                 │       run_history, defaults, digest)         │
                 │     - /api/* handlers — spawn ctl scripts    │
                 │       via runCtl(), pipe JSON in/out         │
                 └──────────────────────┬───────────────────────┘
                                        │ spawn python3
                                        │ stdin = JSON payload
                                        │ stdout = JSON envelope
                                        ▼
                 ┌──────────────────────────────────────────────┐
                 │   backend/ctl/*_ctl.py + backend/search.py   │
                 └─┬───────────────┬────────────────┬───────────┘
                   │               │                │
                   ▼               ▼                ▼
            ┌────────────┐  ┌─────────────┐  ┌─────────────┐
            │ LinkedIn   │  │ LLM         │  │ Repo-root   │
            │ /jobs-     │  │ provider    │  │ state files │
            │ guest API  │  │ (auto-      │  │ (see below) │
            │ + Play-    │  │ resolved)   │  │             │
            │ wright     │  │             │  │             │
            └────────────┘  └─────────────┘  └─────────────┘
```

State files live at the repo root and are read or written by both the
scraper process and ctl scripts. Locked = `_atomic_merge_json` with a
`.lock` sidecar via the `filelock` package; lock-free = single-writer or
overwrite-each-run.

| File                       | Writer                          | Locked |
|----------------------------|---------------------------------|--------|
| `results.json`             | `search.py`, `corpus_ctl.py`    | yes    |
| `seen_jobs.json`           | `search.py`, `corpus_ctl.py`    | yes    |
| `run_history.json`         | `search.py`                     | yes    |
| `configs/<name>.json`      | `onboarding_ctl`, `profile_ctl` | no     |
| `config.json` (symlink)    | `profile_ctl`                   | no     |
| `active_profile.txt`       | `profile_ctl`                   | no     |
| `cv.txt`                   | `onboarding_ctl`                | no     |
| `digest.html`              | `send_digest.py`                | no     |
| `~/.linkedin-jobs.env`     | `llm_ctl`, `notifications_ctl`  | no     |
| `scrape_status.json`       | `vite.config.ts` (middleware)   | no     |
| `linkedin_session.json`    | `search.py` (loggedin path)     | no     |

`scrape_status.json` is locked at the process-local level by a write
chain in the middleware — it is never written by Python, so cross-process
locking is unnecessary.

## Scraper pipeline

Two scrape modes share the same downstream pipeline. The choice between
them is `--mode={guest,loggedin}` to `backend/search.py`. Both can run
concurrently — they merge into the same `results.json` and `seen_jobs.json`
under exclusive `filelock` so neither clobbers the other's writes.

### Guest mode

Unauthenticated HTTP against LinkedIn's public `/jobs-guest/jobs/api/`
endpoints. No account, no Playwright, no Chromium. Uses `requests` plus
`BeautifulSoup` to parse the search-result cards and the per-job detail
pages. Returns roughly five times more results than the logged-in path
in practice — the personalized feed silently filters out a lot of Big
Tech postings that the guest endpoints surface.

### Loggedin mode

`playwright` driving Chromium with a saved session
(`linkedin_session.json`). On first run a visible browser opens to the
LinkedIn login page so the user can authenticate manually; the cookies
are persisted and reused by every subsequent run. Catches jobs that the
guest endpoints hide because they require a logged-in viewer to render.

### Per-job pipeline (both modes)

```
    list of search queries
            │
            ▼
   per-query enumerate cards          ← guest: HTTP search; loggedin: Playwright
            │
            ▼
   dedup by id against seen_jobs      ← cheap; no network
            │
            ▼
   stage 1: title pre-filter          ← is_obviously_offtopic() regex
            │  (priority companies bypass)
            ▼
   stage 2: description fetch         ← guest detail endpoint or page DOM
            │
            ▼
   stage 3: LLM scoring (batched)     ← score_jobs_in_batches, 8 jobs/call
            │  fit, score, reasons, msc_required, red_flags
            ▼
   stage 4: regex fallback            ← only on LLM error / rate limit
            │  fit_positive_patterns, fit_negative_patterns
            ▼
   stage 5: hot flag                  ← _compute_hot, single source of truth
            │
            ▼
   atomic merge into results.json     ← _atomic_merge_json (filelock)
   atomic merge into seen_jobs.json   ← _atomic_merge_json (filelock)
   append entry to run_history.json   ← _append_run_history (filelock)
```

The regex fallback is the safety net when no provider is reachable. It
keeps the scraper useful on a half-configured install — every job comes
back with `fit="ok"` and `score=5` (neutral) when both
`fit_positive_patterns` and `fit_negative_patterns` are empty, which is
what a fresh wizard-generated profile looks like before the user adds
their own domain signals.

## LLM provider abstraction

`backend/llm/__init__.py` is the single entry point. Three public
functions:

- `score_batch(cv_text, batch)` — primary scoring path. Returns a list
  of `{job_id, fit, score, reasons, msc_required, red_flags}` dicts
  (one per job in the batch) or `None` on failure. The orchestrator in
  `search.py` handles missing keys per job — a well-behaved provider
  emits one entry per input, but the merge code does not assume this.
- `complete(prompt, system=, max_tokens=, json_mode=)` — single-shot
  completion. Used by `onboarding_ctl` (CV → starter config) and
  `config_suggest_ctl` (feedback → config tuning). Both pass
  `json_mode=True` because they expect a structured object back.
- `test_provider(name)` — runs the provider's own one-job round-trip.
  Used by the wizard's "Test connection" button and the
  `--test-llm` CLI.

Internal contract per provider:

- Inherit `LLMProvider` from `backend/llm/base.py`.
- Set the `name` class attribute to the registry key.
- Implement `score_batch`, `complete`, `test`.
- Use `backend.llm._shared.parse_json_response` to defang ` ```json `
  fences that some providers wrap output in.

The `PROVIDERS` registry in `__init__.py` maps names to provider
classes. `AUTO_ORDER` defines resolve precedence:

```
claude_cli  →  claude_sdk  →  gemini  →  openai  →  openrouter  →  ollama
```

`get_provider()` reads `_ACTIVE_CONFIG["llm_provider"]["name"]` (set by
`search.load_config()` from the active profile). A non-`auto` value
short-circuits to that provider directly. `auto` walks `AUTO_ORDER`
calling `_quick_available()` on each — a cheap local check (env var
present, binary on `PATH`, Ollama reachable) — and picks the first
that passes. The expensive `test()` round-trip only runs when the user
clicks "Test connection", never on every scrape.

If the chosen provider then fails at score time the scraper falls back
to the regex fallback per-job rather than aborting the whole run.

## Few-shot feedback loop

The scoring system prompt is augmented with up to N (default six)
examples lifted from the user's own corpus, recency-sorted and
stratified positive/negative. The cap and stratification follow
Anthropic's prompt-engineering guidance — three to five examples is
the canonical recommendation, six leaves headroom for at least one
each pos/neg pair, anything past about ten starts hurting more than it
helps.

`_classify_feedback_row(row)` in `search.py` classifies each corpus
row's feedback signal:

- **rating** — explicit star rating (1–5). 4–5 = strong positive,
  1–2 = strong negative, 3 = weak positive (the user bothered to rate
  it instead of dismissing). When the user attached a free-text
  comment, that comment is the most information-dense single signal
  and is surfaced verbatim in the example line.
- **app_status** — kanban progress past one-click apply. Reaching
  `interview`, `take-home`, `screening`, or `offer` is treated as a
  strong positive (real human-human exchange beats any star rating).
  `rejected` and `withdrew` are negative.
- **manual-add** — a job the user pasted in by hand via the Add
  Manual button is itself a positive signal, even before any rating.
- **null** — every other row is ignored.

`_build_user_feedback_examples()` collects classified rows, sorts each
sentiment bucket newest-first, picks the cap split half-and-half,
interleaves them P/N/P/N to dodge LLM recency bias, and renders each
one as a single sanitized line (`title @ company [category] (prior fit:
ok) → rated 5/5 — "great team"`). PII like job URLs, ids, and
descriptions is stripped before the lines hit the prompt.

The result is wrapped in a `<user_feedback_examples>` block and
prepended to the scoring system prompt for the next batch. The user's
search self-tunes as they rate jobs and progress applications through
the kanban.

## Persistence

Three files at the repo root carry every byte of long-lived state.

### `results.json`

The full corpus. List of job dicts shaped like:

```jsonc
{
  "id": "4395123456",
  "title": "Senior Software Engineer",
  "company": "Acme Corp",
  "location": "Remote",
  "url": "https://www.linkedin.com/jobs/view/4395123456/",
  "category": "keyword",
  "category_name": "Keywords",
  "found_at": "2026-04-15T10:00:00",
  "scored_at": "...",
  "fit": "good", "score": 9, "fit_reasons": [...],
  "scored_by": "claude" | "regex" | "title-filter",
  "msc_required": false, "priority": false, "hot": true,
  "rating": 5, "comment": "...", "rated_at": "...",
  "app_status": "interview",
  "app_status_history": [...], "app_status_at": "...",
  "source": "guest" | "loggedin" | "manual"
}
```

Mutated under fcntl lock via `search._atomic_merge_json`. Dedup on `id`
is the writer's responsibility. `corpus_ctl.py` mutators all go through
`_atomic_merge_json` so the scraper's parallel writes never tear each
other.

### `seen_jobs.json`

Sorted list of job ids the scraper has ever processed — past plus
present. Append-only logical semantics (deletes from `results.json`
explicitly add the deleted id back here so the scraper does not re-add
it on the next run). Same lock as `results.json`.

### `run_history.json`

`{"runs": [{...}, ...]}` — one summary record per scrape, capped at the
last 100 entries. Powers the Run History tab. Append-only; the cap is
enforced server-side on each append.

### `digest.html`

Rendered output of `send_digest.build_digest_html(jobs)`. Overwritten
each scrape — there is no history of past digests. Always written
regardless of whether email or Telegram is configured; "open the latest
digest" works without any notification setup.

## Multi-profile

Profiles live as `configs/<name>.json` files. The "active" profile is
indicated two ways:

- `active_profile.txt` — single-line plain text, the active profile's
  name. Source of truth for everything except scripts that pre-date
  the multi-profile refactor.
- `config.json` — a symlink to `configs/<active>.json` (a regular
  file copy on Windows when symlink permissions are not available).
  Lets every legacy code path that opens `config.json` keep working.

`profile_ctl._migrate_if_needed()` is idempotent first-run plumbing.
It runs at the top of every `profile_ctl` command. If `configs/` does
not exist yet it creates `configs/default.json` from whatever
`config.json` already contained (or `defaults.json`, or an empty
stub), writes `active_profile.txt`, and replaces `config.json` with a
symlink. A second call is a no-op.

The Setup wizard's `cv_present` flag — returned by `profile_ctl list`
— is the real "user has finished onboarding" signal, not the existence
of `config.json`. After `_migrate_if_needed` runs once, every fresh
clone has a `config.json` symlink pointing at an auto-created
`default` profile, so file existence tells you nothing. `cv_present`
is OR-ed with `profile_configured` (active profile has at least one
non-empty queries list in its categories) to handle the case where a
user hand-edits a profile and skips the wizard.

The corpus is shared across profiles — `results.json`, `seen_jobs.json`,
and `run_history.json` are at the repo root, not under
`configs/<name>/`. The few-shot loop therefore picks up signals from
runs of any profile, which is the intended behavior: switching profiles
is not "starting over" but "asking a different question of the same
job market."

## Cross-platform scheduler

The OS-level scheduler installation is abstracted behind
`backend/ctl/scheduler/base.py:Scheduler`. Three concrete backends:

- `launchd.py` — macOS. Generates a plist under
  `~/Library/LaunchAgents/` and shells to `launchctl`.
- `systemd_user.py` — Linux. Generates a `.service` plus `.timer` pair
  under `~/.config/systemd/user/` and shells to `systemctl --user`.
- `schtasks.py` — Windows. Generates a task XML and shells to
  `schtasks.exe /Create`.

`scheduler_ctl.py` picks the right backend at runtime by
`platform.system()`. The platform-specific artifact (plist, unit, task
XML) is generated at install time with paths computed from the user's
project root, so the same code works on any machine without
post-install editing. `run.py` is the entry point all three backends
invoke; it normalizes argv and invokes `search.py` with the configured
mode.

The UI's control surface (Crawler Config tab → Scheduler card) is
identical regardless of the host OS. The status JSON includes a
`backend` field (`"launchd"` / `"systemd-user"` / `"schtasks"`) and
`native_id` (plist path / unit name / task name) so the UI can show
"installed at /path" without TypeScript branching per platform.

## Notifications dispatcher

`backend/send_digest.py:dispatch_digest(jobs, channels=...)` is the
single fan-out point. It always writes `digest.html` to disk first
(best-effort — a failure here surfaces as a `digest_write` key in the
result dict but does not abort channel sends), then for each requested
channel invokes the matching sender.

Two channels currently implemented:

- **email** (SMTP) — `send_via_email`. Required env: `SMTP_HOST`,
  `SMTP_USER`, `SMTP_PASS`. Optional: `SMTP_PORT` (default 587),
  `EMAIL_TO` (default `SMTP_USER`), `SMTP_USE_SSL` (auto-on for port
  465). Uses the `certifi` CA bundle so macOS Pythons that ship without
  system root CAs do not fail with `CERTIFICATE_VERIFY_FAILED`.
- **telegram** — `send_via_telegram`. Required env:
  `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`. Posts to the Bot API's
  `sendMessage` endpoint with `parse_mode=HTML`. Falls back to a
  short summary message when the digest exceeds the 4096-char Telegram
  limit — chunking would tear HTML mid-tag and flood the chat. The bot
  token is scrubbed from any error message before it reaches a log.

`enabled_channels()` inspects `os.environ` and returns the subset of
known channels with all their required vars set. The scraper passes
this list into `dispatch_digest` so unconfigured channels are silently
skipped. Both channels are independent and can run at once. The
on-disk `digest.html` is always-on regardless of channel config — open
it in a browser straight from the repo root.

## UI architecture

Vite dev server with a custom plugin (`configApiPlugin` in
`ui/vite.config.ts`) that adds two layers of middleware:

1. Root JSON pass-through. `/results.json`, `/run_history.json`, and
   `/defaults.json` are served from the repo root with sensible empty
   fallbacks (`[]`, `{"runs": []}`, and an on-demand `--print-defaults`
   spawn respectively). `/digest.html` is served similarly with an
   inline placeholder when the file does not exist yet.
2. `/api/*` JSON endpoints. Each one validates the request body, calls
   `runCtl(scriptPath, args, stdinJson, timeoutMs)` to spawn the right
   ctl script, parses the script's stdout JSON envelope, and forwards
   it with the matching HTTP status. SENSITIVE bodies (LLM API keys,
   SMTP passwords, Telegram bot tokens) are never logged — handlers
   that touch them have an explicit `*** SENSITIVE ***` comment.

The React app is a single SPA with five top-level tabs (Corpus,
Tracker, Crawler Config, Run History, Setup) plus the OnboardingPage
state machine for the wizard. Components use TanStack Table for the
corpus grid, `@dnd-kit` for the kanban drag-and-drop, and Tailwind for
styling. Filter state is the URL — `filters.ts` provides
`fromSearchParams` / `toSearchParams` so a corpus view can be shared
or bookmarked, and the app reads back its UI state from the URL on
reload.

The OnboardingPage is a step machine with nine steps (0–8): preflight
checks, LLM provider pick + test, geo scope, scrape mode, CV upload,
intent paragraph, notifications, generate-and-review,
what-comes-next. Each step is its own file under
`ui/src/onboarding/steps/`, importing the shared `WizardDraft` shape
from `ui/src/onboarding/types.ts`. The wizard's eventual save call
hits `POST /api/onboarding/save-as-profile` which writes
`configs/<name>.json` and activates it via `profile_ctl`.
