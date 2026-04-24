#!/bin/bash
# Wrapper invoked by launchd. Runs search.py then send_email.py.
# Logs to run.log at the project root (rolling).

set -u

# This script lives at backend/launchd/run.sh — cd up to the project ROOT
# so all relative paths (cv.txt, results.json, run.log, etc.) resolve to
# the same place the rest of the codebase expects them.
cd "$(dirname "$0")/../.."

# Load SMTP credentials etc. from ~/.linkedin-jobs.env
if [ -f "$HOME/.linkedin-jobs.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$HOME/.linkedin-jobs.env"
  set +a
fi

# Make sure `claude` CLI is findable by LaunchAgent (which has a minimal PATH).
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.npm-global/bin:$PATH"

# IMPORTANT: pin the Python interpreter to the one that actually has the
# scraper's deps installed (requests, bs4, certifi, playwright, anthropic,
# defusedxml). When run from launchd, the PATH-resolved `python3` is
# /opt/homebrew/bin/python3 which has NONE of these — so `python3 search.py`
# crashed with ModuleNotFoundError. Override $PYTHON to point elsewhere if
# you install the deps into a different interpreter / venv.
PYTHON="${PYTHON:-/Library/Frameworks/Python.framework/Versions/3.14/bin/python3}"
if [ ! -x "$PYTHON" ]; then
  log "ERROR: PYTHON ($PYTHON) is not executable. Set the PYTHON env var to your Python with the scraper deps installed."
  exit 127
fi

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(ts)] $*" >> run.log; }

log "=== run start ==="

# Rotate log if it gets big (>2 MB).
if [ -f run.log ] && [ "$(wc -c < run.log)" -gt 2000000 ]; then
  mv run.log run.log.1
fi

# Backend mode: "guest" by default (no browser, no LinkedIn account, no
# session-expiry babysitting — ideal for unattended cron runs). Override
# to "loggedin" by setting LINKEDINJOBS_MODE=loggedin in the plist's
# EnvironmentVariables block (or in ~/.linkedin-jobs.env).
MODE="${LINKEDINJOBS_MODE:-guest}"
log "scraper mode: $MODE"

"$PYTHON" backend/search.py --mode="$MODE" >> run.log 2>&1
rc=$?
log "search.py exit=$rc"

if [ $rc -ne 0 ]; then
  log "search failed, skipping email"
  exit $rc
fi

"$PYTHON" backend/send_email.py >> run.log 2>&1
rc=$?
log "send_email.py exit=$rc"
log "=== run end ==="
exit $rc
