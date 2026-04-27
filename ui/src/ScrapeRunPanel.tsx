import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { formatDistanceToNowStrict, parseISO } from 'date-fns';
import { Dot, type DotColor } from './Dot';

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
  log_path: string;
  log_tail?: string;
}

interface StatusResponse {
  runs: ScrapeRun[];
}

const STATUS_URL = '/api/scrape-status';
const SCRAPE_URL = '/api/scrape';
const STOP_URL = '/api/scrape-stop';
const RUN_HISTORY_URL = `${import.meta.env.BASE_URL}run_history.json`;
const POLL_MS = 2000;
const CORPUS_STALE_EVENT = 'linkedinjobs:corpus-stale';

const fetchStatus = async (): Promise<ScrapeRun[]> => {
  const res = await fetch(`${STATUS_URL}?t=${Date.now()}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = (await res.json()) as StatusResponse;
  return Array.isArray(data.runs) ? data.runs : [];
};

const safeRel = (iso: string): string => {
  try {
    return formatDistanceToNowStrict(parseISO(iso), { addSuffix: true });
  } catch {
    return iso;
  }
};

const elapsed = (start: string, end: string | null): string => {
  try {
    const s = parseISO(start).getTime();
    const e = end ? parseISO(end).getTime() : Date.now();
    const sec = Math.max(0, Math.round((e - s) / 1000));
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60);
    const r = sec - m * 60;
    return `${m}m ${r}s`;
  } catch {
    return '—';
  }
};

// Status pill: neutral slate chip + a single semantic dot. The dot color
// carries the meaning so the chip background is uniform — no more
// `bg-blue-100`/`bg-emerald-100`/etc. soup. See §3.5.
const StatusPill = ({ status }: { status: RunStatus }) => {
  const map: Record<RunStatus, { dot: DotColor; label: string }> = {
    running: { dot: 'brand', label: 'running' },
    done: { dot: 'good', label: 'done' },
    error: { dot: 'bad', label: 'error' },
    killed: { dot: 'neutral', label: 'killed' },
  };
  const v = map[status];
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
      <Dot color={v.dot} /> {v.label}
    </span>
  );
};

// ModeTag: same neutral-chip-with-semantic-dot pattern as StatusPill.
// loggedin → brand (Playwright + saved session); guest → good (HTTP-only
// fallback). Old emoji prefixes (🔐 🌐) removed.
const ModeTag = ({ mode }: { mode: ScrapeMode }) => (
  <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
    {mode === 'loggedin' ? <Dot color="brand" /> : <Dot color="good" />}
    {mode === 'loggedin' ? 'logged-in' : 'guest'}
  </span>
);

const Toast = ({ msg, kind }: { msg: string; kind: 'ok' | 'err' }) => (
  <div
    className={clsx(
      'fixed left-1/2 top-3 z-40 -translate-x-1/2 rounded-md px-4 py-2 text-sm font-medium shadow-lg',
      kind === 'ok' ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white',
    )}
  >
    {msg}
  </div>
);

const RunRow = ({
  run,
  onStop,
  descFailed,
}: {
  run: ScrapeRun;
  onStop: (id: string) => void;
  // From run_history.json[-1].totals.descriptions_failed — only on the
  // most-recent done run, only when > 0. Surfaces JYMBII / 429 fallout
  // without forcing the user to open run_history.json.
  descFailed?: number;
}) => {
  const [open, setOpen] = useState(run.status === 'running');
  const tailLines = useMemo(() => {
    if (!run.log_tail) return [] as string[];
    return run.log_tail.split('\n').slice(-50);
  }, [run.log_tail]);

  return (
    <div className="border-b border-slate-100 last:border-b-0">
      <div className="flex items-center gap-3 px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-xs text-slate-400 hover:text-slate-700"
          title={open ? 'Collapse log' : 'Expand log'}
        >
          {open ? '▼' : '▶'}
        </button>
        <StatusPill status={run.status} />
        <ModeTag mode={run.mode} />
        <span className="text-xs text-slate-500">
          started {safeRel(run.started_at)}
        </span>
        <span className="text-xs tabular-nums text-slate-500">
          · {elapsed(run.started_at, run.ended_at)}
        </span>
        <span className="ml-auto flex items-center gap-2 text-[11px] text-slate-400">
          {descFailed !== undefined && descFailed > 0 && (
            <span
              className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-700"
              title="Job description fetches that failed (JYMBII/429/etc) on this run — see Run History for details"
            >
              <Dot color="warn" /> {descFailed} desc failed
            </span>
          )}
          <span>pid {run.pid}</span>
          {run.exit_code !== null && <span>exit {run.exit_code}</span>}
          {run.status === 'running' && (
            <button
              type="button"
              onClick={() => onStop(run.id)}
              className="rounded border border-slate-300 bg-white px-2 py-0.5 text-xs text-slate-700 hover:border-red-300 hover:text-red-600"
            >
              Stop
            </button>
          )}
        </span>
      </div>
      {open && (
        <div className="border-t border-slate-100 bg-slate-900 px-3 py-2">
          {tailLines.length === 0 ? (
            <div className="font-mono text-[11px] text-slate-400">
              (no log output yet)
            </div>
          ) : (
            <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-emerald-300">
              {tailLines.join('\n')}
            </pre>
          )}
          <div className="mt-1 text-right text-[10px] text-slate-500">
            log: {run.log_path}
          </div>
        </div>
      )}
    </div>
  );
};

export const ScrapeRunPanel = () => {
  const [runs, setRuns] = useState<ScrapeRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<ScrapeMode | 'both' | null>(null);
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(
    null,
  );
  // Latest run's descriptions_failed count from run_history.json. Re-fetched
  // when a scrape transitions from running -> done.
  const [latestDescFailed, setLatestDescFailed] = useState<number | undefined>(
    undefined,
  );
  const prevStatuses = useRef<Map<string, RunStatus>>(new Map());

  const reloadHistory = useCallback(async () => {
    try {
      const res = await fetch(`${RUN_HISTORY_URL}?t=${Date.now()}`);
      if (!res.ok) return;
      const text = await res.text();
      if (!text.trim()) return;
      const data = JSON.parse(text) as {
        runs?: { totals?: { descriptions_failed?: number } }[];
      };
      const last = Array.isArray(data.runs) && data.runs.length > 0
        ? data.runs[data.runs.length - 1]
        : null;
      const n = last?.totals?.descriptions_failed;
      setLatestDescFailed(typeof n === 'number' ? n : undefined);
    } catch {
      /* run_history.json missing — leave undefined */
    }
  }, []);

  const reload = useCallback(async () => {
    try {
      const r = await fetchStatus();
      setRuns(r);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  // Initial load.
  useEffect(() => {
    void reload();
    void reloadHistory();
  }, [reload, reloadHistory]);

  // Auto-poll while any run is running.
  useEffect(() => {
    if (!runs) return;
    const anyRunning = runs.some((r) => r.status === 'running');
    if (!anyRunning) return;
    const id = window.setInterval(() => {
      void reload();
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [runs, reload]);

  // Detect running -> done transitions and fire the corpus-stale event.
  useEffect(() => {
    if (!runs) return;
    const prev = prevStatuses.current;
    let anyFinished = false;
    for (const r of runs) {
      const prior = prev.get(r.id);
      if (prior === 'running' && r.status !== 'running') {
        anyFinished = true;
      }
    }
    if (anyFinished) {
      setToast({ kind: 'ok', msg: 'Scrape finished — refreshing corpus' });
      window.dispatchEvent(new CustomEvent(CORPUS_STALE_EVENT));
      // Pull the new run_history entry so descFailed updates with the toast.
      void reloadHistory();
    }
    // Update tracked statuses.
    const next = new Map<string, RunStatus>();
    for (const r of runs) next.set(r.id, r.status);
    prevStatuses.current = next;
  }, [runs, reloadHistory]);

  // Auto-dismiss toast.
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 3000);
    return () => window.clearTimeout(id);
  }, [toast]);

  const startScrape = useCallback(
    async (mode: ScrapeMode | 'both') => {
      setBusy(mode);
      setError(null);
      try {
        const res = await fetch(SCRAPE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode }),
        });
        if (!res.ok) {
          const txt = await res.text();
          throw new Error(`HTTP ${res.status}: ${txt}`);
        }
        await reload();
      } catch (e) {
        setError((e as Error).message);
        setToast({ kind: 'err', msg: (e as Error).message });
      } finally {
        setBusy(null);
      }
    },
    [reload],
  );

  const stopRun = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(STOP_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id }),
        });
        if (!res.ok) {
          const txt = await res.text();
          throw new Error(`HTTP ${res.status}: ${txt}`);
        }
        await reload();
      } catch (e) {
        setToast({ kind: 'err', msg: `Stop failed: ${(e as Error).message}` });
      }
    },
    [reload],
  );

  // Newest first, capped at 10 to keep the panel compact.
  const visible = useMemo(() => {
    if (!runs) return [];
    return [...runs].reverse().slice(0, 10);
  }, [runs]);

  const runningModes = useMemo(() => {
    const set = new Set<ScrapeMode>();
    if (!runs) return set;
    for (const r of runs) if (r.status === 'running') set.add(r.mode);
    return set;
  }, [runs]);

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      {toast && <Toast msg={toast.msg} kind={toast.kind} />}

      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-600">
          Run scraper
        </h2>
        <span
          className="cursor-help text-xs text-slate-400"
          title={
            'logged-in: Playwright + saved LinkedIn session (richer scoring data, slower, ~limited by your account).\n' +
            'guest: HTTP only, no account, more raw results, less context.\n' +
            'Both modes can run in parallel — they share results.json safely via fcntl-locked merges.'
          }
        >
          ⓘ what's the difference?
        </span>
      </div>

      {/* Mobile: stack the three "Run …" buttons full-width so each is a
          comfortable tap target and the row doesn't leave one button
          orphaned on its own line. Desktop (md+): inline. Per §3.4 the two
          per-mode buttons are secondary (slate outline); "Run both" is the
          primary action (brand-filled). Decorative emojis removed; a
          semantic dot stands in for the mode tag. */}
      <div className="mb-3 flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center">
        <button
          type="button"
          onClick={() => void startScrape('loggedin')}
          disabled={busy !== null || runningModes.has('loggedin')}
          className="inline-flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-brand-50 hover:text-brand-700 disabled:cursor-not-allowed disabled:opacity-50 md:w-auto md:justify-start"
        >
          <Dot color="brand" /> Run logged-in mode
        </button>
        <button
          type="button"
          onClick={() => void startScrape('guest')}
          disabled={busy !== null || runningModes.has('guest')}
          className="inline-flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-brand-50 hover:text-brand-700 disabled:cursor-not-allowed disabled:opacity-50 md:w-auto md:justify-start"
        >
          <Dot color="good" /> Run guest mode
        </button>
        <button
          type="button"
          onClick={() => void startScrape('both')}
          disabled={
            busy !== null ||
            runningModes.has('loggedin') ||
            runningModes.has('guest')
          }
          className="inline-flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded bg-brand-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-800 disabled:cursor-not-allowed disabled:opacity-50 md:w-auto md:justify-start"
        >
          Run both
        </button>
        <button
          type="button"
          onClick={() => void reload()}
          className="self-end rounded border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-50 md:ml-auto md:self-auto"
          title="Re-poll status"
        >
          ↻
        </button>
      </div>

      {error && (
        <div className="mb-2 rounded border border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-700">
          {error}
        </div>
      )}

      <div className="rounded border border-slate-200 bg-white">
        {runs === null ? (
          <div className="px-3 py-3 text-xs text-slate-400">Loading status…</div>
        ) : visible.length === 0 ? (
          <div className="px-3 py-3 text-xs text-slate-400">
            No scraper runs yet. Hit a button above to start one.
          </div>
        ) : (
          visible.map((r, i) => (
            <RunRow
              key={r.id}
              run={r}
              onStop={stopRun}
              // Only the most-recent finished run carries the desc-failed
              // chip — surfaced from run_history.json[-1].
              descFailed={i === 0 && r.status === 'done' ? latestDescFailed : undefined}
            />
          ))
        )}
      </div>
    </section>
  );
};
