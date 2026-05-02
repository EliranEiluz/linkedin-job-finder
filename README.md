# linkedin-job-finder

> Scrape LinkedIn jobs, score them against your CV with any LLM, track applications on a kanban.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Python 3.10+](https://img.shields.io/badge/python-3.10%2B-blue.svg)](https://www.python.org/downloads/)
[![Node 18+](https://img.shields.io/badge/node-18%2B-339933.svg)](https://nodejs.org/)
[![Code style: ruff](https://img.shields.io/badge/code%20style-ruff-000000.svg)](https://github.com/astral-sh/ruff)

![30-second tour: scrape, score, apply](docs/assets/hero.gif)

*30-second tour: scrape, score, apply.*

## What it does

- **Scrapes LinkedIn at scale** in two modes: a no-account guest crawler and a Playwright-backed logged-in crawler that catches jobs the guest endpoint hides.
- **Scores every posting against your CV** through a provider-agnostic LLM layer (Claude, Gemini, OpenAI, OpenRouter, Ollama) with a few-shot loop that picks up your most recent positive and negative ratings.
- **Tracks applications on a kanban** (New / Applied / Screening / Interview / Take-home / Offer / Rejected / Withdrew) with per-card notes and a status history.
- **Onboards through a wizard.** Paste your CV plus one paragraph of intent and the LLM proposes a starter config (queries, target companies, scoring prompt) you review and save.

## Quickstart

Under 30 seconds to your first scrape:

```bash
git clone https://github.com/EliranEiluz/linkedin-job-finder.git
cd linkedin-job-finder
python3 -m pip install -r backend/requirements.txt
cd ui && npm install && npm run dev
```

Open <http://localhost:5173>, walk the Setup wizard (preflight checks, LLM provider, paste CV + intent), then hit **Run scraper** in the Crawler Config tab. The Corpus tab fills with scored jobs as the run progresses.

## How it works

```
                     ┌─────────────── React UI (Vite, port 5173) ──────────────┐
                     │  ┌────────┐ ┌──────────┐ ┌──────────────┐ ┌──────────┐ │
                     │  │ Corpus │ │ Tracker  │ │ Crawler Conf │ │  Setup   │ │
                     │  └───┬────┘ └────┬─────┘ └──────┬───────┘ └────┬─────┘ │
                     │      │           │              │              │       │
                     │      │ /results.json   /api/config*    /api/onboarding*│
                     │      │ /api/corpus/*   /api/scrape*    /api/scheduler* │
                     │      │ /api/tracker/*  /api/config/suggest             │
                     │      └───────────┴──────────────┴──────────────┐       │
                     └────────────────────────────────────────────────┘       │
                                       │ Vite dev middleware (Node)          │
                                       ▼                                     │
   ┌──────────────┐    ┌─────────────────────────────────────────────────────┴─┐
   │ OS scheduler │───▶│  Python control surfaces under backend/ (JSON-CLIs):  │
   │  launchd /   │    │   search.py, send_email.py, ctl/{scheduler,profile,   │
   │  systemd /   │    │   onboarding,corpus,config_suggest}_ctl.py            │
   │  schtasks    │    └────┬─────────────┬──────────────────┬─────────────┬───┘
   └──────────────┘         │             │                  │             │
                            ▼             ▼                  ▼             ▼
                  ┌──────────────┐  ┌──────────┐    ┌──────────────┐ ┌──────────┐
                  │ /jobs-guest  │  │   LLM    │    │ results.json │ │   SMTP   │
                  │  HTTP API    │  │ provider │    │ seen_jobs    │ │  digest  │
                  │  (no auth)   │  └──────────┘    │ run_history  │ └──────────┘
                  └──────────────┘                  │ configs/*    │
                          OR                        └──────────────┘
                  ┌──────────────┐
                  │  Playwright  │
                  │  + session   │
                  └──────────────┘
```

Cross-platform (macOS / Linux / Windows). Multi-profile so one repo can
drive several parallel searches.

## Highlights

- **Two scrape modes.** `guest` (no LinkedIn account, HTTP-only, ~5× more
  results because no personalization) or `loggedin` (Playwright + a saved
  session for jobs the guest endpoint hides). Both can run concurrently —
  `filelock`-coordinated atomic merges keep `results.json` consistent.
- **LLM scoring with a feedback loop.** Each job description goes to
  your configured LLM (Claude / Gemini / OpenAI / OpenRouter / Ollama)
  with your CV. Outputs `fit ∈ {good, ok, skip}`,
  `score 1–10`, free-text reasons. As you rate jobs and progress them
  through the kanban, the scorer's few-shot prompt automatically picks
  up your most recent positive/negative signals — recency-weighted,
  stratified pos/neg, capped per Anthropic's prompt-engineering guidance.
- **Kanban application tracker.** New / Applied / Screening / Interview /
  Take-home / Offer / Rejected / Withdrew. Drag cards across columns,
  attach long-form notes, see a per-card status history.
- **Claude-powered config tuning.** Hit "Improve this config from
  feedback" — Claude reads up to 30 of your most recent ratings,
  applications, and manual-adds + your current config, suggests new
  queries, new priority companies, or off-topic title regexes. You
  approve which to apply with checkboxes.
- **Manual add.** Paste a LinkedIn URL or job ID; the job walks the same
  scrape + score pipeline a daily-run job does — including all your
  feedback signals.
- **Onboarding wizard.** Paste your CV + one paragraph about the roles
  you want. Claude generates a starter config (queries, priority
  companies, scoring prompt, regex hints) you review and save as a
  named profile.
- **Cross-platform scheduler.** `launchd` (macOS), `systemd --user`
  (Linux), `schtasks` (Windows). Same UI control surface across all
  three; the right backend is picked at runtime via `platform.system()`.
- **Email digest.** Each scheduled run sends a polished HTML digest of
  new jobs to your inbox. Opt-in via SMTP env file.
- **Multi-profile.** Different profiles = different queries, target
  companies, scoring rules. Switch with one dropdown. The corpus is
  shared so the feedback loop sees signals from any profile's runs.

## Setup

```bash
git clone https://github.com/EliranEiluz/linkedin-job-finder.git
cd linkedin-job-finder

python3 -m pip install -r backend/requirements.txt
python3 -m playwright install chromium    # only for --mode=loggedin

cd ui && npm install && cd ..

# Generate defaults.json — the UI's "Reset to defaults" button reads this.
# Required after every fresh clone; regenerate any time you change the
# hardcoded defaults inside search.py.
python3 backend/search.py --print-defaults > defaults.json
```

### Pick an LLM auth path (you need one)

```bash
# Option A — Claude Code CLI (uses your Claude.ai subscription, no key)
npm i -g @anthropic-ai/claude-code && claude /login

# Option B — Anthropic API key
export ANTHROPIC_API_KEY=sk-ant-...

# Option C — Gemini (free tier, 1500 RPM): https://aistudio.google.com/apikey
export GEMINI_API_KEY=...

# Option D — OpenAI / ChatGPT (paid)
export OPENAI_API_KEY=sk-...

# Option E — OpenRouter (catalog of free models): https://openrouter.ai/keys
export OPENROUTER_API_KEY=sk-or-...

# Option F — Ollama (fully local, no key, no network)
# (pull whichever model you want; defaults are in backend/llm/ollama.py)
ollama serve && ollama pull <model>
```

Resolution order on a fresh run is: `claude_cli → claude_sdk → gemini →
openai → openrouter → ollama`. The first one configured wins. Pin a
specific provider by editing `config.json`:

```json
{ "llm_provider": { "name": "gemini" } }
```

Verify your setup without scraping:

```bash
python3 backend/search.py --test-llm           # auto-resolve
python3 backend/search.py --test-llm gemini    # specific provider
```

### Optional: SMTP for the email digest

Configure SMTP via the Setup wizard's Notifications step, or hand-edit
`~/.linkedin-jobs.env` (see `.linkedin-jobs.env.example`).

```bash
cp .linkedin-jobs.env.example ~/.linkedin-jobs.env
$EDITOR ~/.linkedin-jobs.env       # paste in Gmail app password etc.
chmod 600 ~/.linkedin-jobs.env
```

Skip if you only want the UI.

## First run

A fresh clone ships domain-neutral — no hardcoded queries, no target
companies, no scoring rules. The **Setup wizard is the only onboarding
path**; until you finish it the UI hides everything except the Setup tab.

1. **Start the UI**: `cd ui && npm run dev` → open <http://localhost:5173>.
   On a fresh install you'll land on the Setup tab automatically; the
   Corpus / Tracker / Crawler Config / Run History tabs only appear once
   onboarding has produced a configured profile + a saved CV.
2. **Setup tab — wizard.** Walks you through preflight checks, LLM
   provider pick, geo scope, scrape mode, then asks for your CV and a
   one-paragraph intent (seniority, stack, geo, hard no-gos). Claude (or
   whichever provider you picked) generates a starter config — categories,
   priority companies, the scoring prompt, regex hints. Review, name,
   save. This writes `configs/<name>.json` and the rest of the tabs
   unlock.
3. **Crawler Config → Run scraper.** Pick `guest`. First run takes
   5–15 min. Watch the live log in the panel.
4. **Refresh the Corpus tab.** Sort by Score, mark applied, drag the
   ones you sent into the Tracker.
5. **(Optional) Schedule it.** Crawler Config → Scheduler → Install.
   Default interval 12h, mode `guest`. Works on macOS, Linux, or Windows
   without changing anything else.

Power users can hand-edit `configs/<name>.json` directly instead of
running the wizard, but the wizard is the supported path and the only
one the UI surfaces.

## Daily use

- **Find roles fast.** Sort the Corpus by Score, scan the top, hit
  `o` to open the LinkedIn page in a new tab. Two clicks to mark
  applied / rate 1–5 / delete via the row popover.
- **Track applications.** Drop the Open ↗'d job into the Tracker's
  Applied column. As it moves through Screening → Interview → Offer,
  the few-shot loop treats those stages as strong positive signal in
  Claude's next scoring pass — your search self-tunes.
- **Improve the system.** Once you've rated/applied to ~5 jobs the
  Suggester button lights up. Claude proposes new queries / priority
  companies / off-topic regexes from your real signals; you pick which
  to apply.
- **Switch profiles.** Crawler Config → Profile dropdown. Saved jobs
  are shared across profiles; queries / scoring / target companies
  differ per profile.

## CLI shortcuts

```bash
python3 backend/search.py --mode=guest                  # no LinkedIn account, no browser
python3 backend/search.py --mode=loggedin               # personalized; uses linkedin_session.json
python3 backend/search.py --mode=guest --no-enrich      # skip description fetching (faster)
python3 backend/search.py --mode=guest --all-time       # drop the 7-day window
python3 backend/search.py --print-defaults              # dump hardcoded defaults

python3 backend/send_email.py                           # build digest + send (needs SMTP env)
python3 backend/ctl/scheduler_ctl.py status             # JSON status of the OS scheduler job
python3 backend/ctl/profile_ctl.py list                 # show profiles + active
python3 backend/ctl/corpus_ctl.py rate < /dev/null      # show CLI usage
python3 backend/ctl/config_suggest_ctl.py < /dev/null   # try a suggestion run
python3 backend/tests/phase_d_test.py                   # regression suite (33 cases)
```

For `--mode=loggedin`, the first run opens a Chromium window so you can
sign in once; the session is cached in `linkedin_session.json`.

## Layout

```
backend/                          all Python — scraper, control CLIs, tests
├── requirements.txt
├── search.py                     scraper + Claude scoring (CLI + SDK fallback)
├── send_email.py                 digest builder + SMTP send
├── run.py                        cross-platform scheduler entry point
├── ctl/                          control CLIs the UI shells to
│   ├── scheduler/                cross-platform scheduler abstraction
│   │   ├── base.py               ABC
│   │   ├── launchd.py            macOS
│   │   ├── systemd_user.py       Linux
│   │   └── schtasks.py           Windows
│   ├── scheduler_ctl.py          install/uninstall/configure the schedule
│   ├── profile_ctl.py            multi-profile management
│   ├── onboarding_ctl.py         CV → config.json generator
│   ├── corpus_ctl.py             per-job mutations (rate, delete, app-status, manual-add)
│   └── config_suggest_ctl.py     Claude-powered config suggester
├── probes/                       diagnostic / debug tools
│   ├── debug_query.py
│   ├── probe_guest_api.py
│   └── probe_guest_detail.py
├── tools/
│   └── rescue_unscored.py        re-fetch + score any unscored corpus rows
└── tests/
    └── phase_d_test.py           end-to-end regression suite

ui/                               React + Vite app
├── vite.config.ts                dev middleware — shells to backend/ctl/* scripts
└── src/                          components: 5 tabs (Corpus, Tracker, Crawler Config,
                                  Run History, Setup) + reusable atoms

.linkedin-jobs.env.example        SMTP creds template
```

The platform-specific scheduler artefact (plist on macOS, unit on Linux,
task on Windows) is **generated at install time** by `scheduler_ctl.py`
with paths computed from the cloner's project root, so the same code
works on any machine.

### Gitignored personal state (only exists locally)

```
configs/<name>.json    per-profile config (queries, priority companies, scoring prompt)
config.json            symlink to the active profile (regular file on Windows)
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

## Acknowledgements

- [Anthropic Claude](https://claude.com) — the actual scoring intelligence
- [Playwright](https://playwright.dev) — logged-in scrape path
- [TanStack Table](https://tanstack.com/table) — corpus grid
- [@dnd-kit](https://dndkit.com) — kanban drag-and-drop
- [filelock](https://github.com/tox-dev/filelock) — cross-platform atomic merges
- LinkedIn's public `/jobs-guest/` endpoints — guest scrape path

## License

[MIT](LICENSE) — © 2026 Eliran Eiluz.
