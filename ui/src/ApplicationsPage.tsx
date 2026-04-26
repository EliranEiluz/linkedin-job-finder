import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { formatDistanceToNowStrict, parseISO } from 'date-fns';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { AppStatus, Job } from './types';
import { useAppStatus } from './hooks';

// ---- Constants ------------------------------------------------------------

// 7 visible columns. `'new'` is intentionally hidden — jobs with no
// `app_status` (or `'new'`) live in the Corpus tab, not here.
const COLUMNS: readonly AppStatus[] = [
  'applied',
  'screening',
  'interview',
  'take-home',
  'offer',
  'rejected',
  'withdrew',
] as const;

const STATUS_LABEL: Record<AppStatus, string> = {
  new: 'New',
  applied: 'Applied',
  screening: 'Screening',
  interview: 'Interview',
  'take-home': 'Take-home',
  offer: 'Offer',
  rejected: 'Rejected',
  withdrew: 'Withdrew',
};

// Tailwind tints for the column accent bar. Kept inline (instead of dynamic
// class names) so Tailwind's JIT picks them up at build time.
const STATUS_ACCENT: Record<AppStatus, string> = {
  new: 'bg-slate-300',
  applied: 'bg-slate-400',
  screening: 'bg-blue-500',
  interview: 'bg-indigo-500',
  'take-home': 'bg-amber-500',
  offer: 'bg-emerald-500',
  rejected: 'bg-red-500',
  withdrew: 'bg-slate-300',
};

const RESULTS_URL = `${import.meta.env.BASE_URL}results.json`;

const APPLIED_LOCALSTORAGE_KEY = 'linkedinjobs:applied';
const APPLIED_IMPORTED_FLAG_KEY = 'linkedinjobs:applied-imported-v1';

// ---- Helpers --------------------------------------------------------------

const safeRel = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  try {
    return formatDistanceToNowStrict(parseISO(iso), { addSuffix: true });
  } catch {
    return '—';
  }
};

const fetchJobs = async (): Promise<Job[]> => {
  const res = await fetch(`${RESULTS_URL}?t=${Date.now()}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (!text.trim()) return [];
  const data = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error('results.json root must be an array');
  return data as Job[];
};

const groupByStatus = (jobs: Job[]): Map<AppStatus, Job[]> => {
  const map = new Map<AppStatus, Job[]>();
  for (const col of COLUMNS) map.set(col, []);
  for (const j of jobs) {
    const s = j.app_status;
    if (!s || s === 'new') continue;
    const arr = map.get(s);
    if (arr) arr.push(j);
  }
  // Sort each column: most recently moved first.
  for (const [, arr] of map) {
    arr.sort((a, b) => {
      const ta = a.app_status_at ? Date.parse(a.app_status_at) : 0;
      const tb = b.app_status_at ? Date.parse(b.app_status_at) : 0;
      return tb - ta;
    });
  }
  return map;
};

// ---- Toast ----------------------------------------------------------------

interface ToastMsg {
  id: number;
  text: string;
  kind: 'ok' | 'err';
}

const Toast = ({ msg }: { msg: ToastMsg }) => (
  <div
    className={clsx(
      'fixed left-1/2 top-3 z-40 -translate-x-1/2 rounded-md px-4 py-2 text-sm font-medium shadow-lg',
      msg.kind === 'ok' ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white',
    )}
  >
    {msg.text}
  </div>
);

// ---- Card -----------------------------------------------------------------

interface CardProps {
  job: Job;
  isOverlay?: boolean;
}

const FitPill = ({ fit }: { fit: Job['fit'] }) => {
  if (fit === 'good')
    return (
      <span className="inline-flex items-center rounded-full bg-emerald-100 px-1.5 py-0 text-[10px] font-medium text-emerald-800">
        good
      </span>
    );
  if (fit === 'ok')
    return (
      <span className="inline-flex items-center rounded-full bg-amber-100 px-1.5 py-0 text-[10px] font-medium text-amber-800">
        ok
      </span>
    );
  if (fit === 'skip')
    return (
      <span className="inline-flex items-center rounded-full bg-slate-200 px-1.5 py-0 text-[10px] font-medium text-slate-600">
        skip
      </span>
    );
  return null;
};

const RatingStars = ({ rating }: { rating: number | null | undefined }) => {
  if (!rating) return null;
  return (
    <span className="text-[10px] text-amber-500" aria-label={`${rating} stars`}>
      {'★'.repeat(rating)}
      <span className="text-slate-300">{'★'.repeat(Math.max(0, 5 - rating))}</span>
    </span>
  );
};

const CardContent = ({ job }: { job: Job }) => (
  <>
    <div className="truncate text-sm font-medium text-slate-900" title={job.title}>
      {job.title || '(untitled)'}
    </div>
    <div
      className="mt-0.5 truncate text-xs text-slate-500"
      title={job.company}
    >
      {job.company || '—'}
    </div>
    <div className="mt-1 text-[10px] text-slate-400">
      moved {safeRel(job.app_status_at)}
    </div>
    <div className="mt-1.5 flex items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-1.5">
        <RatingStars rating={job.rating} />
        <FitPill fit={job.fit} />
      </div>
      {job.url && (
        <a
          href={job.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          className="shrink-0 text-[10px] text-brand-700 hover:underline"
        >
          Open ↗
        </a>
      )}
    </div>
  </>
);

const SortableCard = ({ job }: CardProps) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: job.id, data: { job } });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={clsx(
        'group rounded-md border border-slate-200 bg-white p-2 shadow-sm',
        'cursor-grab touch-none ring-0 hover:ring-1 hover:ring-slate-300',
        'active:cursor-grabbing',
      )}
    >
      <CardContent job={job} />
    </div>
  );
};

const OverlayCard = ({ job }: CardProps) => (
  <div
    className={clsx(
      'rounded-md border border-slate-300 bg-white p-2 shadow-lg ring-1 ring-slate-300',
      'cursor-grabbing',
      'w-[260px]',
    )}
  >
    <CardContent job={job} />
  </div>
);

// ---- Column ---------------------------------------------------------------

interface ColumnProps {
  status: AppStatus;
  jobs: Job[];
}

const Column = ({ status, jobs }: ColumnProps) => {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  return (
    <div className="flex w-[260px] min-w-[240px] max-w-[280px] shrink-0 flex-col">
      {/* Sticky header */}
      <div className="sticky top-0 z-10 bg-slate-50 pb-2">
        <div className="flex items-center justify-between px-1">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-semibold text-slate-800">
              {STATUS_LABEL[status]}
            </span>
            <span className="rounded-full bg-slate-200 px-1.5 text-[10px] font-medium text-slate-600">
              {jobs.length}
            </span>
          </div>
        </div>
        <div className={clsx('mt-1 h-0.5 w-full rounded', STATUS_ACCENT[status])} />
      </div>

      {/* Cards container — droppable */}
      <SortableContext
        items={jobs.map((j) => j.id)}
        strategy={verticalListSortingStrategy}
      >
        <div
          ref={setNodeRef}
          className={clsx(
            'flex min-h-[120px] flex-1 flex-col gap-2 rounded-md p-1.5 transition-colors',
            isOver ? 'bg-brand-50' : 'bg-transparent',
          )}
        >
          {jobs.length === 0 ? (
            <div className="flex h-24 items-center justify-center rounded-md border border-dashed border-slate-300 text-xs text-slate-400">
              Drop here
            </div>
          ) : (
            jobs.map((j) => <SortableCard key={j.id} job={j} />)
          )}
        </div>
      </SortableContext>
    </div>
  );
};

// ---- Main page ------------------------------------------------------------

export const ApplicationsPage = () => {
  // Local cards state for optimistic updates. Initialized from a fetch
  // and re-synced on `linkedinjobs:corpus-stale`.
  const [cards, setCards] = useState<Map<AppStatus, Job[]>>(
    () => groupByStatus([]),
  );
  const [loadState, setLoadState] = useState<
    'loading' | 'ok' | 'error'
  >('loading');
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [activeJob, setActiveJob] = useState<Job | null>(null);
  const [toast, setToast] = useState<ToastMsg | null>(null);
  const toastTimerRef = useRef<number | undefined>(undefined);

  const { setAppStatus, bulkImportApplied } = useAppStatus();

  // ---- Toast helper ----
  const showToast = useCallback(
    (text: string, kind: 'ok' | 'err' = 'ok') => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
      const id = Date.now();
      setToast({ id, text, kind });
      toastTimerRef.current = window.setTimeout(() => {
        setToast((cur) => (cur && cur.id === id ? null : cur));
      }, 3500);
    },
    [],
  );

  // ---- Reload from /results.json ----
  const reload = useCallback(async () => {
    setLoadState('loading');
    try {
      const jobs = await fetchJobs();
      setCards(groupByStatus(jobs));
      setLoadState('ok');
    } catch (e) {
      setErrorMsg((e as Error).message);
      setLoadState('error');
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Re-fetch when other surfaces dispatch the stale event.
  useEffect(() => {
    const onStale = () => void reload();
    window.addEventListener('linkedinjobs:corpus-stale', onStale);
    return () => window.removeEventListener('linkedinjobs:corpus-stale', onStale);
  }, [reload]);

  // ---- One-shot localStorage migration ----
  // Runs on mount: if `linkedinjobs:applied` has IDs and the imported flag
  // is not set, POST them to the server, then sticky-set the flag.
  const migrationRanRef = useRef(false);
  const runMigration = useCallback(
    async (silent = false): Promise<number> => {
      try {
        if (window.localStorage.getItem(APPLIED_IMPORTED_FLAG_KEY) === 'true') {
          if (!silent) showToast('Already imported once on this browser', 'ok');
          return 0;
        }
        const raw = window.localStorage.getItem(APPLIED_LOCALSTORAGE_KEY);
        if (!raw) {
          if (!silent) showToast('No applied jobs in browser storage', 'ok');
          // Still set the sticky flag so we don't re-check forever.
          window.localStorage.setItem(APPLIED_IMPORTED_FLAG_KEY, 'true');
          return 0;
        }
        let ids: string[] = [];
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            ids = parsed.filter((x) => typeof x === 'string');
          }
        } catch {
          /* malformed — treat as empty */
        }
        if (ids.length === 0) {
          window.localStorage.setItem(APPLIED_IMPORTED_FLAG_KEY, 'true');
          if (!silent) showToast('No applied jobs in browser storage', 'ok');
          return 0;
        }
        const r = await bulkImportApplied(ids);
        if (!r.ok) {
          showToast(`Import failed: ${r.error ?? 'unknown'}`, 'err');
          return 0;
        }
        window.localStorage.setItem(APPLIED_IMPORTED_FLAG_KEY, 'true');
        const n = r.imported ?? ids.length;
        showToast(`Imported ${n} applied jobs from your browser`, 'ok');
        return n;
      } catch (e) {
        showToast(`Import error: ${(e as Error).message}`, 'err');
        return 0;
      }
    },
    [bulkImportApplied, showToast],
  );

  useEffect(() => {
    if (migrationRanRef.current) return;
    migrationRanRef.current = true;
    void runMigration(true);
  }, [runMigration]);

  // ---- Drag handlers ----
  const sensors = useSensors(
    useSensor(PointerSensor, {
      // 5px activation distance avoids hijacking clicks on the "Open ↗" link.
      activationConstraint: { distance: 5 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const findJob = useCallback(
    (id: string): { job: Job; status: AppStatus } | null => {
      for (const [status, arr] of cards) {
        const j = arr.find((x) => x.id === id);
        if (j) return { job: j, status };
      }
      return null;
    },
    [cards],
  );

  const handleDragStart = (e: DragStartEvent) => {
    const id = String(e.active.id);
    const found = findJob(id);
    if (found) setActiveJob(found.job);
  };

  const handleDragEnd = async (e: DragEndEvent) => {
    setActiveJob(null);
    const { active, over } = e;
    if (!over) return;

    const cardId = String(active.id);
    const overId = String(over.id);

    // Resolve the target column. `over.id` is either:
    //   (a) a column id (when dropped on the column droppable / placeholder), or
    //   (b) another card id (when dropped onto another card in a column).
    let targetCol: AppStatus | null = null;
    if ((COLUMNS as readonly string[]).includes(overId)) {
      targetCol = overId as AppStatus;
    } else {
      const overFound = findJob(overId);
      if (overFound) targetCol = overFound.status;
    }
    if (!targetCol) return;

    const found = findJob(cardId);
    if (!found) return;
    if (found.status === targetCol) {
      // Same-column drop: no-op (we don't track within-column ordering).
      return;
    }

    // Snapshot for revert.
    const prevCards = cards;
    const newStatus = targetCol;

    // Optimistic move.
    const next = new Map(cards);
    const fromArr = (next.get(found.status) ?? []).filter(
      (x) => x.id !== cardId,
    );
    const movedJob: Job = {
      ...found.job,
      app_status: newStatus,
      app_status_at: new Date().toISOString(),
    };
    const toArr = [movedJob, ...(next.get(newStatus) ?? [])];
    next.set(found.status, fromArr);
    next.set(newStatus, toArr);
    setCards(next);

    const r = await setAppStatus(cardId, newStatus);
    if (!r.ok) {
      // Revert.
      setCards(prevCards);
      showToast(
        `Couldn't move card: ${r.error ?? 'unknown error'}`,
        'err',
      );
    }
  };

  // ---- Counts ----
  const totalActive = useMemo(
    () => Array.from(cards.values()).reduce((acc, arr) => acc + arr.length, 0),
    [cards],
  );

  const pageEmpty = loadState === 'ok' && totalActive === 0;

  return (
    <div className="flex h-full flex-col">
      {/* Top bar */}
      <div className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2.5">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">
            Application Tracker
          </h2>
          <p className="text-xs text-slate-500">
            {loadState === 'loading'
              ? 'loading…'
              : loadState === 'error'
              ? `failed to load: ${errorMsg}`
              : `${totalActive} active application${totalActive === 1 ? '' : 's'}`}
          </p>
        </div>
        {/*
          Stage 3-C will mount controls here:
            - Kanban / Table view toggle
            - Per-stage summary chips (e.g. "3 stale")
          Leave this slot stable so 3-C drops in without re-flowing the bar.
        */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void reload()}
            disabled={loadState === 'loading'}
            className="inline-flex items-center gap-1.5 rounded border border-slate-300 bg-white px-3 py-1 text-sm text-slate-700 hover:bg-brand-50 hover:text-brand-700 disabled:opacity-50"
          >
            <span>↻</span> Refresh
          </button>
        </div>
      </div>

      {/* Body */}
      {loadState === 'error' ? (
        <div className="flex h-full flex-col items-center justify-center px-6 py-20 text-center text-sm text-slate-600">
          <p>Couldn't load results.json: {errorMsg}</p>
        </div>
      ) : pageEmpty ? (
        <div className="flex h-full flex-col items-center justify-center px-6 py-20 text-center">
          <h3 className="mb-2 text-base font-semibold text-slate-800">
            No applications tracked yet.
          </h3>
          <p className="mb-6 max-w-md text-sm text-slate-600">
            When you mark a job as applied in the Corpus tab, or move it
            through stages here, it'll appear in this view.
          </p>
          <button
            type="button"
            onClick={() => void runMigration(false).then(() => reload())}
            className="rounded border border-brand-700 bg-white px-3 py-1.5 text-sm font-medium text-brand-700 hover:bg-brand-50"
          >
            Import applied jobs from this browser
          </button>
        </div>
      ) : (
        <div className="flex-1 overflow-x-auto overflow-y-hidden bg-slate-50">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragCancel={() => setActiveJob(null)}
          >
            <div className="flex h-full gap-3 p-4">
              {COLUMNS.map((status) => (
                <Column
                  key={status}
                  status={status}
                  jobs={cards.get(status) ?? []}
                />
              ))}
            </div>
            <DragOverlay>
              {activeJob ? <OverlayCard job={activeJob} /> : null}
            </DragOverlay>
          </DndContext>
        </div>
      )}

      {toast && <Toast msg={toast} />}
    </div>
  );
};

export default ApplicationsPage;
