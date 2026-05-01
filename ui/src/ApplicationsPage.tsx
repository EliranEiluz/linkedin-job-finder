import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
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
import { useAppStatus, useCorpusActions } from './hooks';
import { Dot } from './Dot';
import { useViewport } from './useViewport';
import {
  COLUMNS,
  STALE_DAYS,
  STATUS_ACCENT,
  STATUS_BLURB,
  STATUS_CHIP,
  STATUS_DOT,
  STATUS_LABEL,
  isStaleJob,
  safeRel,
} from './applications/constants';
import { AppDetailModal } from './applications/AppDetailModal';

// ---- Constants ------------------------------------------------------------
// Stage labels, chip styles, stale-detection, and the Notes editor knobs
// live in ./applications/constants — shared with AppDetailModal.

const RESULTS_URL = `${import.meta.env.BASE_URL}results.json`;

const APPLIED_LOCALSTORAGE_KEY = 'linkedinjobs:applied';
const APPLIED_IMPORTED_FLAG_KEY = 'linkedinjobs:applied-imported-v1';

// Persistence key for the kanban/table toggle. Keep aligned with the
// other UI prefs under the `linkedinjobs:` namespace.
const VIEW_LOCALSTORAGE_KEY = 'linkedinjobs:tracker-view';
type ViewMode = 'kanban' | 'table';

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
// safeRel + isStaleJob live in ./applications/constants for the modal too.

const fetchJobs = async (): Promise<Job[]> => {
  const res = await fetch(`${RESULTS_URL}?t=${Date.now().toString()}`);
  if (!res.ok) throw new Error(`HTTP ${res.status.toString()}`);
  const text = await res.text();
  if (!text.trim()) return [];
  const data: unknown = JSON.parse(text);
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

// FitPill — neutralized to slate background + semantic dot, matching the
// JobsTable fit badge. Keeps the column-accent semantics elsewhere on the
// kanban intact.
const FitPill = ({ fit }: { fit: Job['fit'] }) => {
  if (fit === 'good')
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-1.5 py-0 text-[10px] font-medium text-slate-700">
        <Dot color="good" /> good
      </span>
    );
  if (fit === 'ok')
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-1.5 py-0 text-[10px] font-medium text-slate-700">
        <Dot color="warn" /> ok
      </span>
    );
  if (fit === 'skip')
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-1.5 py-0 text-[10px] font-medium text-slate-600">
        <Dot color="neutral" /> skip
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
    <div className="truncate text-base font-semibold leading-snug text-slate-900" title={job.title}>
      {job.title || '(untitled)'}
    </div>
    <div
      className="mt-1 truncate text-xs text-slate-500"
      title={job.company}
    >
      {job.company || '—'}
    </div>
    <div className="mt-2 flex items-center gap-1.5 text-[11px] text-slate-400">
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
    <div className="mt-2.5 flex items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-1.5">
        <RatingStars rating={job.rating} />
        <FitPill fit={job.fit} />
      </div>
      {job.url && (
        <a
          href={job.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => { e.stopPropagation(); }}
          onPointerDown={(e) => { e.stopPropagation(); }}
          className="shrink-0 text-[11px] font-medium text-brand-700 hover:underline"
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
        window.setTimeout(() => { onOpen(job); }, 0);
      }}
      data-stale={stale ? '1' : undefined}
      data-first-stale={isFirstStale ? '1' : undefined}
      className={clsx(
        'group rounded-lg border border-slate-200 bg-white p-3.5 shadow-sm',
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
      'rounded-lg border border-slate-300 bg-white p-3.5 shadow-lg ring-1 ring-slate-300',
      'cursor-grabbing',
      'w-[320px]',
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
    // Mobile: 85vw column with scroll-snap so a peek of the next column is
    // visible and the user knows to swipe horizontally. Desktop (md+): the
    // original fixed-width layout (320px / min 300 / max 340) so 4-5 columns
    // fit on a 1440px viewport.
    <div
      className={clsx(
        'flex shrink-0 flex-col snap-start',
        'w-[85vw] max-w-[300px]',
        'md:w-[320px] md:min-w-[300px] md:max-w-[340px]',
      )}
    >
      {/* Sticky header */}
      <div className="sticky top-0 z-10 bg-slate-50 pb-2">
        <div className="flex items-center justify-between px-1">
          <div className="flex items-center gap-1.5">
            <span
              className="cursor-help text-sm font-semibold text-slate-800"
              title={STATUS_BLURB[status]}
            >
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
      onClick={() => { onChange(mode); }}
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
const SummaryStrip = ({ counts, staleCount, onClickStale }: SummaryStripProps) => {
  const { isMobile } = useViewport();
  // On mobile the strip wrapped to two lines; zero-count chips were just
  // visual noise. Filter them out on mobile so the strip stays compact.
  // Desktop still shows muted zero-count chips (the at-a-glance use case).
  const visible = COLUMNS.filter((s) => !(isMobile && counts[s] === 0));
  return (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-1 text-[11px]">
      {visible.map((s, i) => {
        const n = counts[s];
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
              {!muted && <Dot color={STATUS_DOT[s]} />}
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
};

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
          const v = info.getValue();
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
          const s = (info.row.original.app_status ?? 'new');
          return (
            <span
              className={clsx(
                'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium',
                STATUS_CHIP[s],
              )}
            >
              <Dot color={STATUS_DOT[s]} />
              {STATUS_LABEL[s]}
            </span>
          );
        },
        sortingFn: (a, b) => {
          const sa = (a.original.app_status ?? 'new');
          const sb = (b.original.app_status ?? 'new');
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
          const av = (a.original.fit ? order[a.original.fit] : undefined) ?? 3;
          const bv = (b.original.fit ? order[b.original.fit] : undefined) ?? 3;
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
              onClick={(e) => { e.stopPropagation(); }}
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
        {/* min-w-[800px] forces all 7 columns to render at their natural
            width on narrow viewports; the parent's overflow-auto then gives
            the user a horizontal scrollbar to reach Rating / Fit / Actions.
            Without this, the table would silently clip the rightmost cells
            on iPhone width and the "Open ↗" link would be unreachable. */}
        <table className="w-full min-w-[800px] border-collapse text-sm">
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
                  onClick={() => { onOpenRow(j); }}
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
  const { rateJob } = useCorpusActions();

  // ---- Toast helper ----
  const showToast = useCallback(
    (text: string, kind: 'ok' | 'err' = 'ok') => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
      const id = Date.now();
      setToast({ id, text, kind });
      toastTimerRef.current = window.setTimeout(() => {
        setToast((cur) => (cur?.id === id ? null : cur));
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
    return () => { window.removeEventListener('linkedinjobs:corpus-stale', onStale); };
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
          const parsed: unknown = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            ids = parsed.filter((x): x is string => typeof x === 'string');
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
    // Touch (iPhone / iPad): require a 350ms long-press before drag starts.
    // Quick swipes pass through to native scroll — without this, any vertical
    // touch-move > 5px hijacks scroll and turns it into a drag, which makes
    // a tall column (e.g. Applied with 13+ cards) un-scrollable on phone.
    // We picked 350ms (up from 200ms) deliberately: the lower threshold still
    // let stray vertical drags hijack scroll on tall columns. The "right" fix
    // is to disable in-column reorder on mobile and only accept cross-column
    // drops, but that's a bigger refactor (custom collision detection +
    // sortable-strategy swap) — bumping the long-press is the cheap win.
    useSensor(TouchSensor, {
      activationConstraint: { delay: 350, tolerance: 5 },
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
    () => COLUMNS.reduce((acc, s) => acc + counts[s], 0),
    [counts],
  );

  // Flat list of all jobs across columns (used by the table view + stale
  // detection). Order doesn't matter — TanStack Table sorts it.
  const allJobs = useMemo(
    () => COLUMNS.flatMap((s) => cards.get(s) ?? []),
    [cards],
  );

  const staleJobs = useMemo(() => allJobs.filter(isStaleJob), [allJobs]);
  const firstStaleId = staleJobs[0]?.id ?? null;

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
      );
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
              Drag cards across stages, or use Move to in the detail modal. Cards turn stale after 14 days without
              movement in active stages.
            </p>
            {(loadState === 'loading' || loadState === 'error') && (
              <p className="text-xs text-slate-500">
                {loadState === 'loading'
                  ? 'loading…'
                  : `failed to load: ${errorMsg}`}
              </p>
            )}
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
          onClearStaleOnly={() => { setStaleOnly(false); }}
          onOpenRow={handleOpenCard}
        />
      ) : (
        <div className="flex-1 snap-x snap-mandatory overflow-x-auto overflow-y-auto bg-slate-50 md:snap-none">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragEnd={(e) => { void handleDragEnd(e); }}
            onDragCancel={() => { setActiveJob(null); }}
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
          onClose={() => { setOpenDetailFor(null); }}
          onSaveNotes={(id, status, note) => setAppStatus(id, status, note)}
          onChangeStatus={handleChangeStatusFromModal}
          onRate={(id, rating, comment) => rateJob(id, rating, comment)}
        />
      )}
    </div>
  );
};

export default ApplicationsPage;
