#!/usr/bin/env bash
# commit-msg hook: refuse to record an LLM Co-Authored-By trailer.
#
# pre-commit invokes this with the path to the prepared commit-message
# file as $1 (same contract as a raw .git/hooks/commit-msg hook).
#
# Matches any case-variation of "Co-Authored-By: Claude". The pattern is
# anchored to "claude" rather than the full known footer string so a future
# variant ("Claude Sonnet ...", "Claude Opus ...") still trips the gate.

set -euo pipefail

msg_file="${1:?usage: check_no_claude_coauthor.sh <commit-msg-file>}"

if grep -qiE '^[[:space:]]*Co-Authored-By:[[:space:]]*Claude' "$msg_file"; then
  echo "error: commit message contains a 'Co-Authored-By: Claude' trailer." >&2
  echo "Strip it before committing — Eliran is sole author of record." >&2
  exit 1
fi

exit 0
