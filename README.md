# linkedin-job-finder

A personal LinkedIn job hunter. Pulls postings via LinkedIn's guest API or a
saved logged-in session, scores each one against your CV with Claude, and
serves the result through a small React dashboard plus an optional emailed
digest. Multi-profile — keep a separate config for each role search.

> **Privacy note.** This is a single-user tool. Everything runs locally.
> Your CV, scraped jobs, ratings, and applied-state never leave your
> machine — except (a) the per-job descriptions sent to Claude for
> scoring and (b) the daily HTML digest sent via your own SMTP if you
> opt in.

---

## Highlights

- **Two scrape modes.** `guest` (no LinkedIn account, no browser, ~5× more
  results because no personalization) or `loggedin` (Playwright + a saved
  session for jobs the guest endpoint hides). Both can run in parallel —
  fcntl-locked merges keep `results.json` consistent.
- **Claude scoring with regex fallback.** Each job's description goes to
  `claude-sonnet-4-5` with your CV; outputs `fit ∈ {good, ok, skip}`,
  `score ∈ 1..10`, and free-text reasons. Regex fallback labels jobs
  whose description fetch failed.
- **Onboarding wizard.** Paste your CV + a paragraph about your target
  roles. Claude generates a full starter config (queries, priority
  companies, scoring prompt, regex hints) you can review and save as a
  named profile.
- **Browse + curate.** Filter (fit / score / category / source / date /
  applied), sort, search, mark applied, rate 1–5 stars, delete. Keyboard
  nav (`j/k`, `a` toggle applied, `o` open in new tab, `?` cheatsheet).
- **Emailed digest.** Daily/12h cron via macOS launchd → polished HTML
  digest of new jobs to your inbox. Opt-in by populating
  `~/.linkedin-jobs.env`.
- **Configurable from the UI.** Crawler Config tab edits queries,
  priority companies, scoring prompt, regex patterns, scraper schedule,
  active profile — no Python needed.

---

## Architecture

```
                     ┌──────────────── React UI (Vite, port 5173) ────────────────┐
                     │  ┌─────────┐ ┌──────────────┐ ┌──────────────┐ ┌────────┐ │
                     │  │ Corpus  │ │ Crawler Conf │ │ Run History  │ │ Setup  │ │
                     │  └────┬────┘ └──────┬───────┘ └──────┬───────┘ └────┬───┘ │
                     │       │             │                │              │     │
                     │       │ /results.json /api/config*   /run_history*  │     │
                     │       │ /api/corpus/* /api/scheduler*                │     │
                     │       │               /api/scrape*  /api/onboarding*│     │
                     │       └───────────────┴────────────────────────────┐│     │
                     └────────────────────────────────────────────────────┘│     │
                                            │ Vite dev middleware (Node)  │     │
                                            ▼                              │     │
   ┌──────────┐    ┌──────────────────────────────────────────────────────┴───┐ │
   │ launchd  │───▶│  Python control surfaces under backend/ (tiny JSON-CLIs):│ │
   │ (12h     │    │   search.py, send_email.py, ctl/{scheduler,profile,     │ │
   │  cron)   │    │   onboarding,corpus}_ctl.py                              │ │
   └──────────┘    └──────┬──────────────┬──────────────────┬─────────────┬───┘ │
                          │              │                  │             │     │
                          ▼              ▼                  ▼             ▼     │
                  ┌──────────────┐  ┌──────────┐    ┌──────────────┐ ┌───────┐  │
                  │ /jobs-guest  │  │ Claude   │    │ results.json │ │ Gmail │  │
                  │  HTTP API    │  │ CLI/SDK  │    │ seen_jobs    │ │ SMTP  │  │
                  │  (no auth)   │  └──────────┘    │ run_history  │ └───────┘  │
                  └──────────────┘                  │ configs/*    │            │
                          OR                        └──────────────┘            │
                  ┌──────────────┐                                              │
                  │  Playwright  │                                              │
                  │  + session   │                                              │
                  └──────────────┘                                              │
```

- **Backend = Python + tiny JSON-CLIs.** Every backend operation is a
  subcommand of one `*_ctl.py` script that reads JSON from stdin and
  emits JSON on stdout. The Vite dev middleware shells to them — no
  long-running web server needed.
- **State = plain JSON files** with fcntl-locked atomic merges. Two
  scrape processes can run in parallel without clobbering each other.
- **Config = symlink.** `config.json → configs/<active>.json` lets you
  swap profiles in one syscall and have `search.py` transparently pick
  up the new active config on next run.

---

## One-time setup

> **Requirements:**
> - Python ≥ 3.10 (the codebase uses PEP 604 `int | None` union syntax).
> - Node.js (for the UI — any LTS release works).
> - `defaults.json` and `ui/public/defaults.json` are pre-tracked in the repo,
>   so the `--print-defaults` regenerate step below is optional unless you've
>   changed the in-file defaults in `search.py`.
> - **LaunchAgent installs only:** `~/.linkedin-jobs.env` may need a
>   `PYTHON=/path/to/python3` line if your `python3` isn't at the path baked
>   into `backend/launchd/run.sh`. See the Troubleshooting section for details.

```bash
git clone git@github.com:<you>/linkedin-job-finder.git
cd linkedin-job-finder

# Python deps. Tested against 3.11+. If your default python3 is the
# macOS framework build, the explicit interpreter form is the safe one:
python3 -m pip install -r backend/requirements.txt
python3 -m playwright install chromium    # only needed for --mode=loggedin

# UI deps
cd ui && npm install && cd ..

# Recreate the symlinks the UI uses to read state files. The targets
# don't exist yet — they'll appear after your first scrape; the UI's
# error states handle the meantime gracefully.
mkdir -p ui/public
ln -sf ../../results.json      ui/public/results.json
ln -sf ../../run_history.json  ui/public/run_history.json
ln -sf ../../defaults.json     ui/public/defaults.json
ln -sf ../../config.json       ui/public/config.json

# Generate defaults.json (UI's "Reset to defaults" reads this).
# Optional — defaults.json is already pre-tracked; only needed if you
# changed the in-file defaults in search.py.
python3 backend/search.py --print-defaults > defaults.json
```

### Pick an LLM auth path (you need ONE)

```bash
# Option A: Claude Code CLI (recommended — uses your Claude.ai subscription)
npm i -g @anthropic-ai/claude-code
claude /login

# Option B: Anthropic API key
export ANTHROPIC_API_KEY=sk-ant-...
```

Both onboarding (`onboarding_ctl.py`) and per-job scoring (`search.py`)
try the CLI first and fall back to the SDK if `ANTHROPIC_API_KEY` is set.

### Optional: SMTP for the email digest

```bash
cp .linkedin-jobs.env.example ~/.linkedin-jobs.env
$EDITOR ~/.linkedin-jobs.env       # paste in Gmail app password etc.
chmod 600 ~/.linkedin-jobs.env
```

Skip this if you only want the UI.

---

## First-run flow

1. **Start the UI**: `cd ui && npm run dev` → open <http://localhost:5173>.
2. **Open the Setup tab.** Paste your CV, write one paragraph about the
   roles you want (seniority, stack, geo, hard no-gos). Click Generate.
   Claude returns a starter config; review it, name your profile, click
   "Save as new profile". This writes `configs/<name>.json`, points
   `config.json` at it, and switches you to the Crawler Config tab.
3. **(Optional)** Tweak queries / priority companies / scoring prompt
   in Crawler Config. Defaults are good for most cases.
4. **Crawler Config → Run scraper.** Pick `guest` (recommended). First
   run takes 5–15 min. Watch the live log in the panel.
5. **Refresh the Corpus tab.** Filter / sort / mark applied / rate.
6. **(Optional) Schedule it.** Crawler Config → Scheduler card → Install
   LaunchAgent. Default interval is 12h, mode `guest`.

---

## Daily use

- **Find roles fast.** Sort by Score, scan the top of the list, hit `o`
  to open the LinkedIn page in a new tab. The row-actions popover lets
  you mark applied / rate 1–5 stars / delete in two clicks.
- **Email digest.** If SMTP is configured, every scheduled run sends a
  polished HTML digest of new jobs to your inbox.
- **Multiple profiles.** Setup wizard → "Save as new profile" with a
  different name. Crawler Config → Profile dropdown switches between
  them. The corpus is shared (all profiles add to the same
  `results.json`); each profile only differs in queries and scoring.
- **Filters.** All checkbox filters use "empty Set = match all"
  semantics — the URL stays clean while every job is visible. Click a
  checkbox to subset; uncheck back to match-all.

---

## CLI shortcuts

```bash
python3 backend/search.py --mode=guest                  # no LinkedIn account, no browser
python3 backend/search.py --mode=loggedin               # personalized; uses linkedin_session.json
python3 backend/search.py --mode=guest --no-enrich      # skip description fetching (faster)
python3 backend/search.py --mode=guest --all-time       # drop the 7-day window; any posting date
python3 backend/search.py --print-defaults              # dump the hardcoded defaults to stdout

python3 backend/send_email.py                           # build digest + send (needs SMTP env)
python3 backend/ctl/scheduler_ctl.py status                 # JSON status of the launchd job
python3 backend/ctl/profile_ctl.py list                     # show profiles + active
python3 backend/ctl/corpus_ctl.py rate < /dev/null          # show CLI usage
python3 backend/tests/phase_d_test.py                         # run the regression test suite
```

For `--mode=loggedin`, the first run opens a Chromium window so you can
sign in once; the session is then cached in `linkedin_session.json`.

---

## What lives where

```
backend/                          all Python — scraper, control CLIs, tests
├── requirements.txt              Python deps
├── search.py                     scraper + Claude scoring (CLI + SDK fallback)
├── send_email.py                 digest builder + SMTP send
├── ctl/                          control CLIs the UI shells to
│   ├── scheduler_ctl.py          install/uninstall/configure the launchd schedule
│   ├── profile_ctl.py            multi-profile management
│   ├── onboarding_ctl.py         CV → config.json generator
│   └── corpus_ctl.py             per-job mutations (rate, delete)
├── probes/                       diagnostic / debug tools
│   ├── debug_query.py            on-demand JYMBII / banner / eBP inspector
│   ├── probe_guest_api.py        direct GET against /jobs-guest/.../search
│   └── probe_guest_detail.py     direct GET against /jobs-guest/.../jobPosting/<id>
├── tools/                        one-shot maintenance helpers
│   └── rescue_unscored.py        re-fetch + score any unscored jobs in corpus
├── tests/
│   └── phase_d_test.py           end-to-end regression suite (33 cases)
└── launchd/                      macOS scheduling
    └── run.sh                    launchd wrapper — sources ~/.linkedin-jobs.env

ui/                               React + Vite app
├── vite.config.ts                dev middleware — shells to backend/ctl/* scripts
├── src/                          components: 4 tabs (Corpus, Crawler Config,
│                                 Run History, Setup) + reusable atoms
└── public/                       symlinks to gitignored state files

defaults.json                     scraper defaults (regenerate via
                                  `python3 backend/search.py --print-defaults`)
.linkedin-jobs.env.example        SMTP creds template
```

The LaunchAgent plist is **generated** by `scheduler_ctl.py install` at
runtime — no template file in the repo. The generated plist is written
to `~/Library/LaunchAgents/com.linkedinjobs.plist` with paths computed
from the cloner's project root, so the same code works on any machine.

### Gitignored personal state (only exists locally)

```
configs/<name>.json    per-profile config (queries, priority companies, scoring prompt)
config.json            symlink to the active profile
active_profile.txt     name of the active profile
cv.txt                 your CV (used by both Claude scoring and onboarding)
results.json           the full scraped + scored corpus
seen_jobs.json         dedup state — job IDs we've ever seen
new_ids.json           IDs added in the most recent scrape (for the email digest)
run_history.json       per-run summary; powers the Run History tab
linkedin_session.json  cached LinkedIn auth (loggedin mode only)
digest.html            most-recent rendered email body
scrape_status.json     scraper run state for the UI
scrape_logs/           per-run subprocess output
```

---

## Troubleshooting

- **Scheduler runs but nothing happens.** Check `run.log`. Most common
  cause: launchd's minimal PATH picks up a Python that lacks the
  scraper's deps. `run.sh` pins
  `/Library/Frameworks/Python.framework/Versions/3.14/bin/python3` —
  override with `export PYTHON=/path/to/your/python3`.
- **Guest mode returns 0 hits.** Run
  `python3 debug_query.py "your query"` to see which classification path
  triggered. If it's `banner` for every query, your IP may be temporarily
  rate-limited; wait an hour or use `--mode=loggedin`.
- **HTTP 429 from the guest description endpoint.** `fetch_description_guest`
  honors `Retry-After` and exponentially backs off (30s → 60s → 120s).
  Persistent 429s mean LinkedIn is rate-limiting; reduce
  `max_pages` in Crawler Config or run less often.
- **`Cat Mobyb81c 5` showing up as a category.** Old config bug — your
  active profile has auto-generated category IDs but the UI looks up
  `name` from the config (post-fix). Refresh and check.

---

## Acknowledgements

Built on:
- [Playwright](https://playwright.dev) for the logged-in path
- [TanStack Table](https://tanstack.com/table) for the corpus grid
- [Anthropic Claude](https://claude.com) for the actual scoring intelligence
- LinkedIn's public `/jobs-guest/` endpoints for the guest path

---

## License

[MIT](LICENSE) — © 2026 Eliran Eiluz.
