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
   │ launchd  │───▶│  Python control surfaces (each a tiny JSON-CLI):         │ │
   │ (12h     │    │   search.py · scheduler_ctl.py · profile_ctl.py          │ │
   │  cron)   │    │   onboarding_ctl.py · corpus_ctl.py · send_email.py      │ │
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

```bash
git clone git@github.com:<you>/linkedin-job-finder.git
cd linkedin-job-finder

# Python deps. Tested against 3.11+. If your default python3 is the
# macOS framework build, the explicit interpreter form is the safe one:
python3 -m pip install -r requirements.txt
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

# Generate defaults.json (UI's "Reset to defaults" reads this)
python3 search.py --print-defaults > defaults.json
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
python3 search.py --mode=guest                  # no LinkedIn account, no browser
python3 search.py --mode=loggedin               # personalized; uses linkedin_session.json
python3 search.py --mode=guest --no-enrich      # skip description fetching (faster)
python3 search.py --mode=guest --all-time       # drop the 7-day window; any posting date
python3 search.py --print-defaults              # dump the hardcoded defaults to stdout

python3 send_email.py                           # build digest + send (needs SMTP env)
python3 scheduler_ctl.py status                 # JSON status of the launchd job
python3 profile_ctl.py list                     # show profiles + active
python3 corpus_ctl.py rate < /dev/null          # show CLI usage
python3 phase_d_test.py                         # run the regression test suite
```

For `--mode=loggedin`, the first run opens a Chromium window so you can
sign in once; the session is then cached in `linkedin_session.json`.

---

## What lives where

```
search.py              scraper + Claude scoring (CLI + SDK fallback)
onboarding_ctl.py      CV → config.json generator (used by Setup tab)
profile_ctl.py         multi-profile management (list/create/activate/rename/delete)
corpus_ctl.py          per-job mutations (rate, delete) for the row-actions popover
scheduler_ctl.py       install/uninstall/configure the launchd schedule
send_email.py          digest builder + SMTP send
rescue_unscored.py     one-shot: re-fetch + score any unscored jobs in the corpus
backfill_source.py     one-shot: tag pre-source-tagging jobs as `loggedin`
debug_query.py         on-demand JYMBII / banner / eBP inspector for one query
probe_guest_api.py     direct GET against /jobs-guest/jobs/api/seeMoreJobPostings/search
probe_guest_detail.py  direct GET against /jobs-guest/jobs/api/jobPosting/<id>
phase_d_test.py        end-to-end regression suite (33 cases)

ui/                    React + Vite app; the dev middleware in vite.config.ts
                       shells to all the *_ctl.py scripts
ui/src/                React components: 4 tabs + reusable atoms
ui/public/             symlinks to gitignored state files (results, history, etc.)

run.sh                 launchd wrapper — sources ~/.linkedin-jobs.env, runs
                       search.py then send_email.py
com.eliran.linkedinjobs.plist  LaunchAgent template — copied into
                                ~/Library/LaunchAgents/ by `scheduler_ctl.py install`

requirements.txt       playwright, requests, beautifulsoup4, certifi,
                       defusedxml, lxml, anthropic
.linkedin-jobs.env.example   SMTP creds template

CODE_REVIEW.md         architectural audit + test strategy notes
```

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

MIT. See [LICENSE](LICENSE) (none yet — add one if you fork this).
