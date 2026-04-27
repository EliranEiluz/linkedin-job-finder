import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { formatDistanceToNowStrict, parseISO } from 'date-fns';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
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
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
} from '@tanstack/react-table';
import { APP_STATUS_ORDER, type AppStatus, type Job } from './types';
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

// Pill tints for the per-stage summary chips and the table-view status
// pill. Same accent family as STATUS_ACCENT but two-tone (bg + text) so
// they read as small badges rather than colored bars.
const STATUS_CHIP: Record<AppStatus, string> = {
  new: 'bg-slate-100 text-slate-600',
  applied: 'bg-slate-200 text-slate-700',
  screening: 'bg-blue-100 text-blue-800',
  interview: 'bg-indigo-100 text-indigo-800',
  'take-home': 'bg-amber-100 text-amber-800',
  offer: 'bg-emerald-100 text-emerald-800',
  rejected: 'bg-red-100 text-red-800',
  withdrew: 'bg-slate-100 text-slate-500',
};

// "Active" stages where a follow-up makes sense — terminal states
// (offer / rejected / withdrew) are excluded. Threshold matches the
// design doc: 14 days since last move flags the row as stale.
const STALE_DAYS = 14;
const STALE_ACTIVE: ReadonlySet<AppStatus> = new Set<AppStatus>([
  'applied',
  'screening',
  'interview',
  'take-home',
]);

const RESULTS_URL = `${import.meta.env.BASE_URL}results.json`;

const APPLIED_LOCALSTORAGE_KEY = 'linkedinjobs:applied';
const APPLIED_IMPORTED_FLAG_KEY = 'linkedinjobs:applied-imported-v1';

// Persistence key for the kanban/table toggle. Keep aligned with the
// other UI prefs under the `linkedinjobs:` namespace.
const VIEW_LOCALSTORAGE_KEY = 'linkedinjobs:tracker-view';
type ViewMode = 'kanban' | 'table';

// Notes editor sizing + autosave cadence. Server caps at 4000 chars (see
// vite.config.ts → /api/corpus/app-status). 600ms debounce mirrors the
// rating-comment editor in JobActionsPopover.tsx so the two surfaces feel
// identical to the user.
const NOTES_MAX = 4000;
const NOTES_AUTOSAVE_MS = 600;

// Pointer-down → pointer-up displacement threshold (in CSS px) under which
// a card pointer interaction is treated as a click (open the detail modal)
// rather than a drag. Matches the @dnd-kit PointerSensor activation
// constraint of 5px so the two have a single, shared meaning of "click".
const CARD_CLICK_TOLERANCE_PX = 5;

const readInitialView = (): ViewMode => {
  // URL param wins (allows linking + Playwright smokes).
  try {
    const sp = new URLSearchParams(window.location.search);
    const v = sp.get('view');
    if (v === 'table' || v === 'kanban') return v;
  } catch {
    /* SSR / sandbox */
  }
  try {
    const stored = window.localStorage.getItem(VIEW_LOCALSTORAGE_KEY);
    if (stored === 'table' || stored === 'kanban') return stored;
  } catch {
    /* localStorage blocked */
  }
  return 'kanban';
};

// ---- Helpers --------------------------------------------------------------

const safeRel = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  try {
    return formatDistanceToNowStrict(parseISO(iso), { addSuffix: true });
  } catch {
    return '—';
  }
};

// "Stale" = active stage AND last status move was >STALE_DAYS ago. Pure
// derived overlay — never written to disk, never a column of its own.
const isStaleJob = (j: Job): boolean => {
  if (!j.app_status || !STALE_ACTIVE.has(j.app_status)) return false;
  if (!j.app_status_at) return false;
  const t = Date.parse(j.app_status_at);
  if (Number.isNaN(t)) return false;
  const ageMs = Date.now() - t;
  return ageMs >= STALE_DAYS * 24 * 60 * 60 * 1000;
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
  stale?: boolean;
  isFirstStale?: boolean;
  // Fires when the user clicks the card (no drag). Distinguished from
  // drags by tracking pointer-down → pointer-up displacement; see the
  // pointer handlers in SortableCard below. Optional so OverlayCard +
  // legacy callers can ignore it.
  onOpen?: (job: Job) => void;
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

const CardContent = ({ job, stale }: { job: Job; stale?: boolean }) => (
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
    <div className="mt-1 flex items-center gap-1 text-[10px] text-slate-400">
      <span>moved {safeRel(job.app_status_at)}</span>
      {stale && (
        <span
          className="inline-flex items-center gap-0.5 font-medium text-amber-600"
          title={`No movement in ${STALE_DAYS}+ days`}
        >
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500" />
          stale
        </span>
      )}
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

const SortableCard = ({ job, stale, isFirstStale, onOpen }: CardProps) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: job.id, data: { job } });

  // Track the pointer-down position so onPointerUp can decide:
  //   delta < CARD_CLICK_TOLERANCE_PX AND not currently dragging → open modal
  //   anything bigger → it was a drag, @dnd-kit handles it
  // We can't use a plain `onClick` because dnd-kit's PointerSensor swallows
  // the click that ends a drag, and even short non-drag presses sometimes
  // get classified as drags by the pointer events. So we own click detection.
  const downPosRef = useRef<{ x: number; y: number; t: number } | null>(null);

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
      onPointerDownCapture={(e) => {
        downPosRef.current = { x: e.clientX, y: e.clientY, t: Date.now() };
      }}
      onPointerUp={(e) => {
        const start = downPosRef.current;
        downPosRef.current = null;
        if (!onOpen || !start) return;
        if (isDragging) return;
        const dx = e.clientX - start.x;
        const dy = e.clientY - start.y;
        if (Math.hypot(dx, dy) > CARD_CLICK_TOLERANCE_PX) return;
        // Ignore clicks that originated on inner handlers (the "Open ↗"
        // anchor calls stopPropagation on pointerdown so its event never
        // reaches us). Defer slightly so any in-flight drag-end runs first.
        window.setTimeout(() => onOpen(job), 0);
      }}
      data-stale={stale ? '1' : undefined}
      data-first-stale={isFirstStale ? '1' : undefined}
      className={clsx(
        'group rounded-md border border-slate-200 bg-white p-2 shadow-sm',
        'cursor-grab touch-none ring-0 hover:ring-1 hover:ring-slate-300',
        'active:cursor-grabbing',
        stale && 'border-l-4 border-l-amber-400',
      )}
    >
      <CardContent job={job} stale={stale} />
    </div>
  );
};

const OverlayCard = ({ job, stale }: CardProps) => (
  <div
    className={clsx(
      'rounded-md border border-slate-300 bg-white p-2 shadow-lg ring-1 ring-slate-300',
      'cursor-grabbing',
      'w-[260px]',
      stale && 'border-l-4 border-l-amber-400',
    )}
  >
    <CardContent job={job} stale={stale} />
  </div>
);

// ---- Column ---------------------------------------------------------------

interface ColumnProps {
  status: AppStatus;
  jobs: Job[];
  // ID of the very first stale card across the entire board. The Column
  // tags exactly one card per page render so the "scroll to first stale"
  // affordance has a unique anchor.
  firstStaleId: string | null;
  onOpenCard: (job: Job) => void;
}

const Column = ({ status, jobs, firstStaleId, onOpenCard }: ColumnProps) => {
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
            jobs.map((j) => {
              const stale = isStaleJob(j);
              return (
                <SortableCard
                  key={j.id}
                  job={j}
                  stale={stale}
                  isFirstStale={stale && j.id === firstStaleId}
                  onOpen={onOpenCard}
                />
              );
            })
          )}
        </div>
      </SortableContext>
    </div>
  );
};

// ---- View toggle ----------------------------------------------------------

interface ViewToggleProps {
  view: ViewMode;
  onChange: (next: ViewMode) => void;
}

// Small segmented control. Active button mirrors the brand-tinted style
// used elsewhere in the UI; inactive button is a transparent muted slate.
const ViewToggle = ({ view, onChange }: ViewToggleProps) => {
  const btn = (mode: ViewMode, label: string) => (
    <button
      key={mode}
      type="button"
      onClick={() => onChange(mode)}
      aria-pressed={view === mode}
      className={clsx(
        'rounded px-2.5 py-1 text-xs font-medium transition-colors',
        view === mode
          ? 'bg-slate-100 text-slate-900 shadow-sm'
          : 'bg-transparent text-slate-500 hover:text-slate-800',
      )}
    >
      {label}
    </button>
  );
  return (
    <div className="inline-flex items-center gap-0.5 rounded border border-slate-200 bg-white p-0.5">
      {btn('kanban', 'Kanban')}
      {btn('table', 'Table')}
    </div>
  );
};

// ---- Summary strip --------------------------------------------------------

interface SummaryStripProps {
  counts: Record<AppStatus, number>;
  staleCount: number;
  onClickStale: () => void;
}

// Compact row of count chips, one per visible status. Reads at a glance
// like "applied 3 · screening 2 · …". A separately-styled stale chip
// appends to the right when there's at least one stale row.
const SummaryStrip = ({ counts, staleCount, onClickStale }: SummaryStripProps) => (
  <div className="flex flex-wrap items-center gap-x-1 gap-y-1 text-[11px]">
    {COLUMNS.map((s, i) => {
      const n = counts[s] ?? 0;
      const muted = n === 0;
      return (
        <span key={s} className="inline-flex items-center gap-1">
          {i > 0 && <span className="text-slate-300">·</span>}
          <span
            className={clsx(
              'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 font-medium',
              muted ? 'bg-transparent text-slate-300' : STATUS_CHIP[s],
            )}
            title={`${STATUS_LABEL[s]}: ${n}`}
          >
            <span className="lowercase">{STATUS_LABEL[s]}</span>
            <span className="tabular-nums">{n}</span>
          </span>
        </span>
      );
    })}
    {staleCount > 0 && (
      <>
        <span className="text-slate-300">·</span>
        <button
          type="button"
          onClick={onClickStale}
          className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-1.5 py-0.5 font-medium text-amber-800 hover:bg-amber-200"
          title={`Show stale rows (no movement in ${STALE_DAYS}+ days)`}
        >
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500" />
          {staleCount} stale
        </button>
      </>
    )}
  </div>
);

// ---- Tracker table view ---------------------------------------------------

const trackerColumnHelper = createColumnHelper<Job>();

const TRUNCATE = (s: string, n = 30): string =>
  s.length <= n ? s : s.slice(0, n - 1) + '…';

interface TrackerTableProps {
  jobs: Job[];
  staleOnly: boolean;
  onClearStaleOnly: () => void;
  onOpenRow: (job: Job) => void;
}

// Sortable table view — purposely a smaller, self-contained TanStack Table
// so we don't drag in JobsTable's filter/popover/expand machinery (none of
// it applies here). Default sort = last move desc, matching the kanban
// per-column sort.
const TrackerTable = ({
  jobs, staleOnly, onClearStaleOnly, onOpenRow,
}: TrackerTableProps) => {
  const [sorting, setSorting] = useState<SortingState>([
    { id: 'app_status_at', desc: true },
  ]);

  const data = useMemo(
    () => (staleOnly ? jobs.filter(isStaleJob) : jobs),
    [jobs, staleOnly],
  );

  const columns = useMemo(
    () => [
      trackerColumnHelper.accessor('title', {
        id: 'title',
        header: 'Title',
        cell: (info) => {
          const v = info.getValue() ?? '';
          return (
            <span className="text-slate-800" title={v}>
              {TRUNCATE(v || '(untitled)')}
            </span>
          );
        },
        sortingFn: (a, b) =>
          (a.original.title || '').localeCompare(b.original.title || ''),
      }),
      trackerColumnHelper.accessor('company', {
        id: 'company',
        header: 'Company',
        cell: (info) => (
          <span className="font-medium text-slate-900">
            {info.getValue() || '—'}
          </span>
        ),
        sortingFn: (a, b) =>
          (a.original.company || '').localeCompare(b.original.company || ''),
      }),
      trackerColumnHelper.accessor((r) => r.app_status ?? 'new', {
        id: 'status',
        header: 'Status',
        cell: (info) => {
          const s = (info.row.original.app_status ?? 'new') as AppStatus;
          return (
            <span
              className={clsx(
                'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                STATUS_CHIP[s],
              )}
            >
              {STATUS_LABEL[s]}
            </span>
          );
        },
        sortingFn: (a, b) => {
          const sa = (a.original.app_status ?? 'new') as AppStatus;
          const sb = (b.original.app_status ?? 'new') as AppStatus;
          return APP_STATUS_ORDER_INDEX[sa] - APP_STATUS_ORDER_INDEX[sb];
        },
      }),
      trackerColumnHelper.accessor((r) => r.app_status_at ?? null, {
        id: 'app_status_at',
        header: 'Last move',
        cell: (info) => (
          <span className="text-slate-600">
            {safeRel(info.row.original.app_status_at)}
          </span>
        ),
        sortingFn: (a, b) => {
          const ta = a.original.app_status_at
            ? Date.parse(a.original.app_status_at)
            : 0;
          const tb = b.original.app_status_at
            ? Date.parse(b.original.app_status_at)
            : 0;
          return ta - tb;
        },
      }),
      trackerColumnHelper.accessor((r) => r.rating ?? null, {
        id: 'rating',
        header: 'Rating',
        cell: (info) => {
          const v = info.row.original.rating;
          if (!v) return <span className="text-slate-300">—</span>;
          return (
            <span className="text-amber-500" aria-label={`${v} stars`}>
              {'★'.repeat(v)}
              <span className="text-slate-200">{'★'.repeat(Math.max(0, 5 - v))}</span>
            </span>
          );
        },
        // null sorts last in both directions: spec.
        sortingFn: (a, b) => {
          const ra = a.original.rating;
          const rb = b.original.rating;
          if (ra == null && rb == null) return 0;
          if (ra == null) return 1;
          if (rb == null) return -1;
          return ra - rb;
        },
        sortUndefined: 'last',
      }),
      trackerColumnHelper.accessor((r) => r.fit ?? 'zzz', {
        id: 'fit',
        header: 'Fit',
        cell: (info) => <FitPill fit={info.row.original.fit} />,
        sortingFn: (a, b) => {
          const order: Record<string, number> = { good: 0, ok: 1, skip: 2 };
          const av = a.original.fit ? order[a.original.fit] : 3;
          const bv = b.original.fit ? order[b.original.fit] : 3;
          return av - bv;
        },
      }),
      trackerColumnHelper.display({
        id: 'actions',
        header: 'Actions',
        cell: (info) => {
          const j = info.row.original;
          if (!j.url) return <span className="text-slate-300">—</span>;
          return (
            <a
              href={j.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-0.5 text-xs text-slate-700 hover:bg-brand-50 hover:text-brand-700"
            >
              Open ↗
            </a>
          );
        },
      }),
    ],
    [],
  );

  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <div className="flex h-full flex-col">
      {staleOnly && (
        <div className="flex items-center justify-between border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-xs text-amber-800">
          <span>
            Showing only stale rows ({data.length} of {jobs.length}) — no
            movement in {STALE_DAYS}+ days.
          </span>
          <button
            type="button"
            onClick={onClearStaleOnly}
            className="rounded border border-amber-300 bg-white px-2 py-0.5 font-medium hover:bg-amber-100"
          >
            Show all
          </button>
        </div>
      )}
      <div className="flex-1 overflow-auto bg-white">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-slate-50">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => {
                  const canSort = h.column.getCanSort();
                  const sort = h.column.getIsSorted();
                  return (
                    <th
                      key={h.id}
                      onClick={h.column.getToggleSortingHandler()}
                      className={clsx(
                        'border-b border-slate-200 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-slate-600',
                        canSort && 'cursor-pointer select-none hover:text-brand-700',
                      )}
                    >
                      <span className="inline-flex items-center gap-1">
                        {flexRender(h.column.columnDef.header, h.getContext())}
                        {sort === 'asc' && '▲'}
                        {sort === 'desc' && '▼'}
                      </span>
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => {
              const j = row.original;
              const stale = isStaleJob(j);
              return (
                <tr
                  key={j.id}
                  data-stale={stale ? '1' : undefined}
                  // Click-anywhere-but-actions opens the application detail
                  // modal — same affordance as the kanban cards. The "Open ↗"
                  // action cell calls stopPropagation on its inner link so
                  // users can still jump straight to LinkedIn from the table.
                  onClick={() => onOpenRow(j)}
                  className={clsx(
                    'cursor-pointer border-b border-slate-100 hover:bg-slate-50',
                    stale && 'border-l-4 border-l-amber-400',
                  )}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="px-3 py-2 align-middle">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              );
            })}
            {data.length === 0 && (
              <tr>
                <td
                  colSpan={columns.length}
                  className="px-6 py-12 text-center text-sm text-slate-500"
                >
                  {staleOnly ? 'No stale rows.' : 'No applications tracked yet.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// Lookup of APP_STATUS_ORDER index for sorting. Imported from types so
// the canonical order stays single-source.
const APP_STATUS_ORDER_INDEX: Record<AppStatus, number> = (() => {
  const out = {} as Record<AppStatus, number>;
  APP_STATUS_ORDER.forEach((s, i) => {
    out[s] = i;
  });
  return out;
})();

// ---- Application detail modal --------------------------------------------

const TITLE_TRUNC = 50;
const truncateTitle = (s: string, n = TITLE_TRUNC): string =>
  s.length <= n ? s : s.slice(0, n - 1) + '…';

interface AppDetailModalProps {
  job: Job;
  onClose: () => void;
  // Persists app_notes (tri-state on the wire — see hooks.ts setAppStatus).
  // The modal owns the autosave debounce + flush-on-blur + flush-on-unmount
  // pattern, so it just needs a simple promise-returning setter here.
  onSaveNotes: (
    id: string,
    status: AppStatus,
    note: string | null,
  ) => Promise<{ ok: boolean; error?: string }>;
  // Status changes via the quick-select dropdown. Same setAppStatus call,
  // but separated out so the page-level optimistic move logic can run
  // (mirror of the drag-end handler — no double-history-entry concerns
  // because the backend de-dupes same-status writes).
  onChangeStatus: (
    id: string,
    next: AppStatus,
  ) => Promise<{ ok: boolean; error?: string }>;
}

// Centered overlay modal — picked over an anchored popover because it
// reads better on the iPhone width (the spec calls this out). Click on
// the backdrop or Escape closes; the autosave flush runs in the unmount
// effect so closing never drops a pending edit.
//
// Mirrors the rating-comment editor in JobActionsPopover.tsx exactly:
//   - 600ms debounced autosave on textarea change
//   - flush on blur (cancels the debounce, saves immediately)
//   - flush on unmount (best-effort fire-and-forget)
//   - status indicator: saving… / saved / save failed / unsaved / N/MAX
//   - empty / whitespace-only normalizes to null = clears app_notes
const AppDetailModal = ({
  job, onClose, onSaveNotes, onChangeStatus,
}: AppDetailModalProps) => {
  const status = (job.app_status ?? 'new') as AppStatus;

  // Notes editor state. `notesDraft` is what the user is typing;
  // `notesSaved` is the last value successfully persisted (used to decide
  // whether a blur/unmount flush actually has unsaved work).
  const initialNotes = job.app_notes ?? '';
  const [notesDraft, setNotesDraft] = useState<string>(initialNotes);
  const [notesSaved, setNotesSaved] = useState<string>(initialNotes);
  const [saveStatus, setSaveStatus] =
    useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveErr, setSaveErr] = useState<string | null>(null);

  // Debounce + saved-fade timers. Cleared in the unmount effect.
  const debounceRef = useRef<number | null>(null);
  const savedFadeRef = useRef<number | null>(null);

  // Refs used by the unmount-flush so it sees the latest values without
  // re-binding the cleanup effect (same pattern as JobActionsPopover).
  const draftRef = useRef(notesDraft);
  draftRef.current = notesDraft;
  const savedRef = useRef(notesSaved);
  savedRef.current = notesSaved;
  const statusRef = useRef(status);
  statusRef.current = status;

  // Status-change loading state for the quick-select dropdown.
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusErr, setStatusErr] = useState<string | null>(null);

  // ---- Backdrop click + Escape close ----
  // Backdrop click: only close when the click target IS the backdrop (so
  // clicks inside the modal panel don't bubble up and dismiss it). Escape
  // closes from anywhere — the unmount-flush picks up any pending notes.
  const backdropRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Persist the current notes draft. Used by both the debounced autosave
  // and the blur/unmount flush. No-op when nothing is dirty.
  const saveNotes = useCallback(
    async (text: string) => {
      if (text === savedRef.current) return; // no change
      setSaveStatus('saving');
      // Empty (or whitespace-only) → null = clear server-side. Mirrors the
      // backend's tri-state contract (undefined = don't touch, null = clear,
      // string = set).
      const payload: string | null = text.trim() === '' ? null : text;
      const r = await onSaveNotes(job.id, statusRef.current, payload);
      if (r.ok) {
        setSaveStatus('saved');
        setSaveErr(null);
        setNotesSaved(text);
        if (savedFadeRef.current) window.clearTimeout(savedFadeRef.current);
        savedFadeRef.current = window.setTimeout(
          () => setSaveStatus('idle'), 1500,
        );
      } else {
        setSaveStatus('error');
        setSaveErr(r.error || 'notes save failed');
      }
    },
    [job.id, onSaveNotes],
  );

  // On unmount: clear timers + flush any pending edit. Best-effort
  // (fire-and-forget — we can't await a React unmount). Same shape as
  // JobActionsPopover's comment unmount-flush.
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      if (savedFadeRef.current) {
        window.clearTimeout(savedFadeRef.current);
        savedFadeRef.current = null;
      }
      if (draftRef.current !== savedRef.current) {
        void saveNotes(draftRef.current);
      }
    };
  }, [saveNotes]);

  const handleNotesChange = (text: string) => {
    setNotesDraft(text);
    setSaveStatus('idle');
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      void saveNotes(text);
      debounceRef.current = null;
    }, NOTES_AUTOSAVE_MS);
  };

  const handleNotesBlur = () => {
    if (debounceRef.current) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    void saveNotes(notesDraft);
  };

  const handleStatusChange = async (next: AppStatus) => {
    if (next === status) return;
    setStatusBusy(true);
    setStatusErr(null);
    const r = await onChangeStatus(job.id, next);
    setStatusBusy(false);
    if (!r.ok) {
      setStatusErr(r.error || 'status change failed');
    } else {
      // Page-level reload (via the corpus-stale event fired by useAppStatus)
      // will re-render with the new status; we close so the user sees the
      // card jump to its new column rather than having a stale snapshot.
      onClose();
    }
  };

  // Status history list: most-recent first, distance from now. Server
  // appends on every transition, so the list reads as a timeline of moves.
  const history = (job.app_status_history ?? []).slice().reverse();

  return (
    <div
      ref={backdropRef}
      role="presentation"
      onClick={(e) => {
        if (e.target === backdropRef.current) onClose();
      }}
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 px-2 pb-2 sm:items-center sm:p-4"
    >
      <div
        role="dialog"
        aria-label="Application details"
        aria-modal="true"
        className="flex w-full max-w-lg flex-col overflow-hidden rounded-t-lg bg-white shadow-xl sm:rounded-lg"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-4 py-3">
          <div className="min-w-0">
            <div
              className="truncate text-sm font-semibold text-slate-900"
              title={job.title}
            >
              {truncateTitle(job.title || '(untitled)')}
            </div>
            <div className="mt-0.5 truncate text-xs text-slate-500" title={job.company}>
              {job.company || '—'}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
              <span
                className={clsx(
                  'inline-flex items-center rounded-full px-2 py-0.5 font-medium',
                  STATUS_CHIP[status],
                )}
              >
                {STATUS_LABEL[status]}
              </span>
              <span className="text-slate-400">
                moved {safeRel(job.app_status_at)}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="-mr-1 rounded px-2 py-1 text-lg leading-none text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* Body — scrollable on small viewports */}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {/* Notes textarea */}
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label
                htmlFor={`app-notes-${job.id}`}
                className="text-[11px] font-semibold uppercase tracking-wider text-slate-500"
              >
                Notes
              </label>
              <span
                className={clsx(
                  'text-[10px]',
                  saveStatus === 'saving' && 'text-slate-400',
                  saveStatus === 'saved' && 'text-emerald-600',
                  saveStatus === 'error' && 'text-red-600',
                  saveStatus === 'idle' && 'text-slate-300',
                )}
                aria-live="polite"
              >
                {saveStatus === 'saving' && 'saving…'}
                {saveStatus === 'saved' && 'saved'}
                {saveStatus === 'error' && 'save failed'}
                {saveStatus === 'idle' && notesDraft !== notesSaved && 'unsaved'}
                {saveStatus === 'idle' && notesDraft === notesSaved &&
                  `${notesDraft.length}/${NOTES_MAX}`}
              </span>
            </div>
            <textarea
              id={`app-notes-${job.id}`}
              value={notesDraft}
              onChange={(e) => handleNotesChange(e.target.value.slice(0, NOTES_MAX))}
              onBlur={handleNotesBlur}
              rows={5}
              placeholder="Recruiter pinged me Friday, interview rescheduled, take-home due Tue…"
              className="w-full resize-y rounded border border-slate-200 px-2 py-1.5 text-sm text-slate-800 placeholder:text-slate-300 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
            {saveErr && (
              <div className="mt-1 rounded bg-red-50 px-2 py-1 text-[11px] text-red-700">
                {saveErr}
              </div>
            )}
          </div>

          {/* Status history */}
          {history.length > 0 && (
            <div className="mt-4">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                History
              </div>
              <ol className="space-y-1 text-xs text-slate-600">
                {history.map((h, i) => (
                  <li key={`${h.at}-${i}`} className="flex items-center gap-2">
                    <span
                      className={clsx(
                        'inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium',
                        STATUS_CHIP[(h.status ?? 'new') as AppStatus],
                      )}
                    >
                      {STATUS_LABEL[(h.status ?? 'new') as AppStatus]}
                    </span>
                    <span className="text-slate-400">{safeRel(h.at)}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>

        {/* Footer — quick actions */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 bg-slate-50 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <label
              htmlFor={`app-status-${job.id}`}
              className="text-[11px] font-medium text-slate-500"
            >
              Move to
            </label>
            <select
              id={`app-status-${job.id}`}
              value={status}
              disabled={statusBusy}
              onChange={(e) => void handleStatusChange(e.target.value as AppStatus)}
              className="rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-800 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:opacity-50"
            >
              {COLUMNS.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
              {/* `new` is the unset/default state hidden from the kanban —
                  selecting it removes the job from the tracker (status
                  history is preserved server-side). Same as un-checking
                  "Applied" in the Corpus tab. */}
              <option value="new">— Remove from tracker</option>
            </select>
            {statusErr && (
              <span className="text-[11px] text-red-600">{statusErr}</span>
            )}
          </div>
          {job.url ? (
            <a
              href={job.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-brand-50 hover:text-brand-700"
            >
              Open ↗
            </a>
          ) : (
            <span className="text-[11px] text-slate-400">no URL</span>
          )}
        </div>
      </div>
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

  // Stage 3-C: kanban/table toggle, persisted to localStorage so reloads
  // remember the user's pick. URL ?view=… overrides for linking + smokes.
  const [view, setView] = useState<ViewMode>(() => readInitialView());
  // Filter the table to stale-only when the user clicks the "stale" chip.
  // Kanban scrolls instead — see scrollToFirstStale().
  const [staleOnly, setStaleOnly] = useState(false);

  // Application detail modal — tracks the currently-open card by id (null
  // = closed). Both kanban and table click handlers set this. The modal
  // resolves the live job from `cards` so any in-flight server reload
  // re-renders it with the freshest data (no stale snapshot in modal state).
  const [openDetailFor, setOpenDetailFor] = useState<string | null>(null);

  const setViewPersisted = useCallback((next: ViewMode) => {
    setView(next);
    try {
      window.localStorage.setItem(VIEW_LOCALSTORAGE_KEY, next);
    } catch {
      /* localStorage blocked — non-fatal */
    }
    // Clear stale-only when switching views — its meaning is per-view.
    setStaleOnly(false);
  }, []);

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
    // Mouse / trackpad: 5px activation distance avoids hijacking clicks on
    // the "Open ↗" link or the card-tap-to-open-modal handler.
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
    // Touch (iPhone / iPad): require a 200ms long-press before drag starts.
    // Quick swipes pass through to native scroll — without this, any vertical
    // touch-move > 5px hijacks scroll and turns it into a drag, which makes
    // a tall column (e.g. Applied with 13+ cards) un-scrollable on phone.
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 5 },
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

  // ---- Counts + stale derivation ----
  // Per-status counts feed the SummaryStrip; stale list feeds the chip
  // count and the kanban "scroll to first stale" handler. Both derived
  // from the same `cards` Map — no duplicated grouping pass.
  const counts = useMemo(() => {
    const out: Record<AppStatus, number> = {
      new: 0, applied: 0, screening: 0, interview: 0,
      'take-home': 0, offer: 0, rejected: 0, withdrew: 0,
    };
    for (const s of COLUMNS) out[s] = (cards.get(s) ?? []).length;
    return out;
  }, [cards]);

  const totalActive = useMemo(
    () => COLUMNS.reduce((acc, s) => acc + (counts[s] ?? 0), 0),
    [counts],
  );

  // Flat list of all jobs across columns (used by the table view + stale
  // detection). Order doesn't matter — TanStack Table sorts it.
  const allJobs = useMemo(
    () => COLUMNS.flatMap((s) => cards.get(s) ?? []),
    [cards],
  );

  const staleJobs = useMemo(() => allJobs.filter(isStaleJob), [allJobs]);
  const firstStaleId = staleJobs.length > 0 ? staleJobs[0].id : null;

  const scrollToFirstStale = useCallback(() => {
    if (view === 'table') {
      // In table view, "stale chip" filters instead of scrolls.
      setStaleOnly((cur) => !cur);
      return;
    }
    if (!firstStaleId) return;
    // Defer to next tick so any layout changes from the chip click settle.
    window.setTimeout(() => {
      const el = document.querySelector(
        `[data-first-stale="1"]`,
      ) as HTMLElement | null;
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 0);
  }, [view, firstStaleId]);

  const pageEmpty = loadState === 'ok' && totalActive === 0;

  // Resolve the currently-open card to a live Job from the cards Map.
  // We don't memoize the openDetailJob from a stale snapshot — re-derived
  // every render so a corpus-stale reload propagates into the modal
  // (e.g. notes saved on one card are immediately reflected if the user
  // re-opens it).
  const openDetailJob: Job | null = openDetailFor
    ? allJobs.find((j) => j.id === openDetailFor) ?? null
    : null;
  // If the underlying job vanished (deleted, status changed to "new"), close.
  useEffect(() => {
    if (openDetailFor && !openDetailJob) {
      setOpenDetailFor(null);
    }
  }, [openDetailFor, openDetailJob]);

  const handleOpenCard = useCallback((j: Job) => {
    setOpenDetailFor(j.id);
  }, []);

  // Wrapper around setAppStatus used by the modal's "Move to" select.
  // Mirrors the optimistic-move logic in handleDragEnd so the kanban
  // updates without waiting for a server round-trip.
  const handleChangeStatusFromModal = useCallback(
    async (id: string, next: AppStatus) => {
      const found = findJob(id);
      if (!found) return { ok: false, error: 'card not found' };
      if (found.status === next) return { ok: true };
      const prevCards = cards;
      const nextMap = new Map(cards);
      const fromArr = (nextMap.get(found.status) ?? []).filter(
        (x) => x.id !== id,
      );
      const movedJob: Job = {
        ...found.job,
        app_status: next,
        app_status_at: new Date().toISOString(),
      };
      const toArr = [movedJob, ...(nextMap.get(next) ?? [])];
      nextMap.set(found.status, fromArr);
      nextMap.set(next, toArr);
      setCards(nextMap);
      const r = await setAppStatus(id, next);
      if (!r.ok) {
        setCards(prevCards);
        showToast(`Couldn't change status: ${r.error ?? 'unknown error'}`, 'err');
      }
      return r;
    },
    [cards, findJob, setAppStatus, showToast],
  );

  return (
    <div className="flex h-full flex-col">
      {/* Top bar */}
      <div className="flex flex-col gap-2 border-b border-slate-200 bg-white px-4 py-2.5">
        <div className="flex items-center justify-between gap-3">
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
          {/* Stage 3-C right-side controls: view toggle + Refresh. */}
          <div className="flex items-center gap-2">
            <ViewToggle view={view} onChange={setViewPersisted} />
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
        {/* Per-stage summary strip — only shown when there's something to
            summarize (skip the empty-state and error views). */}
        {loadState === 'ok' && totalActive > 0 && (
          <SummaryStrip
            counts={counts}
            staleCount={staleJobs.length}
            onClickStale={scrollToFirstStale}
          />
        )}
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
      ) : view === 'table' ? (
        <TrackerTable
          jobs={allJobs}
          staleOnly={staleOnly}
          onClearStaleOnly={() => setStaleOnly(false)}
          onOpenRow={handleOpenCard}
        />
      ) : (
        <div className="flex-1 overflow-x-auto overflow-y-auto bg-slate-50">
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
                  firstStaleId={firstStaleId}
                  onOpenCard={handleOpenCard}
                />
              ))}
            </div>
            <DragOverlay>
              {activeJob ? (
                <OverlayCard job={activeJob} stale={isStaleJob(activeJob)} />
              ) : null}
            </DragOverlay>
          </DndContext>
        </div>
      )}

      {toast && <Toast msg={toast} />}

      {openDetailJob && (
        <AppDetailModal
          key={openDetailJob.id}
          job={openDetailJob}
          onClose={() => setOpenDetailFor(null)}
          onSaveNotes={(id, status, note) => setAppStatus(id, status, note)}
          onChangeStatus={handleChangeStatusFromModal}
        />
      )}
    </div>
  );
};

export default ApplicationsPage;
