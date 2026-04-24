import { useCallback, useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { formatDistanceToNowStrict, parseISO } from 'date-fns';
import type { RunHistoryFile, RunRecord } from './runHistoryTypes';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; runs: RunRecord[]; loadedAt: Date }
  | { kind: 'error'; message: string };

const URL = `${import.meta.env.BASE_URL}run_history.json`;

const fetchHistory = async (): Promise<LoadState> => {
  try {
    const res = await fetch(`${URL}?t=${Date.now()}`);
    if (!res.ok) {
      return {
        kind: 'error',
        message: `Fetch failed: HTTP ${res.status} for ${URL}. Is the symlink in ui/public/ set up?`,
      };
    }
    const text = await res.text();
    if (!text.trim()) {
      return { kind: 'ready', runs: [], loadedAt: new Date() };
    }
    const data = JSON.parse(text) as RunHistoryFile;
    const runs = Array.isArray(data?.runs) ? data.runs : [];
    return { kind: 'ready', runs, loadedAt: new Date() };
  } catch (e) {
    return { kind: 'error', message: (e as Error).message };
  }
};

const safeParseISO = (s: string): Date | null => {
  try {
    return parseISO(s);
  } catch {
    return null;
  }
};

const fmtDuration = (sec: number): string => {
  if (sec < 60) return `${sec.toFixed(0)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec - m * 60);
  return `${m}m ${s}s`;
};

const FitChip = ({
  label,
  count,
  total,
  color,
}: {
  label: string;
  count: number;
  total: number;
  color: string;
}) => {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <span
      className={clsx(
        'inline-flex items-baseline gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
        color,
      )}
      title={`${count} of ${total} (${pct}%)`}
    >
      <span className="font-semibold tabular-nums">{count}</span>
      <span className="opacity-75">{label}</span>
    </span>
  );
};

// Simple CSS bar — no chart library needed for a 30-row sparkline.
const NewJobsSparkline = ({ runs }: { runs: RunRecord[] }) => {
  // Last 30 chronologically (oldest left → newest right).
  const slice = runs.slice(-30);
  const max = Math.max(1, ...slice.map((r) => r.totals.new_jobs));
  return (
    <div>
      <div className="mb-1.5 text-xs font-semibold text-slate-600">
        New jobs per run (last {slice.length})
      </div>
      <div className="flex h-20 items-end gap-0.5 rounded border border-slate-200 bg-white p-2">
        {slice.length === 0 && (
          <div className="flex-1 self-center text-center text-xs text-slate-400">
            No runs yet.
          </div>
        )}
        {slice.map((r, i) => {
          const h = (r.totals.new_jobs / max) * 100;
          return (
            <div
              key={i}
              className="flex-1 rounded-sm bg-brand-500/80 hover:bg-brand-700"
              style={{ height: `${Math.max(2, h)}%` }}
              title={`${r.started_at}: ${r.totals.new_jobs} new`}
            />
          );
        })}
      </div>
    </div>
  );
};

// Stacked bar of fit distribution per run (last 30).
const FitStack = ({ runs }: { runs: RunRecord[] }) => {
  const slice = runs.slice(-30);
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-xs font-semibold text-slate-600">
          Fit distribution per run (last {slice.length})
        </span>
        <span className="flex items-center gap-2 text-[10px]">
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm bg-emerald-500" /> good
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm bg-amber-400" /> ok
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm bg-slate-400" /> skip
          </span>
        </span>
      </div>
      <div className="flex h-20 items-end gap-0.5 rounded border border-slate-200 bg-white p-2">
        {slice.length === 0 && (
          <div className="flex-1 self-center text-center text-xs text-slate-400">
            No runs yet.
          </div>
        )}
        {slice.map((r, i) => {
          const total =
            r.fit_distribution.good +
            r.fit_distribution.ok +
            r.fit_distribution.skip;
          const total_for_h = Math.max(1, total);
          const goodPct = (r.fit_distribution.good / total_for_h) * 100;
          const okPct = (r.fit_distribution.ok / total_for_h) * 100;
          const skipPct = (r.fit_distribution.skip / total_for_h) * 100;
          // Heuristic: bar height scales with raw count up to a soft cap.
          const max = Math.max(
            1,
            ...slice.map(
              (rr) =>
                rr.fit_distribution.good +
                rr.fit_distribution.ok +
                rr.fit_distribution.skip,
            ),
          );
          const h = (total / max) * 100;
          return (
            <div
              key={i}
              className="relative flex w-full flex-1 flex-col-reverse"
              style={{ height: `${Math.max(2, h)}%` }}
              title={`good=${r.fit_distribution.good} ok=${r.fit_distribution.ok} skip=${r.fit_distribution.skip}`}
            >
              <div className="bg-slate-400" style={{ height: `${skipPct}%` }} />
              <div className="bg-amber-400" style={{ height: `${okPct}%` }} />
              <div className="bg-emerald-500" style={{ height: `${goodPct}%` }} />
            </div>
          );
        })}
      </div>
    </div>
  );
};

const RunRow = ({ run }: { run: RunRecord }) => {
  const [open, setOpen] = useState(false);
  const startedDate = safeParseISO(run.started_at);
  const total = run.totals.new_jobs;

  return (
    <div className="border-b border-slate-200 bg-white">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-4 px-4 py-2.5 text-left hover:bg-slate-50"
      >
        <span className="text-xs text-slate-400">{open ? '▼' : '▶'}</span>
        <span className="w-44 shrink-0 text-sm tabular-nums text-slate-700">
          {startedDate ? startedDate.toLocaleString() : run.started_at}
        </span>
        <span className="w-20 shrink-0 text-xs tabular-nums text-slate-500">
          {fmtDuration(run.duration_sec)}
        </span>
        <span className="w-24 shrink-0 text-sm tabular-nums">
          <span className="font-semibold text-slate-900">{total}</span>
          <span className="ml-1 text-xs text-slate-500">new</span>
        </span>
        <span className="flex flex-1 flex-wrap gap-1">
          <FitChip
            label="good"
            count={run.fit_distribution.good}
            total={total}
            color="bg-emerald-100 text-emerald-800"
          />
          <FitChip
            label="ok"
            count={run.fit_distribution.ok}
            total={total}
            color="bg-amber-100 text-amber-800"
          />
          <FitChip
            label="skip"
            count={run.fit_distribution.skip}
            total={total}
            color="bg-slate-200 text-slate-700"
          />
          {run.fit_distribution.unscored > 0 && (
            <FitChip
              label="unscored"
              count={run.fit_distribution.unscored}
              total={total}
              color="bg-slate-100 text-slate-500"
            />
          )}
          {run.errors.length > 0 && (
            <span
              className="inline-flex items-baseline gap-1 rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-medium text-red-700"
              title={run.errors.map((e) => `${e.query}: ${e.error}`).join('\n')}
            >
              <span className="font-semibold tabular-nums">{run.errors.length}</span>
              <span className="opacity-75">err</span>
            </span>
          )}
        </span>
      </button>

      {open && (
        <div className="border-t border-slate-100 bg-slate-50 px-6 py-3">
          {/* Per-query table */}
          <div className="mb-4">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-600">
              Per-query stats
            </h3>
            <div className="overflow-x-auto rounded border border-slate-200">
              <table className="w-full text-xs">
                <thead className="bg-slate-100 text-slate-600">
                  <tr>
                    <th className="px-2 py-1.5 text-left font-semibold">Query</th>
                    <th className="px-2 py-1.5 text-left font-semibold">Cat</th>
                    <th className="px-2 py-1.5 text-right font-semibold">Real</th>
                    <th className="px-2 py-1.5 text-right font-semibold">JYMBII</th>
                    <th className="px-2 py-1.5 text-right font-semibold">Unk</th>
                    <th className="px-2 py-1.5 text-center font-semibold">Banner</th>
                    <th className="px-2 py-1.5 text-right font-semibold">New</th>
                  </tr>
                </thead>
                <tbody className="bg-white">
                  {run.queries.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-2 py-3 text-center text-slate-400">
                        No per-query stats recorded.
                      </td>
                    </tr>
                  )}
                  {run.queries.map((q, i) => (
                    <tr key={i} className="border-t border-slate-100">
                      <td className="px-2 py-1 font-medium text-slate-900">{q.query}</td>
                      <td className="px-2 py-1 text-slate-600">{q.category}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{q.real}</td>
                      <td className="px-2 py-1 text-right tabular-nums text-slate-500">
                        {q.jymbii}
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums text-slate-500">
                        {q.unknown}
                      </td>
                      <td className="px-2 py-1 text-center">
                        {q.banner ? (
                          <span className="text-amber-600">Y</span>
                        ) : (
                          <span className="text-slate-300">·</span>
                        )}
                      </td>
                      <td className="px-2 py-1 text-right font-semibold tabular-nums text-emerald-700">
                        {q.jobs_kept_after_dedup}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Scoring + arg detail */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-600">
                Scoring & enrichment
              </h3>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-700">
                <dt className="text-slate-500">Scored by Claude</dt>
                <dd className="tabular-nums">{run.totals.scored_claude}</dd>
                <dt className="text-slate-500">Scored by regex</dt>
                <dd className="tabular-nums">{run.totals.scored_regex}</dd>
                <dt className="text-slate-500">Title-filtered</dt>
                <dd className="tabular-nums">{run.totals.title_filtered}</dd>
                <dt className="text-slate-500">Descriptions fetched</dt>
                <dd className="tabular-nums">{run.totals.descriptions_fetched}</dd>
                <dt className="text-slate-500">Descriptions failed</dt>
                <dd className="tabular-nums">{run.totals.descriptions_failed}</dd>
              </dl>
            </div>
            <div>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-600">
                Run args
              </h3>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-700">
                <dt className="text-slate-500">--all</dt>
                <dd>{run.args.all ? 'yes' : 'no'}</dd>
                <dt className="text-slate-500">--no-enrich</dt>
                <dd>{run.args.no_enrich ? 'yes' : 'no'}</dd>
                <dt className="text-slate-500">--all-time</dt>
                <dd>{run.args.all_time ? 'yes' : 'no'}</dd>
                <dt className="text-slate-500">--pages</dt>
                <dd>{run.args.pages ?? '(default)'}</dd>
                <dt className="text-slate-500">max pages used</dt>
                <dd className="tabular-nums">{run.args.max_pages_used}</dd>
              </dl>
            </div>
          </div>

          {run.errors.length > 0 && (
            <div className="mt-4">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-red-700">
                Errors ({run.errors.length})
              </h3>
              <ul className="space-y-1 text-xs">
                {run.errors.map((e, i) => (
                  <li key={i} className="rounded border border-red-100 bg-red-50 px-2 py-1">
                    <span className="font-mono text-red-700">{e.query}</span>:{' '}
                    <span className="text-slate-700">{e.error}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export const RunHistoryPage = () => {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  const reload = useCallback(async () => {
    setState({ kind: 'loading' });
    setState(await fetchHistory());
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Re-fetch when a scraper run finishes (signal posted by ScrapeRunPanel).
  useEffect(() => {
    const onStale = () => {
      void reload();
    };
    window.addEventListener('linkedinjobs:corpus-stale', onStale);
    return () => window.removeEventListener('linkedinjobs:corpus-stale', onStale);
  }, [reload]);

  const summary = useMemo(() => {
    if (state.kind !== 'ready') return null;
    const runs = state.runs;
    const total_runs = runs.length;
    const total_new = runs.reduce((s, r) => s + r.totals.new_jobs, 0);
    const successful = runs.filter((r) => r.totals.new_jobs > 0).length;
    const success_rate = total_runs > 0 ? Math.round((successful / total_runs) * 100) : 0;
    const last = runs[runs.length - 1];
    const lastDate = last ? safeParseISO(last.started_at) : null;
    const lastAgo = lastDate
      ? formatDistanceToNowStrict(lastDate, { addSuffix: true })
      : '—';
    return { total_runs, total_new, success_rate, lastAgo };
  }, [state]);

  if (state.kind === 'loading') {
    // Skeleton: 4 stat cards + 2 chart blocks + 4 timeline rows. Uses
    // `animate-pulse` to telegraph "loading, not broken" without text.
    return (
      <div className="flex-1 overflow-hidden bg-slate-50 px-4 py-4">
        <div className="mx-auto flex max-w-5xl animate-pulse flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-20 rounded-lg border border-slate-200 bg-white p-3">
                <div className="mb-2 h-3 w-16 rounded bg-slate-200" />
                <div className="h-6 w-12 rounded bg-slate-200" />
              </div>
            ))}
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="h-24 rounded border border-slate-200 bg-white p-2" />
            <div className="h-24 rounded border border-slate-200 bg-white p-2" />
          </div>
          <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex gap-4 border-b border-slate-100 px-4 py-3">
                <div className="h-3 w-44 rounded bg-slate-200" />
                <div className="h-3 w-16 rounded bg-slate-200" />
                <div className="h-3 w-24 rounded bg-slate-200" />
                <div className="h-3 flex-1 rounded bg-slate-200" />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 py-20 text-center">
        <div className="mb-6 text-6xl">⚠️</div>
        <p className="mb-5 max-w-lg text-sm text-slate-600">{state.message}</p>
        <div className="rounded border border-slate-300 bg-white p-4 text-left text-xs">
          <p className="mb-2 font-semibold text-slate-700">Likely fix:</p>
          <code className="block whitespace-pre-wrap rounded bg-slate-900 p-3 font-mono text-emerald-300">
            cd {'<repo root>'}/ui/public{'\n'}
            ln -sf ../../run_history.json run_history.json
          </code>
        </div>
      </div>
    );
  }

  // Newest first for the timeline.
  const runsDesc = [...state.runs].reverse();

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2">
        <div className="text-xs text-slate-500">
          loaded {state.loadedAt.toLocaleTimeString()}
        </div>
        <button
          type="button"
          onClick={() => void reload()}
          className="rounded border border-slate-300 bg-white px-3 py-1 text-xs text-slate-700 hover:bg-brand-50 hover:text-brand-700"
        >
          ↻ Reload
        </button>
      </div>

      <div className="flex-1 overflow-y-auto bg-slate-50 px-4 py-4">
        <div className="mx-auto flex max-w-5xl flex-col gap-4">
          {/* At-a-glance */}
          <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <div className="rounded-lg border border-slate-200 bg-white p-3">
              <div className="text-[11px] uppercase tracking-wider text-slate-500">
                Total runs
              </div>
              <div className="text-2xl font-semibold tabular-nums text-slate-900">
                {summary?.total_runs ?? 0}
              </div>
            </div>
            <div className="rounded-lg border border-slate-200 bg-white p-3">
              <div className="text-[11px] uppercase tracking-wider text-slate-500">
                Last run
              </div>
              <div className="text-base font-semibold text-slate-900">
                {summary?.lastAgo ?? '—'}
              </div>
            </div>
            <div className="rounded-lg border border-slate-200 bg-white p-3">
              <div className="text-[11px] uppercase tracking-wider text-slate-500">
                Total new jobs
              </div>
              <div className="text-2xl font-semibold tabular-nums text-brand-700">
                {summary?.total_new ?? 0}
              </div>
            </div>
            <div className="rounded-lg border border-slate-200 bg-white p-3">
              <div className="text-[11px] uppercase tracking-wider text-slate-500">
                Success rate
              </div>
              <div className="text-2xl font-semibold tabular-nums text-emerald-700">
                {summary?.success_rate ?? 0}%
              </div>
              <div className="text-[10px] text-slate-400">runs with &gt;0 new jobs</div>
            </div>
          </section>

          {/* Charts */}
          <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <NewJobsSparkline runs={state.runs} />
            <FitStack runs={state.runs} />
          </section>

          {/* Timeline */}
          <section>
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wider text-slate-600">
              Timeline ({runsDesc.length})
            </h2>
            {runsDesc.length === 0 ? (
              <div className="rounded-lg border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
                No runs recorded yet. Run{' '}
                <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs">
                  python3 search.py
                </code>{' '}
                to populate this.
              </div>
            ) : (
              <div className="overflow-hidden rounded-lg border border-slate-200">
                {runsDesc.map((r, i) => (
                  <RunRow key={`${r.started_at}-${i}`} run={r} />
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
};
