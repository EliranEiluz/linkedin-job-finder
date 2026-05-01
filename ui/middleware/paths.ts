// Path + timeout constants used by the dev-only Vite middleware. Shared
// across the per-endpoint handler files so each handler doesn't have to
// re-derive the same `path.join(REPO_ROOT, 'backend', 'ctl', '…')`.
//
// REPO_ROOT is computed relative to this file's directory (ui/middleware).
// Two levels up (ui/middleware → ui → repo root) gives the same path the
// original vite.config.ts derived as `path.resolve(__dirname, '..')`.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..');
export const BACKEND_DIR = path.join(REPO_ROOT, 'backend');

export const CONFIG_PATH = path.join(REPO_ROOT, 'config.json');
export const CV_PATH = path.join(REPO_ROOT, 'cv.txt');
export const STATUS_PATH = path.join(REPO_ROOT, 'scrape_status.json');
export const LOG_DIR = path.join(REPO_ROOT, 'scrape_logs');
export const SEARCH_SCRIPT = path.join(BACKEND_DIR, 'search.py');
export const LINKEDIN_SESSION_PATH = path.join(REPO_ROOT, 'linkedin_session.json');

// ctl scripts.
export const SCHEDULER_CTL = path.join(BACKEND_DIR, 'ctl', 'scheduler_ctl.py');
export const ONBOARDING_CTL = path.join(BACKEND_DIR, 'ctl', 'onboarding_ctl.py');
export const CONFIG_SUGGEST_CTL = path.join(BACKEND_DIR, 'ctl', 'config_suggest_ctl.py');
export const PROFILE_CTL = path.join(BACKEND_DIR, 'ctl', 'profile_ctl.py');
export const CORPUS_CTL = path.join(BACKEND_DIR, 'ctl', 'corpus_ctl.py');
export const PREFLIGHT_CTL = path.join(BACKEND_DIR, 'ctl', 'preflight_ctl.py');
export const LLM_CTL = path.join(BACKEND_DIR, 'ctl', 'llm_ctl.py');
export const CV_EXTRACT_CTL = path.join(BACKEND_DIR, 'ctl', 'cv_extract_ctl.py');

// Per-script timeouts. Kept here (not in the handler files) so a single
// pass can audit which long-running calls might want a bigger budget.
export const SCHEDULER_TIMEOUT_MS = 10_000;
export const ONBOARDING_GENERATE_TIMEOUT_MS = 3 * 60 * 1000; // 3 min — Claude call
export const ONBOARDING_SAVE_TIMEOUT_MS = 10_000;
// Config-suggester is a single Claude call over feedback signals; 60s
// aligns with the script's own CLAUDE_TIMEOUT_S so a slow CLI response
// gets killed HTTP-side at the same time the subprocess does.
export const CONFIG_SUGGEST_TIMEOUT_MS = 75_000;
export const PROFILE_TIMEOUT_MS = 10_000;
export const CORPUS_TIMEOUT_MS = 8_000;
export const PREFLIGHT_TIMEOUT_MS = 30_000;
export const LLM_LIST_TIMEOUT_MS = 10_000;
export const LLM_SAVE_TIMEOUT_MS = 10_000;
export const LLM_TEST_TIMEOUT_MS = 30_000;
export const CV_EXTRACT_TIMEOUT_MS = 30_000;
// Mirrors MAX_BYTES in cv_extract_ctl.py.
export const CV_EXTRACT_MAX_BYTES = 10 * 1024 * 1024;
