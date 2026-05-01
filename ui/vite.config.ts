import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { promises as fs } from 'node:fs';
import { existsSync, openSync, closeSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';

// Personal-tool dev-only middleware. Lets the UI read/write the scraper's
// config.json on disk during `npm run dev`. NOT compiled into the production
// build — `npm run build` is just a static bundle.
// After the 2026-04 reorg: Python lives under backend/. State files
// (config.json, cv.txt, scrape_status.json, scrape_logs/) stay at the
// project root so the layout stays familiar.
const REPO_ROOT = path.resolve(__dirname, '..');
const BACKEND_DIR = path.join(REPO_ROOT, 'backend');
const CONFIG_PATH = path.join(REPO_ROOT, 'config.json');
const CV_PATH = path.join(REPO_ROOT, 'cv.txt');
const STATUS_PATH = path.join(REPO_ROOT, 'scrape_status.json');
const LOG_DIR = path.join(REPO_ROOT, 'scrape_logs');
const SEARCH_SCRIPT = path.join(BACKEND_DIR, 'search.py');
const SCHEDULER_CTL = path.join(BACKEND_DIR, 'ctl', 'scheduler_ctl.py');
const SCHEDULER_TIMEOUT_MS = 10_000;
const ONBOARDING_CTL = path.join(BACKEND_DIR, 'ctl', 'onboarding_ctl.py');
const ONBOARDING_GENERATE_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes — Claude call
const ONBOARDING_SAVE_TIMEOUT_MS = 10_000;
// Config-suggester is a single Claude call over feedback signals; 60s aligns
// with the script's own CLAUDE_TIMEOUT_S so a slow CLI response gets killed
// HTTP-side at the same time the subprocess does.
const CONFIG_SUGGEST_CTL = path.join(BACKEND_DIR, 'ctl', 'config_suggest_ctl.py');
const CONFIG_SUGGEST_TIMEOUT_MS = 75_000;
const PROFILE_CTL = path.join(BACKEND_DIR, 'ctl', 'profile_ctl.py');
const CORPUS_CTL = path.join(BACKEND_DIR, 'ctl', 'corpus_ctl.py');
const CORPUS_TIMEOUT_MS = 8_000;
const PROFILE_TIMEOUT_MS = 10_000;
// Wizard plumbing — Stage 3 welcome wizard (preflight + LLM picker + linkedin
// session check). All shell out via runCtl() like the other ctl scripts.
const PREFLIGHT_CTL = path.join(BACKEND_DIR, 'ctl', 'preflight_ctl.py');
const PREFLIGHT_TIMEOUT_MS = 30_000;
const LLM_CTL = path.join(BACKEND_DIR, 'ctl', 'llm_ctl.py');
const LLM_LIST_TIMEOUT_MS = 10_000;
const LLM_SAVE_TIMEOUT_MS = 10_000;
const LLM_TEST_TIMEOUT_MS = 30_000;
const LINKEDIN_SESSION_PATH = path.join(REPO_ROOT, 'linkedin_session.json');

type ScrapeMode = 'loggedin' | 'guest';
type RunStatus = 'running' | 'done' | 'error' | 'killed';

interface ScrapeRun {
  id: string;
  mode: ScrapeMode;
  pid: number;
  started_at: string;
  ended_at: string | null;
  status: RunStatus;
  exit_code: number | null;
  log_path: string; // relative to REPO_ROOT
}

interface ScrapeStatusFile {
  runs: ScrapeRun[];
}

const readJsonBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

const sendJson = (res: ServerResponse, status: number, body: unknown) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
};

// --- scrape_status.json helpers ---------------------------------------

const readStatus = async (): Promise<ScrapeStatusFile> => {
  if (!existsSync(STATUS_PATH)) return { runs: [] };
  try {
    const raw = await fs.readFile(STATUS_PATH, 'utf8');
    if (!raw.trim()) return { runs: [] };
    const parsed = JSON.parse(raw) as ScrapeStatusFile;
    if (!parsed || !Array.isArray(parsed.runs)) return { runs: [] };
    return parsed;
  } catch {
    return { runs: [] };
  }
};

// Atomic write — same temp+rename pattern the rest of the project uses.
// Note: this isn't fcntl-locked across processes, but the middleware is
// the sole writer, so a process-local serialization queue is sufficient.
let writeChain: Promise<void> = Promise.resolve();
const writeStatus = (status: ScrapeStatusFile): Promise<void> => {
  writeChain = writeChain
    .catch(() => undefined)
    .then(async () => {
      const tmp = STATUS_PATH + '.tmp';
      await fs.writeFile(tmp, JSON.stringify(status, null, 2) + '\n', 'utf8');
      await fs.rename(tmp, STATUS_PATH);
    });
  return writeChain;
};

const updateRun = async (
  id: string,
  patch: Partial<ScrapeRun>,
): Promise<void> => {
  const status = await readStatus();
  const idx = status.runs.findIndex((r) => r.id === id);
  if (idx === -1) return;
  status.runs[idx] = { ...status.runs[idx], ...patch };
  await writeStatus(status);
};

// --- PID liveness + log tail -----------------------------------------

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const tailFile = async (
  absPath: string,
  maxLines = 200,
  maxBytes = 16 * 1024,
): Promise<string> => {
  if (!existsSync(absPath)) return '';
  try {
    const stat = await fs.stat(absPath);
    const size = stat.size;
    const start = Math.max(0, size - maxBytes);
    const fh = await fs.open(absPath, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      await fh.read(buf, 0, buf.length, start);
      const text = buf.toString('utf8');
      const lines = text.split('\n');
      // Drop a possibly-partial first line if we sliced mid-file.
      if (start > 0 && lines.length > 1) lines.shift();
      return lines.slice(-maxLines).join('\n');
    } finally {
      await fh.close();
    }
  } catch {
    return '';
  }
};

// Heuristic for reconciling "running" entries whose PID has died (e.g. the
// dev server restarted, lost the child handle, and the scraper finished
// silently). The Python script prints "All results saved" on success.
const reconcileFinishedStatus = (logTail: string): RunStatus => {
  if (logTail.includes('All results saved')) return 'done';
  return 'error';
};

const reconcileRuns = async (status: ScrapeStatusFile): Promise<ScrapeStatusFile> => {
  let mutated = false;
  for (const r of status.runs) {
    if (r.status !== 'running') continue;
    if (isPidAlive(r.pid)) continue;
    // PID is gone. Inspect the log to guess success vs failure.
    const tail = await tailFile(path.join(REPO_ROOT, r.log_path), 50);
    r.status = reconcileFinishedStatus(tail);
    r.ended_at = new Date().toISOString();
    // exit_code unknown after a dev-server restart — leave as null.
    mutated = true;
  }
  if (mutated) await writeStatus(status);
  return status;
};

// --- spawning --------------------------------------------------------

const ensureLogDir = async (): Promise<void> => {
  await fs.mkdir(LOG_DIR, { recursive: true });
};

const spawnScrape = async (mode: ScrapeMode): Promise<ScrapeRun> => {
  await ensureLogDir();
  const id = `${mode}-${Math.floor(Date.now() / 1000)}-${Math.floor(Math.random() * 1000)}`;
  const logRelPath = path.join('scrape_logs', `${id}.log`);
  const logAbsPath = path.join(REPO_ROOT, logRelPath);

  // Open the log file synchronously so we can hand the FD to the child.
  const logFd = openSync(logAbsPath, 'a');
  try {
    const child = spawn('python3', [SEARCH_SCRIPT, `--mode=${mode}`], {
      cwd: REPO_ROOT,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: process.env,
    });
    if (typeof child.pid !== 'number') {
      throw new Error('spawn returned no pid');
    }
    const run: ScrapeRun = {
      id,
      mode,
      pid: child.pid,
      started_at: new Date().toISOString(),
      ended_at: null,
      status: 'running',
      exit_code: null,
      log_path: logRelPath,
    };

    // One-shot exit listener — updates the status file when the child
    // terminates while this dev-server instance is still alive. If the
    // dev server restarts before the child exits, this listener is lost
    // and reconcileRuns() takes over on the next /api/scrape-status hit.
    child.once('exit', (code, signal) => {
      void updateRun(run.id, {
        status: signal === 'SIGTERM' || signal === 'SIGKILL'
          ? 'killed'
          : code === 0
            ? 'done'
            : 'error',
        exit_code: code,
        ended_at: new Date().toISOString(),
      });
    });
    child.once('error', (err) => {
      console.error(`[scrape] ${id} spawn error:`, err);
      void updateRun(run.id, {
        status: 'error',
        ended_at: new Date().toISOString(),
      });
    });
    child.unref();
    return run;
  } finally {
    // The child dup'd the FD; we can close ours.
    closeSync(logFd);
  }
};

// --- ctl shell-out helper --------------------------------------------

interface SchedulerCtlResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError: string | null;
}

// Generic spawn-and-pipe for any of the backend/ctl/*.py scripts. Uses
// spawn (not exec) so args pass verbatim — no shell injection vector even
// though inputs come from a trusted local UI. Optional stdinPayload is
// piped in (and EPIPE swallowed if the child already exited). The hard
// timeout SIGKILLs the child and surfaces a `timedOut` flag.
//
// All five callers (scheduler / onboarding / config-suggest / profile /
// corpus) delegate here; the per-route response shapers downstream still
// own status-code policy (e.g. corpus's 200/400/409/500/504 vs scheduler's
// 200/500/504).
const runCtl = (
  scriptPath: string,
  args: string[],
  stdinPayload: string | null,
  timeoutMs: number,
): Promise<SchedulerCtlResult> =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let spawnError: string | null = null;
    let settled = false;

    const child = spawn('python3', [scriptPath, ...args], {
      cwd: REPO_ROOT,
      env: process.env,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
    }, timeoutMs);

    child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
    child.on('error', (err) => {
      spawnError = (err as Error).message;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr, timedOut, spawnError });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr, timedOut, spawnError });
    });

    if (stdinPayload !== null) {
      child.stdin.on('error', (err) => {
        // Swallow EPIPE — the child may have already exited; close handler
        // surfaces the real error.
        if ((err as NodeJS.ErrnoException).code !== 'EPIPE') {
          console.error(`[${path.basename(scriptPath)}] stdin error:`, err);
        }
      });
      child.stdin.end(stdinPayload);
    } else {
      // No stdin payload: just close the stream so the child sees EOF.
      child.stdin.end();
    }
  });

// Backwards-compat thin wrappers. Existing call sites + response shapers
// reference these by name; keeping them lets the diff stay small and
// preserves the per-script default-timeout knobs.
const runSchedulerCtl = (args: string[]): Promise<SchedulerCtlResult> =>
  runCtl(SCHEDULER_CTL, args, null, SCHEDULER_TIMEOUT_MS);

// Try to parse stdout as JSON. If parsing fails, synthesize an error
// envelope so the client always receives well-formed JSON.
const schedulerResponse = (
  res: ServerResponse,
  args: string[],
  result: SchedulerCtlResult,
) => {
  if (result.spawnError) {
    return sendJson(res, 500, {
      ok: false,
      error: `failed to spawn scheduler_ctl.py: ${result.spawnError}`,
      stderr: result.stderr,
      args,
    });
  }
  if (result.timedOut) {
    return sendJson(res, 504, {
      ok: false,
      error: `scheduler_ctl.py timed out after ${SCHEDULER_TIMEOUT_MS}ms`,
      stdout: result.stdout,
      stderr: result.stderr,
      args,
    });
  }
  let parsed: unknown = null;
  const trimmed = result.stdout.trim();
  if (trimmed) {
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      /* fall through — surface raw stdout below */
    }
  }
  if (result.exitCode !== 0) {
    // Pass through parsed JSON (it likely already has {ok:false,error:...})
    // but always with HTTP 500 so the client treats it as an error.
    if (parsed && typeof parsed === 'object') {
      return sendJson(res, 500, parsed);
    }
    return sendJson(res, 500, {
      ok: false,
      error: `scheduler_ctl.py exited ${result.exitCode}`,
      stdout: result.stdout,
      stderr: result.stderr,
      args,
    });
  }
  if (parsed === null) {
    return sendJson(res, 500, {
      ok: false,
      error: 'scheduler_ctl.py produced no JSON on stdout',
      stdout: result.stdout,
      stderr: result.stderr,
      args,
    });
  }
  return sendJson(res, 200, parsed);
};

// --- onboarding_ctl.py shell-out -------------------------------------

// Delegates to runCtl. Kept as a named wrapper because the response-shaper
// (onboardingResponse) below has different envelope semantics from the
// scheduler one (always-passthrough on JSON).
const runOnboardingCtl = (
  args: string[],
  stdinPayload: string,
  timeoutMs: number,
): Promise<SchedulerCtlResult> =>
  runCtl(ONBOARDING_CTL, args, stdinPayload, timeoutMs);

// Shape an onboarding-ctl result into an HTTP response. Unlike scheduler_ctl
// we ALWAYS try to pass through the JSON envelope (including on non-zero
// exit) because the envelope carries useful fields like `raw` for parse
// failures. Only spawn/timeout go through the synthesized error path.
const onboardingResponse = (
  res: ServerResponse,
  args: string[],
  result: SchedulerCtlResult,
) => {
  if (result.spawnError) {
    return sendJson(res, 500, {
      ok: false,
      error: `failed to spawn onboarding_ctl.py: ${result.spawnError}`,
      stderr: result.stderr,
      args,
    });
  }
  if (result.timedOut) {
    return sendJson(res, 504, {
      ok: false,
      error: `onboarding_ctl.py timed out`,
      stdout: result.stdout,
      stderr: result.stderr,
      args,
    });
  }
  const trimmed = result.stdout.trim();
  let parsed: unknown = null;
  if (trimmed) {
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      /* fall through */
    }
  }
  if (parsed && typeof parsed === 'object') {
    // Surface envelope verbatim. Non-zero exit still gets HTTP 200 so the
    // client can read the body (meta-generation failure is still structured
    // data — the UI shows `raw` to the user).
    return sendJson(res, 200, parsed);
  }
  return sendJson(res, 500, {
    ok: false,
    error: `onboarding_ctl.py produced no JSON on stdout (exit=${result.exitCode})`,
    stdout: result.stdout,
    stderr: result.stderr,
    args,
  });
};

// --- config_suggest_ctl.py shell-out ---------------------------------

// Mirrors runOnboardingCtl exactly — single Claude call, structured JSON
// envelope on stdout, may take up to ~60s. Stdin currently empty; reserved
// for future filters (e.g. "only consider signals from the last 14 days").
const runConfigSuggestCtl = (
  stdinPayload: string,
): Promise<SchedulerCtlResult> =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let spawnError: string | null = null;
    let settled = false;

    const child = spawn('python3', [CONFIG_SUGGEST_CTL], {
      cwd: REPO_ROOT,
      env: process.env,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* already dead */
      }
    }, CONFIG_SUGGEST_TIMEOUT_MS);

    child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
    child.on('error', (err) => {
      spawnError = (err as Error).message;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr, timedOut, spawnError });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr, timedOut, spawnError });
    });

    child.stdin.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code !== 'EPIPE') {
        console.error('[config-suggest] stdin error:', err);
      }
    });
    child.stdin.end(stdinPayload);
  });

// Same envelope-passthrough policy as onboardingResponse: even on non-zero
// exit we surface the parsed JSON so the UI can read `error` / `raw` /
// `signal_count`. Only spawn / timeout failures get synthetic envelopes.
const configSuggestResponse = (
  res: ServerResponse,
  result: SchedulerCtlResult,
) => {
  if (result.spawnError) {
    return sendJson(res, 500, {
      ok: false,
      error: `failed to spawn config_suggest_ctl.py: ${result.spawnError}`,
      stderr: result.stderr,
    });
  }
  if (result.timedOut) {
    return sendJson(res, 504, {
      ok: false,
      error: `config_suggest_ctl.py timed out after ${CONFIG_SUGGEST_TIMEOUT_MS}ms`,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }
  const trimmed = result.stdout.trim();
  let parsed: unknown = null;
  if (trimmed) {
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      /* fall through */
    }
  }
  if (parsed && typeof parsed === 'object') {
    return sendJson(res, 200, parsed);
  }
  return sendJson(res, 500, {
    ok: false,
    error: `config_suggest_ctl.py produced no JSON on stdout (exit=${result.exitCode})`,
    stdout: result.stdout,
    stderr: result.stderr,
  });
};

// --- profile_ctl.py shell-out ----------------------------------------

// Parallel to runSchedulerCtl / runOnboardingCtl. Accepts an optional stdin
// payload so `create` can receive a full config JSON via stdin (no argv
// leakage, no 128KB argv limit to worry about).
const runProfileCtl = (
  args: string[],
  stdinPayload: string | null = null,
): Promise<SchedulerCtlResult> =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let spawnError: string | null = null;
    let settled = false;

    const child = spawn('python3', [PROFILE_CTL, ...args], {
      cwd: REPO_ROOT,
      env: process.env,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* already dead */
      }
    }, PROFILE_TIMEOUT_MS);

    child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
    child.on('error', (err) => {
      spawnError = (err as Error).message;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr, timedOut, spawnError });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr, timedOut, spawnError });
    });

    child.stdin.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code !== 'EPIPE') {
        console.error('[profile] stdin error:', err);
      }
    });
    child.stdin.end(stdinPayload ?? '');
  });

// Identical spawn-and-pipe pattern, just for corpus_ctl.py. Kept separate
// from runProfileCtl because the timeout differs (corpus mutations are
// fast — 8s — while profile creates may run a JSON-validate loop).
//
// Most corpus mutations are sub-second (rate / app-status / delete /
// applied-import). `add-manual` is the outlier — it walks the same
// fetch + Claude scoring pipeline a scrape does and can take 10-90 s.
// Callers that need longer than the default override via `timeoutMs`.
const runCorpusCtl = (
  args: string[],
  stdinPayload: string | null = null,
  timeoutMs: number = CORPUS_TIMEOUT_MS,
): Promise<SchedulerCtlResult> =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let spawnError: string | null = null;
    let settled = false;

    const child = spawn('python3', [CORPUS_CTL, ...args], {
      cwd: REPO_ROOT,
      env: process.env,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
    }, timeoutMs);

    child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
    child.on('error', (err) => {
      spawnError = (err as Error).message;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr, timedOut, spawnError });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr, timedOut, spawnError });
    });

    child.stdin.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code !== 'EPIPE') {
        console.error('[corpus] stdin error:', err);
      }
    });
    child.stdin.end(stdinPayload ?? '');
  });

const corpusResponse = (
  res: ServerResponse,
  args: string[],
  result: SchedulerCtlResult,
) => {
  if (result.spawnError) {
    return sendJson(res, 500, {
      ok: false,
      error: `spawn error: ${result.spawnError}`,
      args,
    });
  }
  if (result.timedOut) {
    return sendJson(res, 504, {
      ok: false,
      error: `corpus_ctl ${args.join(' ')} timed out`,
      stderr: result.stderr.trim().slice(0, 500),
    });
  }
  // Pass through whatever JSON the CLI emitted (success or {ok:false,...}).
  try {
    const parsed = JSON.parse(result.stdout);
    return sendJson(res, result.exitCode === 0 ? 200 : 400, parsed);
  } catch {
    return sendJson(res, 500, {
      ok: false,
      error: 'corpus_ctl emitted non-JSON stdout',
      raw_stdout: result.stdout.trim().slice(0, 500),
      raw_stderr: result.stderr.trim().slice(0, 500),
      exit_code: result.exitCode,
    });
  }
};

// Shape a profile_ctl result into an HTTP response. Pass JSON envelopes
// through verbatim (including on non-zero exit) so the client can read
// structured error fields; only spawn/timeout go through synthesis.
const profileResponse = (
  res: ServerResponse,
  args: string[],
  result: SchedulerCtlResult,
) => {
  if (result.spawnError) {
    return sendJson(res, 500, {
      ok: false,
      error: `failed to spawn profile_ctl.py: ${result.spawnError}`,
      stderr: result.stderr,
      args,
    });
  }
  if (result.timedOut) {
    return sendJson(res, 504, {
      ok: false,
      error: `profile_ctl.py timed out`,
      stdout: result.stdout,
      stderr: result.stderr,
      args,
    });
  }
  const trimmed = result.stdout.trim();
  let parsed: unknown = null;
  if (trimmed) {
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      /* fall through */
    }
  }
  if (parsed && typeof parsed === 'object') {
    // Use HTTP 400 for structured errors so the client treats them as failures,
    // 200 for successes. Let the python script's exit code drive that.
    return sendJson(res, result.exitCode === 0 ? 200 : 400, parsed);
  }
  return sendJson(res, 500, {
    ok: false,
    error: `profile_ctl.py produced no JSON on stdout (exit=${result.exitCode})`,
    stdout: result.stdout,
    stderr: result.stderr,
    args,
  });
};

// --- middleware ------------------------------------------------------

const configApiPlugin = (): Plugin => ({
  name: 'linkedin-jobs-config-api',
  configureServer(server) {
    // Serve root-level JSON files that used to be symlinks in ui/public/.
    // Replaces ui/public/{results,run_history,defaults}.json symlinks so
    // Windows clones (no Developer Mode) don't end up with text stubs.
    const rootJsonFiles: Record<string, string> = {
      '/results.json':     path.join(REPO_ROOT, 'results.json'),
      '/run_history.json': path.join(REPO_ROOT, 'run_history.json'),
      '/defaults.json':    path.join(REPO_ROOT, 'defaults.json'),
    };
    server.middlewares.use(async (req, res, next) => {
      // Strip cache-busting query string (UI fetches use `?t=Date.now()`).
      const pathOnly = (req.url ?? '').split('?')[0];
      const target = rootJsonFiles[pathOnly];
      if (!target) return next();
      try {
        const data = await fs.readFile(target, 'utf8');
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(data);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') { res.statusCode = 404; res.end('{}'); }
        else next(err);
      }
    });

    server.middlewares.use(async (req, res, next) => {
      const url = req.url ?? '';
      try {
        if (url.startsWith('/api/config-info') && req.method === 'GET') {
          if (!existsSync(CONFIG_PATH)) {
            return sendJson(res, 200, { exists: false });
          }
          const stat = await fs.stat(CONFIG_PATH);
          return sendJson(res, 200, {
            exists: true,
            mtimeMs: stat.mtimeMs,
            size: stat.size,
          });
        }

        if (url.startsWith('/api/config') && req.method === 'GET') {
          if (!existsSync(CONFIG_PATH)) {
            return sendJson(res, 404, { error: 'config.json does not exist yet' });
          }
          const text = await fs.readFile(CONFIG_PATH, 'utf8');
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          return res.end(text);
        }

        // Config-suggester runs Claude over the user's feedback signals +
        // the live config. MUST be matched before the bare /api/config POST
        // handler below (which uses startsWith and would swallow this URL).
        // The script enforces the >=5-signal threshold itself; the UI also
        // disables the button below threshold so we rarely hit that error
        // branch, but the server-side check is the source of truth.
        if (url.startsWith('/api/config/suggest') && req.method === 'POST') {
          let stdinPayload = '{}';
          try {
            const raw = await readJsonBody(req);
            const trimmed = raw.trim();
            if (trimmed) {
              JSON.parse(trimmed); // validate
              stdinPayload = trimmed;
            }
          } catch (e) {
            return sendJson(res, 400, {
              ok: false,
              error: `invalid JSON body: ${(e as Error).message}`,
            });
          }
          const result = await runConfigSuggestCtl(stdinPayload);
          return configSuggestResponse(res, result);
        }

        if (url.startsWith('/api/config') && req.method === 'POST') {
          const raw = await readJsonBody(req);
          let parsed: unknown;
          try {
            parsed = JSON.parse(raw);
          } catch (e) {
            return sendJson(res, 400, { error: `invalid JSON: ${(e as Error).message}` });
          }
          // Atomic write: temp file + rename. Same dir → rename is atomic on
          // POSIX. Avoids a partial write if the editor process is killed
          // mid-flush.
          //
          // If config.json is a symlink (multi-profile mode), resolve it so the
          // write lands on the ACTIVE profile instead of clobbering the symlink
          // itself. `fs.realpath` also collapses "configs/foo.json" → absolute.
          let writeTarget = CONFIG_PATH;
          try {
            writeTarget = await fs.realpath(CONFIG_PATH);
          } catch {
            /* config.json missing — write will create it as a regular file */
          }
          const tmp = writeTarget + '.tmp';
          await fs.writeFile(tmp, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
          await fs.rename(tmp, writeTarget);
          const stat = await fs.stat(CONFIG_PATH);
          return sendJson(res, 200, {
            ok: true,
            mtimeMs: stat.mtimeMs,
            size: stat.size,
          });
        }

        // ---- scrape endpoints ------------------------------------------------

        if (url.startsWith('/api/scrape-status') && req.method === 'GET') {
          const status = await reconcileRuns(await readStatus());
          // For each running entry, attach a tail of its log.
          const enriched = await Promise.all(
            status.runs.map(async (r) => {
              if (r.status !== 'running') return r;
              const log_tail = await tailFile(
                path.join(REPO_ROOT, r.log_path),
                200,
              );
              return { ...r, log_tail };
            }),
          );
          return sendJson(res, 200, { runs: enriched });
        }

        if (url.startsWith('/api/scrape-stop') && req.method === 'POST') {
          const raw = await readJsonBody(req);
          let body: { id?: string };
          try {
            body = JSON.parse(raw) as { id?: string };
          } catch {
            return sendJson(res, 400, { error: 'invalid JSON body' });
          }
          if (!body.id) return sendJson(res, 400, { error: 'missing id' });
          const status = await readStatus();
          const run = status.runs.find((r) => r.id === body.id);
          if (!run) return sendJson(res, 404, { error: 'run not found' });
          if (run.status !== 'running') {
            return sendJson(res, 409, { error: `run is not running (status=${run.status})` });
          }
          try {
            process.kill(run.pid, 'SIGTERM');
          } catch (e) {
            // PID already gone — reconcile to killed anyway.
            console.warn(`[scrape] kill ${run.pid} threw:`, (e as Error).message);
          }
          await updateRun(run.id, {
            status: 'killed',
            ended_at: new Date().toISOString(),
          });
          return sendJson(res, 200, { ok: true });
        }

        if (url.startsWith('/api/scrape') && req.method === 'POST') {
          const raw = await readJsonBody(req);
          let body: { mode?: string };
          try {
            body = JSON.parse(raw) as { mode?: string };
          } catch {
            return sendJson(res, 400, { error: 'invalid JSON body' });
          }
          const mode = body.mode;
          if (mode !== 'loggedin' && mode !== 'guest' && mode !== 'both') {
            return sendJson(res, 400, {
              error: 'mode must be one of: loggedin, guest, both',
            });
          }
          // Reconcile first, so a dead "running" entry doesn't block a new run.
          const status = await reconcileRuns(await readStatus());
          const requested: ScrapeMode[] = mode === 'both' ? ['loggedin', 'guest'] : [mode];
          // Refuse if any requested mode is already running.
          for (const m of requested) {
            const busy = status.runs.find((r) => r.mode === m && r.status === 'running');
            if (busy) {
              return sendJson(res, 409, {
                error: `a ${m} run is already in progress`,
                run: busy,
              });
            }
          }
          const spawned: ScrapeRun[] = [];
          for (const m of requested) {
            try {
              spawned.push(await spawnScrape(m));
            } catch (e) {
              return sendJson(res, 500, { error: `failed to spawn ${m}: ${(e as Error).message}` });
            }
          }
          // Append to the status file.
          const next = await readStatus();
          next.runs.push(...spawned);
          await writeStatus(next);
          return sendJson(res, 200, { runs: spawned });
        }

        // ---- scheduler endpoints --------------------------------------------

        if (url.startsWith('/api/scheduler-status') && req.method === 'GET') {
          const args = ['status'];
          const result = await runSchedulerCtl(args);
          return schedulerResponse(res, args, result);
        }

        if (url.startsWith('/api/scheduler/install') && req.method === 'POST') {
          const args = ['install'];
          const result = await runSchedulerCtl(args);
          return schedulerResponse(res, args, result);
        }

        if (url.startsWith('/api/scheduler/uninstall') && req.method === 'POST') {
          const args = ['uninstall'];
          const result = await runSchedulerCtl(args);
          return schedulerResponse(res, args, result);
        }

        if (url.startsWith('/api/scheduler/configure') && req.method === 'POST') {
          const raw = await readJsonBody(req);
          let body: { interval_seconds?: unknown; mode?: unknown };
          try {
            body = JSON.parse(raw) as typeof body;
          } catch {
            return sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
          }
          // Validate inputs before any shell-out.
          let interval: number | null = null;
          if (body.interval_seconds !== undefined && body.interval_seconds !== null) {
            const n = typeof body.interval_seconds === 'number'
              ? body.interval_seconds
              : Number(body.interval_seconds);
            if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
              return sendJson(res, 400, {
                ok: false,
                error: 'interval_seconds must be a positive integer',
              });
            }
            interval = n;
          }
          let mode: 'loggedin' | 'guest' | null = null;
          if (body.mode !== undefined && body.mode !== null) {
            if (body.mode !== 'loggedin' && body.mode !== 'guest') {
              return sendJson(res, 400, {
                ok: false,
                error: 'mode must be "loggedin" or "guest"',
              });
            }
            mode = body.mode;
          }
          if (interval === null && mode === null) {
            return sendJson(res, 400, {
              ok: false,
              error: 'must supply interval_seconds and/or mode',
            });
          }

          // Run the requested setters in sequence; bail on first failure so
          // we surface the actual stderr instead of masking it with a reload
          // attempt.
          if (interval !== null) {
            const args = ['set-interval', String(interval)];
            const r = await runSchedulerCtl(args);
            if (r.spawnError || r.timedOut || r.exitCode !== 0) {
              return schedulerResponse(res, args, r);
            }
          }
          if (mode !== null) {
            const args = ['set-mode', mode];
            const r = await runSchedulerCtl(args);
            if (r.spawnError || r.timedOut || r.exitCode !== 0) {
              return schedulerResponse(res, args, r);
            }
          }
          const reloadArgs = ['reload'];
          const reloadResult = await runSchedulerCtl(reloadArgs);
          return schedulerResponse(res, reloadArgs, reloadResult);
        }

        // ---- preflight + LLM picker + linkedin-session (wizard) -------------
        //
        // Preflight: shells to preflight_ctl.py — checks python/node/playwright/
        // writable dirs. Always returns a parsed JSON envelope, even when the
        // python script itself reports failures (the UI renders the per-check
        // results, not the top-level ok flag).

        if (url.startsWith('/api/preflight/check') && req.method === 'GET') {
          const result = await runCtl(PREFLIGHT_CTL, ['check'], null, PREFLIGHT_TIMEOUT_MS);
          if (result.spawnError) {
            return sendJson(res, 500, {
              ok: false, error: `failed to spawn preflight_ctl.py: ${result.spawnError}`,
            });
          }
          if (result.timedOut) {
            return sendJson(res, 504, { ok: false, error: 'preflight_ctl.py timed out' });
          }
          try {
            return sendJson(res, 200, JSON.parse(result.stdout));
          } catch {
            return sendJson(res, 500, {
              ok: false, error: 'preflight_ctl.py emitted non-JSON',
              raw_stdout: result.stdout.slice(0, 500),
              raw_stderr: result.stderr.slice(0, 500),
            });
          }
        }

        if (url.startsWith('/api/llm/list') && req.method === 'GET') {
          const result = await runCtl(LLM_CTL, ['list'], null, LLM_LIST_TIMEOUT_MS);
          if (result.spawnError) {
            return sendJson(res, 500, { ok: false, error: result.spawnError });
          }
          if (result.timedOut) {
            return sendJson(res, 504, { ok: false, error: 'llm_ctl list timed out' });
          }
          try {
            return sendJson(res, 200, JSON.parse(result.stdout));
          } catch {
            return sendJson(res, 500, {
              ok: false, error: 'llm_ctl emitted non-JSON',
              raw_stderr: result.stderr.slice(0, 500),
            });
          }
        }

        if (url.startsWith('/api/llm/test') && req.method === 'POST') {
          const raw = await readJsonBody(req);
          // Validate the body shape but DON'T log it — the request body for
          // sibling /api/llm/save-credential is sensitive and we want to be
          // consistent across both endpoints.
          let body: { name?: unknown };
          try { body = JSON.parse(raw) as typeof body; }
          catch { return sendJson(res, 400, { ok: false, error: 'invalid JSON body' }); }
          const name = typeof body.name === 'string' && body.name.trim()
            ? body.name.trim() : 'auto';
          const result = await runCtl(
            LLM_CTL, ['test'], JSON.stringify({ name }), LLM_TEST_TIMEOUT_MS,
          );
          if (result.spawnError) {
            return sendJson(res, 500, { ok: false, error: result.spawnError });
          }
          if (result.timedOut) {
            return sendJson(res, 504, { ok: false, error: 'llm_ctl test timed out' });
          }
          try {
            return sendJson(res, 200, JSON.parse(result.stdout));
          } catch {
            return sendJson(res, 500, {
              ok: false, error: 'llm_ctl emitted non-JSON',
              raw_stderr: result.stderr.slice(0, 500),
            });
          }
        }

        if (url.startsWith('/api/llm/save-credential') && req.method === 'POST') {
          const raw = await readJsonBody(req);
          // *** SENSITIVE *** never log raw — it carries the API key. ***
          let body: { name?: unknown; key?: unknown };
          try { body = JSON.parse(raw) as typeof body; }
          catch { return sendJson(res, 400, { ok: false, error: 'invalid JSON body' }); }
          if (typeof body.name !== 'string' || !body.name) {
            return sendJson(res, 400, { ok: false, error: 'name must be a non-empty string' });
          }
          if (typeof body.key !== 'string' || !body.key.trim()) {
            return sendJson(res, 400, { ok: false, error: 'key must be a non-empty string' });
          }
          const result = await runCtl(
            LLM_CTL, ['save-credential'],
            JSON.stringify({ name: body.name, key: body.key }),
            LLM_SAVE_TIMEOUT_MS,
          );
          if (result.spawnError) {
            return sendJson(res, 500, { ok: false, error: result.spawnError });
          }
          if (result.timedOut) {
            return sendJson(res, 504, { ok: false, error: 'llm_ctl save timed out' });
          }
          try {
            const parsed = JSON.parse(result.stdout);
            return sendJson(res, parsed.ok ? 200 : 400, parsed);
          } catch {
            return sendJson(res, 500, {
              ok: false, error: 'llm_ctl emitted non-JSON',
              raw_stderr: result.stderr.slice(0, 500),
            });
          }
        }

        // linkedin_session.json existence — used by Step 3 of the wizard
        // (logged-in mode) to detect whether the user has already run
        // `python3 backend/search.py --mode=loggedin` once to seed the
        // playwright session file. No body / GET only.
        if (url.startsWith('/api/linkedin-session/exists') && req.method === 'GET') {
          if (!existsSync(LINKEDIN_SESSION_PATH)) {
            return sendJson(res, 200, { exists: false, mtime: null });
          }
          try {
            const stat = await fs.stat(LINKEDIN_SESSION_PATH);
            return sendJson(res, 200, { exists: true, mtime: stat.mtime.toISOString() });
          } catch (e) {
            return sendJson(res, 500, { exists: false, error: (e as Error).message });
          }
        }

        // ---- onboarding endpoints -------------------------------------------

        if (url.startsWith('/api/onboarding/generate') && req.method === 'POST') {
          const raw = await readJsonBody(req);
          let body: { cv?: unknown; intent?: unknown };
          try {
            body = JSON.parse(raw) as typeof body;
          } catch {
            return sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
          }
          if (typeof body.cv !== 'string' || typeof body.intent !== 'string') {
            return sendJson(res, 400, {
              ok: false,
              error: 'body must have string fields `cv` and `intent`',
            });
          }
          const payload = JSON.stringify({ cv: body.cv, intent: body.intent });
          const args = ['generate'];
          const result = await runOnboardingCtl(
            args, payload, ONBOARDING_GENERATE_TIMEOUT_MS,
          );
          return onboardingResponse(res, args, result);
        }

        // ---- profile endpoints ----------------------------------------------

        if (url.startsWith('/api/profiles/activate') && req.method === 'POST') {
          const raw = await readJsonBody(req);
          let body: { name?: unknown };
          try { body = JSON.parse(raw) as typeof body; }
          catch { return sendJson(res, 400, { ok: false, error: 'invalid JSON body' }); }
          if (typeof body.name !== 'string' || !body.name) {
            return sendJson(res, 400, { ok: false, error: 'name must be a non-empty string' });
          }
          const args = ['activate', body.name];
          const result = await runProfileCtl(args);
          return profileResponse(res, args, result);
        }

        if (url.startsWith('/api/profiles/create') && req.method === 'POST') {
          const raw = await readJsonBody(req);
          let body: { name?: unknown; from?: unknown; config?: unknown };
          try { body = JSON.parse(raw) as typeof body; }
          catch { return sendJson(res, 400, { ok: false, error: 'invalid JSON body' }); }
          if (typeof body.name !== 'string' || !body.name) {
            return sendJson(res, 400, { ok: false, error: 'name must be a non-empty string' });
          }
          // Three create modes:
          //   1. `from`: duplicate an existing profile into `name`.
          //   2. `config`: seed the new profile with the provided JSON config.
          //   3. neither: create from the currently-active profile (profile_ctl default).
          if (typeof body.from === 'string' && body.from) {
            const args = ['duplicate', body.from, body.name];
            const result = await runProfileCtl(args);
            return profileResponse(res, args, result);
          }
          const stdin = body.config && typeof body.config === 'object'
            ? JSON.stringify(body.config)
            : '';
          const args = ['create', body.name];
          const result = await runProfileCtl(args, stdin || null);
          return profileResponse(res, args, result);
        }

        if (url.startsWith('/api/profiles/rename') && req.method === 'POST') {
          const raw = await readJsonBody(req);
          let body: { old?: unknown; new?: unknown };
          try { body = JSON.parse(raw) as typeof body; }
          catch { return sendJson(res, 400, { ok: false, error: 'invalid JSON body' }); }
          if (typeof body.old !== 'string' || !body.old ||
              typeof body.new !== 'string' || !body.new) {
            return sendJson(res, 400, { ok: false, error: 'old/new must be non-empty strings' });
          }
          const args = ['rename', body.old, body.new];
          const result = await runProfileCtl(args);
          return profileResponse(res, args, result);
        }

        if (url.startsWith('/api/profiles/delete') && req.method === 'POST') {
          const raw = await readJsonBody(req);
          let body: { name?: unknown };
          try { body = JSON.parse(raw) as typeof body; }
          catch { return sendJson(res, 400, { ok: false, error: 'invalid JSON body' }); }
          if (typeof body.name !== 'string' || !body.name) {
            return sendJson(res, 400, { ok: false, error: 'name must be a non-empty string' });
          }
          const args = ['delete', body.name];
          const result = await runProfileCtl(args);
          return profileResponse(res, args, result);
        }

        if (url.startsWith('/api/profiles') && req.method === 'GET') {
          const args = ['list'];
          const result = await runProfileCtl(args);
          return profileResponse(res, args, result);
        }

        // ---- corpus mutations (delete + rate). UI's row-actions popover
        //      hits these. Both pipe a JSON body to corpus_ctl.py over
        //      stdin. Side-effects: writes to results.json (atomic merge)
        //      and (delete only) seen_jobs.json. ------------------------

        if (url.startsWith('/api/corpus/delete') && req.method === 'POST') {
          const raw = await readJsonBody(req);
          let body: { ids?: unknown };
          try { body = JSON.parse(raw) as typeof body; }
          catch { return sendJson(res, 400, { ok: false, error: 'invalid JSON body' }); }
          const ids = body.ids;
          if (
            !Array.isArray(ids) ||
            ids.length === 0 ||
            !ids.every((i) => typeof i === 'string' && i)
          ) {
            return sendJson(res, 400, {
              ok: false, error: 'ids must be a non-empty array of strings',
            });
          }
          const args = ['delete'];
          const result = await runCorpusCtl(args, JSON.stringify({ ids }));
          return corpusResponse(res, args, result);
        }

        if (url.startsWith('/api/corpus/rate') && req.method === 'POST') {
          const raw = await readJsonBody(req);
          let body: { id?: unknown; rating?: unknown; comment?: unknown };
          try { body = JSON.parse(raw) as typeof body; }
          catch { return sendJson(res, 400, { ok: false, error: 'invalid JSON body' }); }
          if (typeof body.id !== 'string' || !body.id) {
            return sendJson(res, 400, {
              ok: false, error: 'id must be a non-empty string',
            });
          }
          if (
            body.rating !== null &&
            !(typeof body.rating === 'number' &&
              Number.isInteger(body.rating) &&
              body.rating >= 1 && body.rating <= 5)
          ) {
            return sendJson(res, 400, {
              ok: false, error: 'rating must be int 1..5 or null',
            });
          }
          // `comment` is optional. Allowed: undefined (don't touch), null, or
          // string up to 2000 chars (server truncates further if needed).
          const hasComment = Object.prototype.hasOwnProperty.call(body, 'comment');
          if (hasComment && body.comment !== null && typeof body.comment !== 'string') {
            return sendJson(res, 400, {
              ok: false, error: 'comment must be string or null',
            });
          }
          if (typeof body.comment === 'string' && body.comment.length > 2000) {
            return sendJson(res, 400, {
              ok: false, error: 'comment must be ≤ 2000 chars',
            });
          }
          const args = ['rate'];
          // Forward `comment` only if the client actually sent the key — that's
          // the "don't touch" sentinel for the Python side.
          const stdinBody: Record<string, unknown> = {
            id: body.id, rating: body.rating,
          };
          if (hasComment) stdinBody.comment = body.comment;
          const result = await runCorpusCtl(args, JSON.stringify(stdinBody));
          return corpusResponse(res, args, result);
        }

        // ---- application tracker (Stage 3-A backend). Per-job pipeline
        //      state stored alongside ratings on the same results.json row.
        //      Same shell-out pattern as /rate. -----------------------------

        if (url.startsWith('/api/corpus/app-status') && req.method === 'POST') {
          const raw = await readJsonBody(req);
          let body: { id?: unknown; status?: unknown; note?: unknown };
          try { body = JSON.parse(raw) as typeof body; }
          catch { return sendJson(res, 400, { ok: false, error: 'invalid JSON body' }); }
          if (typeof body.id !== 'string' || !body.id) {
            return sendJson(res, 400, {
              ok: false, error: 'id must be a non-empty string',
            });
          }
          // Keep this list in lockstep with APP_STATUS_VALUES in
          // backend/ctl/corpus_ctl.py and APP_STATUS_ORDER in src/types.ts.
          const APP_STATUSES = [
            'new', 'applied', 'screening', 'interview',
            'take-home', 'offer', 'rejected', 'withdrew',
          ] as const;
          if (
            typeof body.status !== 'string' ||
            !(APP_STATUSES as readonly string[]).includes(body.status)
          ) {
            return sendJson(res, 400, {
              ok: false,
              error: `status must be one of: ${APP_STATUSES.join(', ')}`,
            });
          }
          // `note` is tri-state on the wire: undefined (key absent) =
          // don't touch app_notes; null = clear; string = set.
          const hasNote = Object.prototype.hasOwnProperty.call(body, 'note');
          if (hasNote && body.note !== null && typeof body.note !== 'string') {
            return sendJson(res, 400, {
              ok: false, error: 'note must be string or null',
            });
          }
          if (typeof body.note === 'string' && body.note.length > 4000) {
            return sendJson(res, 400, {
              ok: false, error: 'note must be ≤ 4000 chars',
            });
          }
          const args = ['app-status'];
          const stdinBody: Record<string, unknown> = {
            id: body.id, status: body.status,
          };
          if (hasNote) stdinBody.note = body.note;
          const result = await runCorpusCtl(args, JSON.stringify(stdinBody));
          return corpusResponse(res, args, result);
        }

        if (url.startsWith('/api/corpus/applied-bulk-import') && req.method === 'POST') {
          const raw = await readJsonBody(req);
          let body: { applied_ids?: unknown };
          try { body = JSON.parse(raw) as typeof body; }
          catch { return sendJson(res, 400, { ok: false, error: 'invalid JSON body' }); }
          const ids = body.applied_ids;
          if (
            !Array.isArray(ids) ||
            !ids.every((i) => typeof i === 'string' && i)
          ) {
            return sendJson(res, 400, {
              ok: false,
              error: 'applied_ids must be an array of non-empty strings',
            });
          }
          if (ids.length > 1000) {
            return sendJson(res, 400, {
              ok: false, error: 'applied_ids may not exceed 1000 entries',
            });
          }
          const args = ['applied-import'];
          const result = await runCorpusCtl(
            args, JSON.stringify({ applied_ids: ids }),
          );
          return corpusResponse(res, args, result);
        }

        // ---- manual-add — paste a LinkedIn URL or bare 8-12 digit job id
        //      to ingest a single job through the SAME pipeline a scraped
        //      row gets (title-filter -> guest description fetch -> Claude
        //      scoring with regex fallback -> atomic merge). The persisted
        //      row carries `source: "manual"` + `manual_added_at` so the
        //      filter sidebar + few-shot loop can distinguish them.
        //
        //      Status mapping is custom (NOT corpusResponse) because the
        //      duplicate case is a real conflict, not a generic 400:
        //         exit 0                                  -> 200 OK
        //         exit 1 + error="already in corpus"      -> 409 Conflict
        //         exit 1 + other validation/fetch failure -> 400 Bad Request
        //         spawn error / timeout                   -> 500 / 504
        //
        //      Timeout is 3 minutes (matches ONBOARDING_GENERATE_TIMEOUT_MS)
        //      because Claude scoring + LinkedIn HTTP can take 30-90 s on
        //      slower runs. ----------------------------------------------
        if (url.startsWith('/api/corpus/add-manual') && req.method === 'POST') {
          const raw = await readJsonBody(req);
          let body: { url_or_id?: unknown };
          try { body = JSON.parse(raw) as typeof body; }
          catch { return sendJson(res, 400, { ok: false, error: 'invalid JSON body' }); }
          if (typeof body.url_or_id !== 'string' || !body.url_or_id.trim()) {
            return sendJson(res, 400, {
              ok: false, error: 'url_or_id must be a non-empty string',
            });
          }
          if (body.url_or_id.length > 500) {
            return sendJson(res, 400, {
              ok: false, error: 'url_or_id must be ≤ 500 chars',
            });
          }
          const args = ['add-manual'];
          const result = await runCorpusCtl(
            args,
            JSON.stringify({ url_or_id: body.url_or_id }),
            ONBOARDING_GENERATE_TIMEOUT_MS,
          );
          if (result.spawnError) {
            return sendJson(res, 500, {
              ok: false,
              error: `spawn error: ${result.spawnError}`,
              args,
            });
          }
          if (result.timedOut) {
            return sendJson(res, 504, {
              ok: false,
              error: 'add-manual timed out — LinkedIn fetch + Claude scoring took longer than 3 minutes',
              stderr: result.stderr.trim().slice(0, 500),
            });
          }
          let parsed: { ok?: boolean; error?: string } & Record<string, unknown>;
          try {
            parsed = JSON.parse(result.stdout);
          } catch {
            return sendJson(res, 500, {
              ok: false,
              error: 'corpus_ctl emitted non-JSON stdout',
              raw_stdout: result.stdout.trim().slice(0, 500),
              raw_stderr: result.stderr.trim().slice(0, 500),
              exit_code: result.exitCode,
            });
          }
          if (parsed.ok === true) return sendJson(res, 200, parsed);
          if (parsed.error === 'already in corpus') {
            return sendJson(res, 409, parsed);
          }
          return sendJson(res, 400, parsed);
        }

        // ---- corpus push-to-end (POST) -----------------------------------
        // Set / clear `pushed_to_end` on a list of corpus rows. Used by
        // the Corpus tab's per-row + bulk "Move to end" action — promoted
        // from local-only state to a persisted field so the demote
        // survives reloads and syncs across devices.
        if (url.startsWith('/api/corpus/push-to-end') && req.method === 'POST') {
          const raw = await readJsonBody(req);
          let body: { ids?: unknown; pushed?: unknown };
          try { body = JSON.parse(raw) as typeof body; }
          catch { return sendJson(res, 400, { ok: false, error: 'invalid JSON body' }); }
          if (!Array.isArray(body.ids) || body.ids.length === 0) {
            return sendJson(res, 400, {
              ok: false, error: 'ids must be a non-empty array',
            });
          }
          if (typeof body.pushed !== 'boolean') {
            return sendJson(res, 400, {
              ok: false, error: 'pushed must be a boolean',
            });
          }
          const args = ['push-to-end'];
          const result = await runCorpusCtl(
            args, JSON.stringify({ ids: body.ids, pushed: body.pushed }),
          );
          if (result.spawnError) {
            return sendJson(res, 500, {
              ok: false, error: `spawn error: ${result.spawnError}`, args,
            });
          }
          if (result.timedOut) {
            return sendJson(res, 504, {
              ok: false, error: 'push-to-end timed out',
            });
          }
          let parsed: { ok?: boolean; error?: string } & Record<string, unknown>;
          try { parsed = JSON.parse(result.stdout); }
          catch {
            return sendJson(res, 500, {
              ok: false, error: 'corpus_ctl emitted non-JSON stdout',
              raw_stdout: result.stdout.trim().slice(0, 500),
              raw_stderr: result.stderr.trim().slice(0, 500),
              exit_code: result.exitCode,
            });
          }
          return sendJson(res, parsed.ok ? 200 : 400, parsed);
        }

        // ---- corpus rescore (POST) ---------------------------------------
        // Re-run scoring on a list of existing corpus job ids. Used by the
        // Corpus tab's bulk "Re-score" button. Each id walks the same per-
        // job pipeline a scraped row does (description fetch + Claude scoring
        // with regex fallback). Timeout is generous since N can be 20-30
        // and each Claude call is ~30s in the worst case.
        if (url.startsWith('/api/corpus/rescore') && req.method === 'POST') {
          const raw = await readJsonBody(req);
          let body: { ids?: unknown };
          try { body = JSON.parse(raw) as typeof body; }
          catch { return sendJson(res, 400, { ok: false, error: 'invalid JSON body' }); }
          if (!Array.isArray(body.ids) || body.ids.length === 0) {
            return sendJson(res, 400, {
              ok: false, error: 'ids must be a non-empty array',
            });
          }
          if (body.ids.length > 100) {
            return sendJson(res, 400, {
              ok: false, error: 'rescore is capped at 100 ids per request',
            });
          }
          const args = ['rescore'];
          // 10-minute ceiling — 100 jobs × ~6s typical = 10min worst case.
          const result = await runCorpusCtl(
            args,
            JSON.stringify({ ids: body.ids }),
            10 * 60 * 1000,
          );
          if (result.spawnError) {
            return sendJson(res, 500, {
              ok: false, error: `spawn error: ${result.spawnError}`, args,
            });
          }
          if (result.timedOut) {
            return sendJson(res, 504, {
              ok: false,
              error: 'rescore timed out — too many ids or Claude is slow',
              stderr: result.stderr.trim().slice(0, 500),
            });
          }
          let parsed: { ok?: boolean; error?: string } & Record<string, unknown>;
          try { parsed = JSON.parse(result.stdout); }
          catch {
            return sendJson(res, 500, {
              ok: false,
              error: 'corpus_ctl emitted non-JSON stdout',
              raw_stdout: result.stdout.trim().slice(0, 500),
              raw_stderr: result.stderr.trim().slice(0, 500),
              exit_code: result.exitCode,
            });
          }
          return sendJson(res, parsed.ok ? 200 : 400, parsed);
        }

        // ---- cv save (used by the onboarding flow instead of the old
        //      combined /api/onboarding/save, which clobbers the config
        //      symlink). Tiny endpoint: just writes cv.txt atomically. ------

        if (url.startsWith('/api/cv/save') && req.method === 'POST') {
          const raw = await readJsonBody(req);
          let body: { cv?: unknown };
          try { body = JSON.parse(raw) as typeof body; }
          catch { return sendJson(res, 400, { ok: false, error: 'invalid JSON body' }); }
          if (typeof body.cv !== 'string' || !body.cv.trim()) {
            return sendJson(res, 400, { ok: false, error: 'cv must be a non-empty string' });
          }
          const tmp = CV_PATH + '.tmp';
          await fs.writeFile(tmp, body.cv, 'utf8');
          await fs.rename(tmp, CV_PATH);
          return sendJson(res, 200, { ok: true, cv_path: CV_PATH });
        }

        // Save the generated config as a NEW named profile (and activate it)
        // instead of overwriting the active one. URL match must precede the
        // looser /api/onboarding/save check below since both share a prefix.
        if (url.startsWith('/api/onboarding/save-as-profile') && req.method === 'POST') {
          const raw = await readJsonBody(req);
          let body: {
            cv?: unknown; config?: unknown;
            profile_name?: unknown; overwrite?: unknown;
          };
          try {
            body = JSON.parse(raw) as typeof body;
          } catch {
            return sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
          }
          if (typeof body.cv !== 'string' || !body.cv.trim()) {
            return sendJson(res, 400, { ok: false, error: 'cv must be a non-empty string' });
          }
          if (!body.config || typeof body.config !== 'object') {
            return sendJson(res, 400, { ok: false, error: 'config must be an object' });
          }
          if (typeof body.profile_name !== 'string' || !body.profile_name) {
            return sendJson(res, 400, {
              ok: false, error: 'profile_name must be a non-empty string',
            });
          }
          const payload = JSON.stringify({
            cv: body.cv,
            config: body.config,
            profile_name: body.profile_name,
            overwrite: Boolean(body.overwrite),
          });
          const args = ['save-as-profile'];
          const result = await runOnboardingCtl(
            args, payload, ONBOARDING_SAVE_TIMEOUT_MS,
          );
          return onboardingResponse(res, args, result);
        }

        if (url.startsWith('/api/onboarding/save') && req.method === 'POST') {
          const raw = await readJsonBody(req);
          let body: { cv?: unknown; config?: unknown };
          try {
            body = JSON.parse(raw) as typeof body;
          } catch {
            return sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
          }
          if (typeof body.cv !== 'string' || !body.cv.trim()) {
            return sendJson(res, 400, { ok: false, error: 'cv must be a non-empty string' });
          }
          if (!body.config || typeof body.config !== 'object') {
            return sendJson(res, 400, { ok: false, error: 'config must be an object' });
          }
          const payload = JSON.stringify({ cv: body.cv, config: body.config });
          const args = ['save'];
          const result = await runOnboardingCtl(
            args, payload, ONBOARDING_SAVE_TIMEOUT_MS,
          );
          return onboardingResponse(res, args, result);
        }
      } catch (e) {
        return sendJson(res, 500, { error: (e as Error).message });
      }
      next();
    });
  },
});

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), configApiPlugin()],
});
