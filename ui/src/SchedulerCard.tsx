import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { formatDistanceToNowStrict, parseISO } from 'date-fns';
import { Dot } from './Dot';

type SchedulerMode = 'loggedin' | 'guest';

interface SchedulerStatus {
  installed: boolean;
  loaded: boolean;
  interval_seconds: number | null;
  interval_label: string | null;
  mode: SchedulerMode | null;
  last_run: string | null;
  next_run_estimate: string | null;
  log_tail: string;
  plist_path: string | null;
  errors: string[];
  // OS scheduler implementation: 'launchd' (mac), 'systemd_user' (linux),
  // 'schtasks' (win). Reported by /api/scheduler-status so the UI can show
  // the right noun (plist/unit/task) instead of always saying "plist".
  backend?: string;
}

const STATUS_URL = '/api/scheduler-status';
const INSTALL_URL = '/api/scheduler/install';
const UNINSTALL_URL = '/api/scheduler/uninstall';
const CONFIGURE_URL = '/api/scheduler/configure';
const POLL_MS = 30_000;
const CONFIGURE_DEBOUNCE_MS = 400;

// Preset intervals offered in the UI.
const INTERVAL_PRESETS: { value: number; label: string }[] = [
  { value: 3_600, label: '1 h' },
  { value: 21_600, label: '6 h' },
  { value: 43_200, label: '12 h' },
  { value: 86_400, label: '24 h' },
];
const PRESET_VALUES = new Set(INTERVAL_PRESETS.map((p) => p.value));

const safeRel = (iso: string | null): string => {
  if (!iso) return '—';
  try {
    return formatDistanceToNowStrict(parseISO(iso), { addSuffix: true });
  } catch {
    return iso;
  }
};

// "Next run" framing: a future timestamp reads "in 7h"; a past one means
// the scheduler missed its window (e.g. Mac was asleep — launchd's
// StartInterval doesn't fire missed runs while sleeping). Render that as
// "overdue X" so the UI doesn't show the misleading "5 hours ago".
const safeRelFuture = (iso: string | null): string => {
  if (!iso) return '—';
  try {
    const date = parseISO(iso);
    const distance = formatDistanceToNowStrict(date);
    return date <= new Date() ? `overdue ${distance}` : `in ${distance}`;
  } catch {
    return iso;
  }
};

// Toasts use semantic bg colors mapped through the new palette tokens.
// `ok` = good (emerald), `err` = bad (red). Brand-only consolidation.
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

// Status badge: neutral slate chip + a single semantic dot. Replaces the
// emoji-prefixed full-color chips per §3.5. Same three states; same
// semantic colors via the dot:
//   not installed = bad   (red)
//   loaded=false  = warn  (amber — installed but inactive)
//   active        = good  (emerald)
const StatusBadge = ({ status }: { status: SchedulerStatus }) => {
  if (!status.installed) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
        <Dot color="bad" /> Not installed
      </span>
    );
  }
  if (!status.loaded) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
        <Dot color="warn" /> Installed but not loaded
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
      <Dot color="good" /> Active
    </span>
  );
};

// Pull a structured error string out of whatever the middleware returned.
const extractError = async (res: Response): Promise<string> => {
  try {
    const data = (await res.json()) as { error?: string; stderr?: string };
    if (data.error) return data.error;
    if (data.stderr) return data.stderr;
  } catch {
    /* not JSON */
  }
  return `HTTP ${res.status}`;
};

export const SchedulerCard = () => {
  const [status, setStatus] = useState<SchedulerStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<'install' | 'uninstall' | null>(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);
  const [logOpen, setLogOpen] = useState(false);

  // The interval the user is currently editing. null = use preset matching status.
  const [intervalDraft, setIntervalDraft] = useState<number | null>(null);
  // Whether the dropdown is in "custom" mode (shows the seconds input).
  const [customMode, setCustomMode] = useState(false);
  // Local mode draft so the toggle reflects immediately.
  const [modeDraft, setModeDraft] = useState<SchedulerMode | null>(null);

  // Debounce token for /api/scheduler/configure.
  const configureTimer = useRef<number | null>(null);
  // Track an in-flight configure to avoid clobbering responses.
  const configureSeq = useRef(0);

  const reload = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const res = await fetch(`${STATUS_URL}?t=${Date.now()}`);
      if (!res.ok) {
        const msg = await extractError(res);
        throw new Error(msg);
      }
      const data = (await res.json()) as SchedulerStatus;
      setStatus(data);
      setError(null);
      // Reset drafts to mirror server truth (only when not actively saving).
      setIntervalDraft(null);
      setModeDraft(null);
      setCustomMode(
        data.interval_seconds !== null && !PRESET_VALUES.has(data.interval_seconds),
      );
    } catch (e) {
      setError((e as Error).message);
      setStatus(null);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  // Initial load.
  useEffect(() => {
    void reload();
  }, [reload]);

  // Slow auto-poll while mounted.
  useEffect(() => {
    const id = window.setInterval(() => {
      void reload(true);
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [reload]);

  // Auto-dismiss toast.
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 3000);
    return () => window.clearTimeout(id);
  }, [toast]);

  // Cleanup any pending debounce on unmount.
  useEffect(() => {
    return () => {
      if (configureTimer.current !== null) {
        window.clearTimeout(configureTimer.current);
      }
    };
  }, []);

  const effectiveInterval = intervalDraft ?? status?.interval_seconds ?? null;
  const effectiveMode = modeDraft ?? status?.mode ?? null;

  const fireConfigure = useCallback(
    (payload: { interval_seconds?: number; mode?: SchedulerMode }) => {
      if (configureTimer.current !== null) {
        window.clearTimeout(configureTimer.current);
      }
      configureTimer.current = window.setTimeout(async () => {
        const seq = ++configureSeq.current;
        setSaving(true);
        try {
          const res = await fetch(CONFIGURE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          if (!res.ok) {
            const msg = await extractError(res);
            throw new Error(msg);
          }
          // Stale response — a newer configure has already started.
          if (seq !== configureSeq.current) return;
          setToast({ kind: 'ok', msg: 'Saved ✓' });
          await reload(true);
        } catch (e) {
          if (seq !== configureSeq.current) return;
          setToast({ kind: 'err', msg: `Save failed: ${(e as Error).message}` });
        } finally {
          if (seq === configureSeq.current) setSaving(false);
        }
      }, CONFIGURE_DEBOUNCE_MS);
    },
    [reload],
  );

  const onIntervalSelectChange = useCallback(
    (raw: string) => {
      if (raw === '__custom') {
        setCustomMode(true);
        // Don't fire a save until the user types a value.
        return;
      }
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) return;
      setCustomMode(false);
      setIntervalDraft(n);
      fireConfigure({ interval_seconds: n });
    },
    [fireConfigure],
  );

  const onCustomIntervalChange = useCallback(
    (raw: string) => {
      const n = parseInt(raw, 10);
      if (!Number.isFinite(n) || n <= 0) {
        setIntervalDraft(null);
        return;
      }
      setIntervalDraft(n);
      fireConfigure({ interval_seconds: n });
    },
    [fireConfigure],
  );

  const onModeToggle = useCallback(
    (next: SchedulerMode) => {
      if (next === effectiveMode) return;
      setModeDraft(next);
      fireConfigure({ mode: next });
    },
    [effectiveMode, fireConfigure],
  );

  const doInstall = useCallback(async () => {
    setActionBusy('install');
    try {
      const res = await fetch(INSTALL_URL, { method: 'POST' });
      if (!res.ok) {
        const msg = await extractError(res);
        throw new Error(msg);
      }
      setToast({ kind: 'ok', msg: 'Scheduler installed' });
      await reload(true);
    } catch (e) {
      setToast({ kind: 'err', msg: `Install failed: ${(e as Error).message}` });
    } finally {
      setActionBusy(null);
    }
  }, [reload]);

  const doUninstall = useCallback(async () => {
    setActionBusy('uninstall');
    try {
      const res = await fetch(UNINSTALL_URL, { method: 'POST' });
      if (!res.ok) {
        const msg = await extractError(res);
        throw new Error(msg);
      }
      setToast({ kind: 'ok', msg: 'Scheduler uninstalled' });
      await reload(true);
    } catch (e) {
      setToast({ kind: 'err', msg: `Uninstall failed: ${(e as Error).message}` });
    } finally {
      setActionBusy(null);
    }
  }, [reload]);

  const intervalSelectValue = useMemo(() => {
    if (customMode) return '__custom';
    if (effectiveInterval === null) return '';
    return PRESET_VALUES.has(effectiveInterval)
      ? String(effectiveInterval)
      : '__custom';
  }, [customMode, effectiveInterval]);

  // The "logged-in" mode requires Playwright + a saved session, so the toggle
  // should always be visible even when the scheduler isn't installed yet.
  // Single ghost-on-active style for both options (matches Tracker view
  // toggle); the previous indigo/emerald split was conflating brand colors
  // with semantic state.
  const renderModeToggle = () => {
    const btn = (mode: SchedulerMode, label: string) => (
      <button
        type="button"
        onClick={() => onModeToggle(mode)}
        aria-pressed={effectiveMode === mode}
        className={clsx(
          'rounded px-2.5 py-1 text-xs font-medium transition-colors',
          effectiveMode === mode
            ? 'bg-slate-100 text-slate-900 shadow-sm'
            : 'bg-transparent text-slate-500 hover:text-slate-800',
        )}
      >
        {label}
      </button>
    );
    return (
      <div className="inline-flex items-center gap-0.5 rounded border border-slate-200 bg-white p-0.5">
        {btn('guest', 'guest')}
        {btn('loggedin', 'logged-in')}
      </div>
    );
  };

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      {toast && <Toast msg={toast.msg} kind={toast.kind} />}

      <div className="mb-1 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-600">
          Scheduler
        </h2>
        <div className="flex items-center gap-2">
          {saving && (
            <span className="text-[11px] text-slate-400">saving…</span>
          )}
          {status && <StatusBadge status={status} />}
          <button
            type="button"
            onClick={() => void reload()}
            className="rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
            title="Re-poll status"
          >
            ↻
          </button>
        </div>
      </div>
      <p className="mb-3 text-xs text-slate-500">
        A scheduled task that runs the scraper at the chosen interval using the active profile's config —
        on macOS, Linux, or Windows. "Active" means installed. Uninstall removes the schedule; your
        corpus and config aren't touched.
      </p>

      {loading && !status && (
        <div className="rounded border border-slate-200 bg-slate-50 px-3 py-3 text-xs text-slate-500">
          Loading scheduler status…
        </div>
      )}

      {error && (
        <div className="mb-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          <div className="font-semibold">Could not read scheduler status</div>
          <div className="mt-0.5 break-all">{error}</div>
          <div className="mt-1 text-[11px] text-red-600/80">
            Check that <code>scheduler_ctl.py</code> exists at the repo root and
            is executable.
          </div>
        </div>
      )}

      {status && (
        <>
          {status.errors.length > 0 && (
            <div className="mb-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <div className="font-semibold">scheduler_ctl reported issues:</div>
              <ul className="mt-1 list-inside list-disc">
                {status.errors.map((err, i) => (
                  <li key={i} className="break-all">{err}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="grid grid-cols-1 gap-x-4 gap-y-3 md:grid-cols-2">
            {/* Interval */}
            <div>
              <div className="mb-1 text-xs font-semibold text-slate-700">
                Interval
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm tabular-nums text-slate-900">
                  {status.interval_label ?? '—'}
                </span>
                <select
                  value={intervalSelectValue}
                  onChange={(e) => onIntervalSelectChange(e.target.value)}
                  className="rounded border border-slate-300 bg-white px-2 py-1 text-xs focus:border-brand-700 focus:outline-none focus:ring-1 focus:ring-brand-700"
                >
                  {INTERVAL_PRESETS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                  <option value="__custom">Custom…</option>
                </select>
                {customMode && (
                  <input
                    type="number"
                    min={1}
                    placeholder="seconds"
                    value={intervalDraft ?? status.interval_seconds ?? ''}
                    onChange={(e) => onCustomIntervalChange(e.target.value)}
                    className="w-28 rounded border border-slate-300 bg-white px-2 py-1 text-xs tabular-nums focus:border-brand-700 focus:outline-none focus:ring-1 focus:ring-brand-700"
                  />
                )}
              </div>
            </div>

            {/* Mode */}
            <div>
              <div className="mb-1 text-xs font-semibold text-slate-700">
                Mode
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 text-sm text-slate-900">
                  {status.mode === 'loggedin' ? (
                    <>
                      <Dot color="brand" /> logged-in
                    </>
                  ) : status.mode === 'guest' ? (
                    <>
                      <Dot color="good" /> guest
                    </>
                  ) : (
                    '—'
                  )}
                </span>
                {renderModeToggle()}
              </div>
            </div>

            {/* Last run */}
            <div>
              <div className="mb-1 text-xs font-semibold text-slate-700">
                Last run
              </div>
              <div className="text-sm text-slate-900">
                {status.last_run ? safeRel(status.last_run) : (
                  <span className="text-slate-400">never</span>
                )}
              </div>
            </div>

            {/* Next run estimate */}
            <div>
              <div className="mb-1 text-xs font-semibold text-slate-700">
                Next run (est.)
              </div>
              <div className="text-sm text-slate-900">
                {status.next_run_estimate ? safeRelFuture(status.next_run_estimate) : (
                  <span className="text-slate-400">unknown</span>
                )}
              </div>
            </div>
          </div>

          {/* Action buttons */}
          <div className="mt-3 flex items-center gap-2">
            {!status.installed ? (
              <button
                type="button"
                onClick={() => void doInstall()}
                disabled={actionBusy !== null}
                className="rounded bg-brand-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {actionBusy === 'install' ? 'Installing…' : 'Install'}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void doUninstall()}
                disabled={actionBusy !== null}
                className="rounded border border-red-200 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {actionBusy === 'uninstall' ? 'Uninstalling…' : 'Uninstall'}
              </button>
            )}
            {status.plist_path && (
              <span className="text-[11px] text-slate-400" title={status.plist_path}>
                {status.backend === 'launchd' ? 'plist' :
                 status.backend === 'systemd_user' ? 'unit' :
                 status.backend === 'schtasks' ? 'task' : 'schedule'}: {status.plist_path}
              </span>
            )}
          </div>

          {/* Log tail accordion */}
          <div className="mt-3 border-t border-slate-100 pt-2">
            <button
              type="button"
              onClick={() => setLogOpen((v) => !v)}
              className="flex items-center gap-1.5 text-xs text-slate-600 hover:text-brand-700"
            >
              <span className="text-slate-400">{logOpen ? '▼' : '▶'}</span>
              View recent log
            </button>
            {logOpen && (
              <div className="mt-2 rounded border border-slate-200 bg-slate-900 px-3 py-2">
                {status.log_tail && status.log_tail.trim() ? (
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed text-emerald-300">
                    {status.log_tail}
                  </pre>
                ) : (
                  <div className="font-mono text-[11px] text-slate-400">
                    (no log file yet — the scheduler hasn't run)
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
};
