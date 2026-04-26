import { Fragment, useCallback, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { formatDistanceToNowStrict, parseISO } from 'date-fns';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
} from '@tanstack/react-table';
import type { Job } from './types';
import { JobActionsPopover } from './JobActionsPopover';

const fitBadge = (fit: Job['fit']) => {
  if (fit === 'good')
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800">
        ✓ good
      </span>
    );
  if (fit === 'ok')
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
        ~ ok
      </span>
    );
  if (fit === 'skip')
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-slate-200 px-2 py-0.5 text-xs font-medium text-slate-600">
        ✗ skip
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
      — unscored
    </span>
  );
};

const relTime = (iso: string) => {
  try {
    return formatDistanceToNowStrict(parseISO(iso), { addSuffix: true });
  } catch {
    return iso;
  }
};

// Display label for a category id. Known legacy ids get tight aliases;
// anything else (user-defined categories from config.json) renders the id
// as-is, just de-snaked for readability.
const LEGACY_CAT_ALIAS: Record<string, string> = {
  crypto: 'crypto',
  security_researcher: 'security',
  company: 'company',
};
const catLabel = (id: string): string =>
  LEGACY_CAT_ALIAS[id] ?? id.replace(/[_-]+/g, ' ');

// Tooltip strings for cryptic chips. Native title="" — no Radix dep.
export const TOOLTIPS = {
  sourceLoggedin: 'Job scraped via Playwright + saved LinkedIn session',
  sourceGuest: 'Job scraped via the unauthenticated /jobs-guest API',
  sourceUnknown: 'Scraped before mode-tagging existed (mid-April 2026)',
  priority: 'Company is on your priority_companies list (Crawler Config)',
  scoredClaude: 'Scored by Claude — ranked your CV vs the job description',
  scoredRegex: 'Scored by the regex fallback (when Claude was unavailable)',
  scoredTitleFilter: 'Dropped by the off-topic title pre-filter — never sent to Claude',
  scoredNone: 'Not scored yet — ran with --no-enrich or fetch failed',
} as const;

const sourceChip = (source: Job['source']) => {
  if (source === 'loggedin')
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-800"
        title={TOOLTIPS.sourceLoggedin}
      >
        🔐 logged-in
      </span>
    );
  if (source === 'guest')
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800"
        title={TOOLTIPS.sourceGuest}
      >
        🌐 guest
      </span>
    );
  return (
    <span className="text-xs text-slate-400" title={TOOLTIPS.sourceUnknown}>
      —
    </span>
  );
};

const columnHelper = createColumnHelper<Job>();

interface Props {
  data: Job[];
  applied: Set<string>;
  onToggleApplied: (id: string) => void;
  // Bulk-set applied state on a list of ids. Wired from CorpusPage; when
  // present, the Applied column header becomes an indeterminate checkbox
  // that bulk-toggles every visible row.
  onSetAppliedMany?: (ids: string[], applied: boolean) => void;
  // Corpus mutations exposed from CorpusPage's useCorpusActions(). When
  // both are provided, clicking "Open ↗" pops over the row-actions menu
  // (rate / delete / re-toggle applied) AFTER opening the new tab.
  onRate?: (id: string, rating: number | null) =>
    Promise<{ ok: boolean; error?: string }>;
  onDelete?: (id: string) =>
    Promise<{ ok: boolean; error?: string }>;
  // category-id → human-readable name from /api/config. When provided, the
  // Category column renders the name ("Security") instead of the de-snaked
  // id ("Cat Mobyb81c 5").
  categoryNamesById?: Map<string, string>;
  // Optional richer empty-state — when the table renders 0 rows, this node
  // is shown instead of the default "No jobs match…" line. CorpusPage wires
  // active-filter chips + a "Clear filters" CTA here.
  emptyState?: React.ReactNode;
  // ID of the keyboard-cursor row; rendered with a brand-colored left ring.
  // Wired from CorpusPage's B4 keyboard nav.
  cursorRowId?: string | null;
}

export const JobsTable = ({
  data, applied, onToggleApplied, onSetAppliedMany, onRate, onDelete,
  categoryNamesById, emptyState, cursorRowId,
}: Props) => {
  // Single popover instance at table level — anchor element is set when
  // the user clicks an Open button on a specific row.
  const [popoverState, setPopoverState] = useState<
    { jobId: string; anchor: HTMLElement } | null
  >(null);
  const popoverAnchorRef = useRef<HTMLElement | null>(null);
  popoverAnchorRef.current = popoverState?.anchor ?? null;

  // Initial sort: applied first (asc — open jobs above applied), then the
  // user's three "good defaults" beneath it. Updates to `sorting` go through
  // `setSortingPinned` (below) which always re-prepends the applied entry,
  // so it stays as the primary key even when the user clicks a different
  // column header. See bug fix 2026-04-23: the previous data-pre-sort was
  // overridden by TanStack's column sort the moment the user re-sorted.
  const [sorting, setSorting] = useState<SortingState>([
    { id: 'applied', desc: false },
    { id: 'priority', desc: true },
    { id: 'score', desc: true },
    { id: 'found_at', desc: true },
  ]);
  // Wraps setSorting so the applied pin is preserved across user re-sorts.
  const setSortingPinned: React.Dispatch<React.SetStateAction<SortingState>> =
    useCallback((updater) => {
      setSorting((prev) => {
        const next = typeof updater === 'function'
          ? (updater as (s: SortingState) => SortingState)(prev)
          : updater;
        const withoutPin = next.filter((s) => s.id !== 'applied');
        return [{ id: 'applied', desc: false }, ...withoutPin];
      });
    }, []);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState<string | null>(null);
  // Inline-delete: first click puts the row's button into "confirm?" state
  // for 4s; second click within that window fires onDelete. Same single-
  // click-confirm pattern as JobActionsPopover, just available without
  // opening the popover first.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const confirmDeleteTimerRef = useRef<number | null>(null);
  const handleInlineDelete = useCallback(
    (id: string) => {
      if (!onDelete) return;
      if (confirmDeleteId === id) {
        if (confirmDeleteTimerRef.current) {
          window.clearTimeout(confirmDeleteTimerRef.current);
          confirmDeleteTimerRef.current = null;
        }
        setConfirmDeleteId(null);
        void onDelete(id);
        return;
      }
      if (confirmDeleteTimerRef.current) {
        window.clearTimeout(confirmDeleteTimerRef.current);
      }
      setConfirmDeleteId(id);
      confirmDeleteTimerRef.current = window.setTimeout(() => {
        setConfirmDeleteId(null);
        confirmDeleteTimerRef.current = null;
      }, 4000);
    },
    [confirmDeleteId, onDelete],
  );

  const columns = useMemo(
    () => [
      columnHelper.accessor('priority', {
        header: '!',
        cell: (info) => {
          if (!info.getValue()) return '';
          // B9: desaturate 🔥 when fit=skip — the company is on the priority
          // list but Claude already triaged it as "skip" so it's a low-value
          // target. Stays visible but visually demoted.
          const isSkip = info.row.original.fit === 'skip';
          return (
            <span
              className={clsx(isSkip && 'text-slate-400 opacity-50')}
              title={TOOLTIPS.priority}
            >
              🔥
            </span>
          );
        },
        sortingFn: (a, b) =>
          Number(a.original.priority) - Number(b.original.priority),
        size: 32,
      }),
      // Accessor (NOT display) — TanStack ignores sortingFn on display
      // columns because its sort engine calls getValue() first. The
      // accessorFn closes over the live `applied` Set; when the set
      // mutates, the parent useMemo re-creates the column defs and
      // TanStack re-sorts. Pinned as the first sort key elsewhere so
      // applied jobs always sink to the bottom.
      columnHelper.accessor((r) => (applied.has(r.id) ? 1 : 0), {
        id: 'applied',
        // Header is an indeterminate checkbox that bulk-toggles applied
        // for every visible row. State is derived from the table's
        // current row model so it stays accurate as filters change.
        header: ({ table }) => {
          const visible = table.getRowModel().rows.map((r) => r.original.id);
          const visibleApplied = visible.filter((id) => applied.has(id)).length;
          const allApplied = visible.length > 0 && visibleApplied === visible.length;
          const someApplied = visibleApplied > 0 && !allApplied;
          const refSet = (el: HTMLInputElement | null) => {
            if (el) el.indeterminate = someApplied;
          };
          return (
            <span className="inline-flex items-center gap-1.5">
              <input
                type="checkbox"
                ref={refSet}
                checked={allApplied}
                disabled={!onSetAppliedMany || visible.length === 0}
                onChange={() => {
                  if (!onSetAppliedMany) return;
                  onSetAppliedMany(visible, !allApplied);
                }}
                onClick={(e) => e.stopPropagation()}
                className="h-3.5 w-3.5 cursor-pointer rounded border-slate-300 text-emerald-600 focus:ring-emerald-600 disabled:opacity-40"
                title={
                  visible.length === 0
                    ? 'No rows visible'
                    : allApplied
                    ? `Mark all ${visible.length} visible as not applied`
                    : `Mark all ${visible.length} visible as applied`
                }
                aria-label="Bulk-toggle applied for visible rows"
              />
              <span>Applied</span>
            </span>
          );
        },
        cell: (info) => {
          const j = info.row.original;
          const isApplied = applied.has(j.id);
          return (
            <label
              className="inline-flex cursor-pointer items-center gap-1.5"
              onClick={(e) => e.stopPropagation()}
            >
              <input
                type="checkbox"
                checked={isApplied}
                onChange={() => onToggleApplied(j.id)}
                className="h-4 w-4 cursor-pointer rounded border-slate-300 text-emerald-600 focus:ring-emerald-600"
                title={isApplied ? 'Mark as not applied' : 'Mark as applied'}
              />
              {isApplied && (
                <span className="text-xs font-medium text-emerald-700">✓</span>
              )}
            </label>
          );
        },
        size: 76,
        enableSorting: true,
        // 'basic' = numeric comparison; works on the 0/1 accessor output.
        sortingFn: 'basic',
      }),
      columnHelper.accessor('company', {
        header: 'Company',
        cell: (info) => (
          <span className="font-medium text-slate-900">{info.getValue()}</span>
        ),
      }),
      columnHelper.accessor('title', {
        header: 'Title',
        cell: (info) => (
          <span className="text-slate-800">{info.getValue()}</span>
        ),
      }),
      columnHelper.accessor('location', {
        header: 'Location',
        cell: (info) => (
          <span className="text-slate-600">{info.getValue() || '—'}</span>
        ),
      }),
      columnHelper.accessor((r) => r.fit ?? 'zzz_unscored', {
        id: 'fit',
        header: 'Fit',
        cell: (info) => fitBadge(info.row.original.fit),
        sortingFn: (a, b) => {
          const order = { good: 0, ok: 1, skip: 2 };
          const av = a.original.fit ? order[a.original.fit] : 3;
          const bv = b.original.fit ? order[b.original.fit] : 3;
          return av - bv;
        },
      }),
      // Map null → undefined in the accessor so TanStack's `sortUndefined`
      // option can pin missing values to the end in BOTH asc and desc
      // directions. Combined with `sortDescFirst: true`, the first click on
      // the Score header sorts highest→lowest with unscored jobs at the
      // bottom (the natural "show me my best matches" interpretation).
      columnHelper.accessor((r) => r.score ?? undefined, {
        id: 'score',
        header: 'Score',
        cell: (info) => {
          const v = info.row.original.score;
          return (
            <span className="tabular-nums text-slate-700">
              {v == null ? '—' : v}
            </span>
          );
        },
        sortDescFirst: true,
        sortUndefined: 'last',
      }),
      columnHelper.accessor('category', {
        header: 'Category',
        cell: (info) => {
          const id = info.getValue();
          return (
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700">
              {categoryNamesById?.get(id) ?? catLabel(id)}
            </span>
          );
        },
      }),
      columnHelper.accessor((r) => r.source ?? 'zzz_unknown', {
        id: 'source',
        header: 'Source',
        cell: (info) => sourceChip(info.row.original.source ?? null),
        sortingFn: (a, b) => {
          const av = a.original.source ?? 'zzz_unknown';
          const bv = b.original.source ?? 'zzz_unknown';
          return av.localeCompare(bv);
        },
      }),
      columnHelper.accessor('found_at', {
        header: 'Found',
        cell: (info) => {
          const v = info.getValue();
          const abs = (() => {
            try {
              return new Date(v).toLocaleString();
            } catch {
              return v;
            }
          })();
          return (
            <span className="text-slate-600" title={abs}>
              {relTime(v)}
            </span>
          );
        },
        sortingFn: (a, b) =>
          Date.parse(a.original.found_at) - Date.parse(b.original.found_at),
      }),
      columnHelper.display({
        id: 'actions',
        header: 'Actions',
        cell: (info) => {
          const j = info.row.original;
          return (
            <div
              className="flex items-center gap-1.5"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                onClick={(e) => {
                  // Two side effects: open the LinkedIn page in a new tab
                  // AND show the row-actions popover anchored to this
                  // button. Popover lets the user mark applied / rate /
                  // delete without going back into the row.
                  if (j.url) {
                    window.open(j.url, '_blank', 'noopener,noreferrer');
                  }
                  if (onRate && onDelete) {
                    setPopoverState({ jobId: j.id, anchor: e.currentTarget });
                  }
                }}
                className="rounded border border-slate-300 bg-white px-2 py-0.5 text-xs text-slate-700 hover:bg-brand-50 hover:text-brand-700"
                title="Open in new tab + show row actions"
              >
                Open ↗
              </button>
              <button
                type="button"
                onClick={async () => {
                  await navigator.clipboard.writeText(j.id);
                  setCopied(j.id);
                  window.setTimeout(
                    () => setCopied((c) => (c === j.id ? null : c)),
                    1200,
                  );
                }}
                className="rounded border border-slate-300 bg-white px-2 py-0.5 text-xs text-slate-700 hover:bg-slate-100"
                title={`Copy id: ${j.id}`}
              >
                {copied === j.id ? 'copied!' : 'ID'}
              </button>
              {onDelete && (
                <button
                  type="button"
                  onClick={() => handleInlineDelete(j.id)}
                  className={clsx(
                    'rounded border px-2 py-0.5 text-xs transition-colors',
                    confirmDeleteId === j.id
                      ? 'border-red-300 bg-red-600 text-white hover:bg-red-700'
                      : 'border-slate-300 bg-white text-slate-500 hover:bg-red-50 hover:text-red-700 hover:border-red-300',
                  )}
                  title={
                    confirmDeleteId === j.id
                      ? 'Click again to confirm permanent delete'
                      : 'Delete from corpus (also pinned in seen so it won\'t re-appear)'
                  }
                >
                  {confirmDeleteId === j.id ? 'confirm?' : 'Del'}
                </button>
              )}
            </div>
          );
        },
      }),
    ],
    [copied, confirmDeleteId, handleInlineDelete, onDelete, applied, onToggleApplied, categoryNamesById],
  );

  // The applied-pinned sort + per-column sortingFn handle all ordering.
  // No data pre-sort needed (the previous one was overridden by TanStack
  // the moment the user clicked any column header).
  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: setSortingPinned,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: 50 } },
  });

  const pageIndex = table.getState().pagination.pageIndex;
  const pageCount = table.getPageCount();
  const pageSize = table.getState().pagination.pageSize;
  const total = table.getFilteredRowModel().rows.length;
  const from = total === 0 ? 0 : pageIndex * pageSize + 1;
  const to = Math.min((pageIndex + 1) * pageSize, total);

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-auto">
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
                      className={clsx(
                        'border-b border-slate-200 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-slate-600',
                        canSort && 'cursor-pointer select-none hover:text-brand-700',
                      )}
                      onClick={h.column.getToggleSortingHandler()}
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
              const isOpen = expanded.has(j.id);
              const isApplied = applied.has(j.id);
              const isCursor = cursorRowId === j.id;
              return (
                <Fragment key={j.id}>
                  <tr
                    onClick={() => toggleExpand(j.id)}
                    className={clsx(
                      'cursor-pointer border-b border-slate-100 hover:bg-slate-100',
                      // Priority gets a red border. Applied rows are visually
                      // muted. B9: priority+skip uses a desaturated border.
                      j.priority && j.fit === 'skip' && 'border-l-4 border-l-slate-300',
                      j.priority && j.fit !== 'skip' && 'border-l-4 border-l-red-500',
                      isApplied && 'bg-slate-100 text-slate-400 opacity-70',
                      // B4: keyboard cursor row — soft brand background tint
                      // + accent ring on the leading edge. Doesn't compete
                      // with the priority red border (cursor wins on ring;
                      // border still visible to its left).
                      isCursor && 'bg-brand-50 ring-2 ring-inset ring-brand-700',
                    )}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} className="px-3 py-2 align-middle">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                  {isOpen && (
                    <tr
                      key={`${j.id}-expand`}
                      className={clsx(
                        'border-b border-slate-200 bg-slate-50',
                        j.priority && j.fit === 'skip' && 'border-l-4 border-l-slate-300',
                        j.priority && j.fit !== 'skip' && 'border-l-4 border-l-red-500',
                      )}
                    >
                      <td colSpan={row.getVisibleCells().length} className="px-6 py-3">
                        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-xs text-slate-700 md:grid-cols-2">
                          <div>
                            <dt className="font-semibold text-slate-500">Fit reasons</dt>
                            <dd className="mt-1">
                              {j.fit_reasons.length === 0 ? (
                                <span className="italic text-slate-400">none</span>
                              ) : (
                                <ul className="list-disc pl-5">
                                  {j.fit_reasons.map((r, i) => (
                                    <li key={i}>{r}</li>
                                  ))}
                                </ul>
                              )}
                            </dd>
                          </div>
                          <div className="space-y-1.5">
                            <div>
                              <span className="font-semibold text-slate-500">Query: </span>
                              <code className="rounded bg-white px-1.5 py-0.5 text-[11px]">
                                {j.query}
                              </code>
                            </div>
                            <div>
                              <span className="font-semibold text-slate-500">Scored by: </span>
                              {j.scored_by ?? <em className="text-slate-400">none</em>}
                            </div>
                            <div>
                              <span className="font-semibold text-slate-500">Found at: </span>
                              {j.found_at}
                            </div>
                            {j.scraped_at && (
                              <div>
                                <span className="font-semibold text-slate-500">Scraped at: </span>
                                {j.scraped_at}
                              </div>
                            )}
                            <div>
                              <span className="font-semibold text-slate-500">Job ID: </span>
                              <code className="rounded bg-white px-1.5 py-0.5 text-[11px]">
                                {j.id}
                              </code>
                            </div>
                          </div>
                        </dl>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {table.getRowModel().rows.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="px-6 py-12 text-center text-sm text-slate-500">
                  {emptyState ?? 'No jobs match the current filters.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination footer */}
      <div className="flex items-center justify-between border-t border-slate-200 bg-white px-4 py-2 text-xs text-slate-600">
        <span className="tabular-nums">
          {total === 0 ? '0' : `${from.toLocaleString()}–${to.toLocaleString()}`}{' '}
          of {total.toLocaleString()}
        </span>
        <div className="flex items-center gap-1.5">
          <label className="text-slate-500">Per page</label>
          <select
            value={pageSize}
            onChange={(e) => table.setPageSize(Number(e.target.value))}
            className="rounded border border-slate-300 bg-white px-1.5 py-0.5"
          >
            {[25, 50, 100, 200].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <button
            onClick={() => table.setPageIndex(0)}
            disabled={!table.getCanPreviousPage()}
            className="rounded border border-slate-300 bg-white px-2 py-0.5 disabled:opacity-40"
          >
            «
          </button>
          <button
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
            className="rounded border border-slate-300 bg-white px-2 py-0.5 disabled:opacity-40"
          >
            ‹
          </button>
          <span className="tabular-nums">
            {pageCount === 0 ? 0 : pageIndex + 1} / {pageCount}
          </span>
          <button
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
            className="rounded border border-slate-300 bg-white px-2 py-0.5 disabled:opacity-40"
          >
            ›
          </button>
          <button
            onClick={() => table.setPageIndex(pageCount - 1)}
            disabled={!table.getCanNextPage()}
            className="rounded border border-slate-300 bg-white px-2 py-0.5 disabled:opacity-40"
          >
            »
          </button>
        </div>
      </div>

      {/* Row-actions popover (delete / rate / re-toggle applied). Lives at
          table-level so anchor positioning is single-source. The popover
          is shown right after the user clicks "Open ↗" on a row. */}
      {popoverState && onRate && onDelete && (() => {
        const job = data.find((j) => j.id === popoverState.jobId);
        if (!job) return null;
        return (
          <JobActionsPopover
            job={job}
            isApplied={applied.has(job.id)}
            onToggleApplied={onToggleApplied}
            onRate={onRate}
            onDelete={onDelete}
            anchorRef={popoverAnchorRef}
            onClose={() => setPopoverState(null)}
          />
        );
      })()}
    </div>
  );
};
