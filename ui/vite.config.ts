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
const PROFILE_CTL = path.join(BACKEND_DIR, 'ctl', 'profile_ctl.py');
const CORPUS_CTL = path.join(BACKEND_DIR, 'ctl', 'corpus_ctl.py');
const CORPUS_TIMEOUT_MS = 8_000;
const PROFILE_TIMEOUT_MS = 10_000;

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

// --- scheduler_ctl.py shell-out --------------------------------------

interface SchedulerCtlResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError: string | null;
}

// Shell out to scheduler_ctl.py with a hard timeout. Uses spawn (not exec)
// so the args list is passed verbatim — no shell injection vector even
// though the inputs come from a trusted local UI.
const runSchedulerCtl = (args: string[]): Promise<SchedulerCtlResult> =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let spawnError: string | null = null;
    let settled = false;

    const child = spawn('python3', [SCHEDULER_CTL, ...args], {
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
    }, SCHEDULER_TIMEOUT_MS);

    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
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
  });

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

// Parallel to runSchedulerCtl, but with a configurable timeout and optional
// stdin payload. Kept separate rather than generalized to preserve the
// scheduler path's exact behavior (and its short timeout).
const runOnboardingCtl = (
  args: string[],
  stdinPayload: string,
  timeoutMs: number,
): Promise<SchedulerCtlResult> =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let spawnError: string | null = null;
    let settled = false;

    const child = spawn('python3', [ONBOARDING_CTL, ...args], {
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
    }, timeoutMs);

    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
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

    // Feed the body JSON on stdin so secrets (CV text) never hit argv.
    child.stdin.on('error', (err) => {
      // Swallow EPIPE — the child may have already exited; close handler
      // will surface the real error.
      if ((err as NodeJS.ErrnoException).code !== 'EPIPE') {
        console.error('[onboarding] stdin error:', err);
      }
    });
    child.stdin.end(stdinPayload);
  });

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
const runCorpusCtl = (
  args: string[],
  stdinPayload: string | null = null,
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
    }, CORPUS_TIMEOUT_MS);

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
          let body: { id?: unknown; rating?: unknown };
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
          const args = ['rate'];
          const result = await runCorpusCtl(
            args, JSON.stringify({ id: body.id, rating: body.rating }),
          );
          return corpusResponse(res, args, result);
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
