// Generic spawn-and-pipe wrapper for the backend/ctl/*.py scripts.
//
// Uses spawn (not exec) so args pass verbatim — no shell injection vector
// even though inputs come from a trusted local UI. Optional stdinPayload
// is piped in (and EPIPE is swallowed if the child already exited). The
// hard timeout SIGKILLs the child and surfaces a `timedOut` flag.
//
// The per-route response shapers downstream (`*Response()` helpers in the
// endpoint handler files) own status-code policy — corpus uses
// 200/400/409/500/504, scheduler uses 200/500/504, etc. This file just
// runs the subprocess and returns the result envelope.

import path from 'node:path';
import { spawn } from 'node:child_process';
import { REPO_ROOT } from './paths';

export interface CtlResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError: string | null;
}

export const runCtl = (
  scriptPath: string,
  args: string[],
  stdinPayload: string | null,
  timeoutMs: number,
): Promise<CtlResult> =>
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
      spawnError = err.message;
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
        // Swallow EPIPE — the child may have already exited; the close
        // handler surfaces the real error.
        if ((err as NodeJS.ErrnoException).code !== 'EPIPE') {
          // eslint-disable-next-line no-console
          console.error(`[${path.basename(scriptPath)}] stdin error:`, err);
        }
      });
      child.stdin.end(stdinPayload);
    } else {
      // No stdin payload: just close the stream so the child sees EOF.
      child.stdin.end();
    }
  });
