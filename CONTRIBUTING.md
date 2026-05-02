# Contributing

Thanks for your interest in linkedin-job-finder. This is a small project
and contributions are welcome — bug reports, fixes, features, docs, all of
it. The notes below should get you set up in a few minutes.

## Local dev setup

```bash
git clone https://github.com/EliranEiluz/linkedin-job-finder.git
cd linkedin-job-finder
python3 -m pip install -r backend/requirements.txt
python3 -m playwright install chromium    # only for --mode=loggedin
cd ui && npm install && cd ..
```

Then run the UI and walk the Setup wizard once to generate a profile:

```bash
cd ui && npm run dev    # http://localhost:5173
```

## Running tests

```bash
python3 -m pytest backend/tests           # Python regression suite
cd ui && npx vitest run                   # UI unit tests
cd ui && npm run build                    # production build (catches type + bundler regressions)
```

## Linters and type-checkers

All four must be clean before a PR can merge:

```bash
python3 -m ruff check .                   # Python lint
python3 -m ruff format --check .          # Python formatting
python3 -m mypy backend/                  # Python type-check
cd ui && npx tsc --noEmit                 # TypeScript type-check
cd ui && npx eslint .                     # TypeScript lint
```

## Project structure

`backend/` holds the Python code: `search.py` is the scraper + LLM scoring
entry point, `send_email.py` builds the digest, and `ctl/*_ctl.py` are the
JSON-CLI control surfaces that the UI shells to (one per concern:
scheduler, profile, onboarding, corpus mutations, config suggester). The
UI lives under `ui/` (React + Vite). Backend access from the browser goes
through Vite middleware in `ui/middleware/` — every endpoint just spawns
the matching `ctl` script and pipes JSON in / out.

## Filing issues

Use the templates under `.github/ISSUE_TEMPLATE/` — bug report, feature
request, or question. For general usage questions, GitHub Discussions is
the preferred place if it's enabled.

## Submitting PRs

Open a PR against `main`. The pull request template will prompt you for a
summary, linked issue, type of change, what you tested, and screenshots if
the change is user-facing.

Commit messages follow a lightweight conventional-commit style — prefix
with `feat:`, `fix:`, `chore:`, `docs:`, `test:`, or `refactor:`. Keep the
subject under 72 characters.

## Reporting security issues

Please do not file public issues for security reports. See
[SECURITY.md](SECURITY.md) for the private disclosure path.
