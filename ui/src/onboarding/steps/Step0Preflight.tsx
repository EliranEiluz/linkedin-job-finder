import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import { Banner } from '../components';
import type { PreflightCheck, PreflightResponse } from '../types';

export const Step0Preflight = ({ onAdvance }: { onAdvance: () => void }) => {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'ok'; checks: PreflightCheck[] }
    | { kind: 'fail'; checks: PreflightCheck[] }
    | { kind: 'error'; error: string }
  >({ kind: 'loading' });

  const check = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const res = await fetch('/api/preflight/check');
      const body = (await res.json()) as PreflightResponse;
      const checks = body.checks ?? [];
      if (body.ok && checks.every((c) => c.ok)) {
        setState({ kind: 'ok', checks });
      } else {
        setState({ kind: 'fail', checks });
      }
    } catch (e) {
      setState({ kind: 'error', error: (e as Error).message });
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  // Auto-advance on success after a brief flash.
  useEffect(() => {
    if (state.kind === 'ok') {
      const t = setTimeout(onAdvance, 600);
      return () => { clearTimeout(t); };
    }
    return;
  }, [state, onAdvance]);

  return (
    <div>
      <h2 className="mb-2 text-base font-semibold text-slate-800">Pre-flight check</h2>
      <p className="mb-4 text-sm text-slate-600">
        Verifying your machine has the runtimes the scraper needs (Python,
        Node, Playwright Chromium, writable config dir).
      </p>
      {state.kind === 'loading' && (
        <Banner kind="info">
          <span className="inline-flex items-center gap-2">
            <span className="h-2 w-2 animate-pulse rounded-full bg-indigo-500" />
            Checking…
          </span>
        </Banner>
      )}
      {state.kind === 'ok' && (
        <Banner kind="ok">✓ Pre-flight passed — continuing…</Banner>
      )}
      {state.kind === 'error' && (
        <>
          <Banner kind="err">Pre-flight request failed: {state.error}</Banner>
          <button
            type="button"
            onClick={check}
            className="rounded bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700"
          >
            Re-check
          </button>
        </>
      )}
      {state.kind === 'fail' && (
        <>
          <Banner kind="err">Some checks failed — fix the items below and re-check.</Banner>
          <ul className="mb-4 space-y-3">
            {state.checks.map((c) => (
              <li key={c.name} className="rounded border border-slate-200 bg-white p-3">
                <div className="flex items-center gap-2">
                  <span
                    className={clsx(
                      'inline-flex h-5 w-5 items-center justify-center rounded-full text-xs font-bold',
                      c.ok ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700',
                    )}
                  >
                    {c.ok ? '✓' : '✗'}
                  </span>
                  <span className="font-medium text-slate-800">{c.name}</span>
                  {c.value && (
                    <code className="ml-2 truncate rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700">
                      {c.value}
                    </code>
                  )}
                </div>
                {!c.ok && c.fix && (
                  <pre className="mt-2 overflow-x-auto rounded bg-slate-900 p-2 text-xs text-slate-100">
                    <code>{c.fix}</code>
                  </pre>
                )}
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={check}
            className="rounded bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700"
          >
            Re-check
          </button>
        </>
      )}
    </div>
  );
};
