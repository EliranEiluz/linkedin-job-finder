import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { BulkActionBar } from './BulkActionBar';
import { RatingCommentEditor } from './RatingCommentEditor';
import { useViewport } from './useViewport';
import { Dot } from './Dot';

// Fit badge — neutral slate chip with a single semantic dot up front.
// Sentence case for status labels (Nord/PatternFly/Carbon design-system
// convention); "OK" stays uppercase since it's an acronym.
const fitBadge = (fit: Job['fit']) => {
  if (fit === 'good')
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
        <Dot color="good" /> Good
      </span>
    );
  if (fit === 'ok')
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
        <Dot color="warn" /> OK
      </span>
    );
  if (fit === 'skip')
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">
        <Dot color="neutral" /> Skip
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
      <Dot color="neutral" /> Unscored
    </span>
  );
};

// "Hot" = backend-derived match signal. The formula lives in
// backend/search.py:_compute_hot — frontend just reads `j.hot` to keep
// the UI in lockstep with the digest email + few-shot loop. Single
// source of truth = no drift when the threshold or formula tunes.
// Falls back to `false` for legacy rows persisted before the field
// existed (the backfill should have caught them all, but defensive).
export const isHotJob = (j: Pick<Job, 'hot'>): boolean => j.hot === true;

// Compact amber pill for the desktop "!" column + mobile card priority
// indicator. Replaces the old red `<Dot color="bad" />` per user feedback
// ("redefine hot and mark it other than this red dot, something better").
const HotPill = () => (
  <span
    className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800"
    title="Hot match — Claude scored 'Good' fit at high score, or it's a priority-list company with a 'Good' fit"
  >
    Hot
  </span>
);

const relTime = (iso: string) => {
  try {
    return formatDistanceToNowStrict(parseISO(iso), { addSuffix: true });
  } catch {
    return iso;
  }
};

// Shared classes for the per-row Action buttons (Open / ID / Del). All three
// must read as one button group: identical padding, line-height, font-weight,
// border-box height. The Del confirm-state variant flips colors but stays
// the exact same size, since it overrides only `border-color` and `bg`.
//
// `leading-5` (=20px line-height on text-xs) pins the rendered glyph height,
// so the `↗` arrow on "Open" no longer makes that button taller than its
// siblings. focus-visible: ring shows on keyboard nav only; mouse-click
// focus is silent. Per round-2 audit (heights were 38/22/22).
const ROW_ACTION_BTN_BASE =
  'inline-flex items-center justify-center whitespace-nowrap rounded border px-2 py-0.5 ' +
  'text-xs font-medium leading-5 transition-colors ' +
  'focus-visible:outline-none focus-visible:ring-2 ' +
  'focus-visible:ring-brand-700 focus-visible:ring-offset-1';

// Mobile card variant — same shape, just tap-target sized.
const ROW_ACTION_BTN_BASE_MOBILE =
  'inline-flex min-h-[44px] flex-1 items-center justify-center whitespace-nowrap rounded border ' +
  'px-3 text-sm font-medium leading-5 transition-colors ' +
  'focus-visible:outline-none focus-visible:ring-2 ' +
  'focus-visible:ring-brand-700 focus-visible:ring-offset-1';

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

// Source chip — neutral slate chip with a small semantic dot. Each source
// gets its own dot color so the user can scan the column without text:
//   loggedin = brand (Playwright + saved session — the "blessed" path)
//   guest    = good  (HTTP-only, healthy fallback)
//   manual   = warn  (user-injected — flag it)
// Per §3 polish pass, decorative emojis (🔐 🌐) were removed.
const sourceChip = (source: Job['source']) => {
  if (source === 'loggedin')
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700"
        title={TOOLTIPS.sourceLoggedin}
      >
        <Dot color="brand" /> Logged-in
      </span>
    );
  if (source === 'guest')
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700"
        title={TOOLTIPS.sourceGuest}
      >
        <Dot color="good" /> Guest
      </span>
    );
  if (source === 'manual')
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700"
        title="Added via the Corpus tab's + Add Job button"
      >
        <Dot color="warn" /> Manual
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
  // Per-row override: ids in this set are "applied but pinned in place" —
  // the sort accessor reads them as 0 (not-applied) so they don't sink to
  // the bottom. Pill, filter and dimmed treatment still light up. CorpusPage
  // owns this state and clears it on stale-event reload.
  keepInPlaceIds?: Set<string>;
  // "Pushed to the end without applying" — additional sort-pin source.
  // Independent of `applied`: a row in this set sinks even if not applied,
  // and a row outside this set follows the natural applied-pinned sort.
  // Ephemeral (lives in CorpusPage state, not server-side).
  pushedToEndIds?: Set<string>;
  // Per-row push-to-end action; surfaced in JobActionsPopover.
  onPushToEnd?: (id: string) => void;
  // Bulk push-to-end action; surfaced in BulkActionBar.
  onPushManyToEnd?: (ids: string[]) => void;
  onToggleApplied: (id: string) => void;
  // Bulk-set applied state on a list of ids. Wired from CorpusPage; powers
  // the "Apply selected" / "Mark unapplied" buttons in the bulk bar.
  onSetAppliedMany?: (ids: string[], applied: boolean) => void;
  // Explicit per-row apply / unapply. Apply takes a `moveToEnd` choice the
  // popover surfaces as a two-button picker the first time. When present,
  // the popover's "Mark as applied" checkbox becomes a real button.
  onApply?: (id: string, moveToEnd: boolean) => void;
  onUnapply?: (id: string) => void;
  // Global "Apply moves to end" pref + setter. `null` = unset (popover
  // shows two buttons + Remember toggle); `true|false` = remembered choice
  // (popover shows one button + change link). Bulk Apply also reads it.
  applyMovesToEnd?: boolean | null;
  onSetApplyPref?: (v: boolean | null) => void;
  // Corpus mutations exposed from CorpusPage's useCorpusActions(). When
  // both are provided, clicking "Open ↗" pops over the row-actions menu
  // (rate / delete / re-toggle applied) AFTER opening the new tab. The
  // optional `comment` is tri-state on the wire (see hooks.ts) — we
  // forward it through so the inline editor in the row-expanded panel
  // can persist comment edits without changing the rating.
  onRate?: (
    id: string,
    rating: number | null,
    comment?: string | null,
  ) => Promise<{ ok: boolean; error?: string }>;
  onDelete?: (id: string) =>
    Promise<{ ok: boolean; error?: string }>;
  // True when the active FilterState is non-default. Drives whether the
  // bulk bar renders even with no selection (so the "Delete all N filtered"
  // affordance is reachable). Computed in CorpusPage via `!isDefault(filters)`.
  hasNonDefaultFilter?: boolean;
  // Click handler for the "Delete all N filtered" right-side button. Wired
  // from CorpusPage as `() => deleteJobs(filtered.map(j => j.id))`.
  onDeleteAllFiltered?: () => void;
  // Bulk re-score: runs the scoring pipeline (description re-fetch + Claude)
  // on the given ids. Slow — `rescoreBusy` is set while the request is in
  // flight so the bar disables the button + shows a spinner.
  onRescoreMany?: (ids: string[]) => Promise<void>;
  rescoreBusy?: boolean;
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

// Sortable column ids exposed by the mobile sort dropdown. Keep in lockstep
// with the column ids declared in the columns array below — typed `as const`
// so the dropdown options are typo-safe.
const MOBILE_SORT_OPTIONS = [
  { id: 'found_at', label: 'Found (newest first)', desc: true },
  { id: 'score', label: 'Score (highest first)', desc: true },
  { id: 'priority', label: 'Priority first', desc: true },
  { id: 'fit', label: 'Fit (good → skip)', desc: false },
  { id: 'company', label: 'Company (A→Z)', desc: false },
  { id: 'title', label: 'Title (A→Z)', desc: false },
] as const;

export const JobsTable = ({
  data, applied, keepInPlaceIds, pushedToEndIds,
  onPushToEnd, onPushManyToEnd, onSetAppliedMany,
  onApply, onUnapply, applyMovesToEnd = null, onSetApplyPref,
  onRate, onDelete, hasNonDefaultFilter = false, onDeleteAllFiltered,
  onRescoreMany, rescoreBusy = false,
  categoryNamesById, emptyState, cursorRowId,
}: Props) => {
  const { isMobile } = useViewport();

  // Single popover instance at table level — anchor element is set when
  // the user clicks an Open button on a specific row.
  const [popoverState, setPopoverState] = useState<
    { jobId: string; anchor: HTMLElement } | null
  >(null);
  const popoverAnchorRef = useRef<HTMLElement | null>(null);
  popoverAnchorRef.current = popoverState?.anchor ?? null;

  // Ephemeral per-table selection state. NOT persisted across reloads —
  // selection is "what I'm operating on right now," not a saved view.
  // Reset whenever the data array reference changes (filter change,
  // stale-reload, page change all flow through `data`).
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    setSelectedIds(new Set());
  }, [data]);
  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

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
        header: () => (
          <span
            title={'Hot match — Claude scored "Good" fit at high score, or it\'s a priority-list company with a "Good" fit.'}
            className="cursor-help"
          >
            Hot
          </span>
        ),
        cell: (info) => {
          // The column accessor is still `priority` (for sorting / filtering
          // wired elsewhere), but the cell now renders the *derived* HOT
          // signal. Priority-only (fit !== 'good') is NOT hot.
          if (!isHotJob(info.row.original)) return '';
          return <HotPill />;
        },
        sortingFn: (a, b) =>
          Number(a.original.priority) - Number(b.original.priority),
        size: 32,
      }),
      // Accessor (NOT display) — TanStack ignores sortingFn on display
      // columns because its sort engine calls getValue() first. The
      // accessorFn closes over the live `applied` Set + `keepInPlaceIds`;
      // when either mutates, the parent useMemo re-creates the column
      // defs and TanStack re-sorts. Pinned as the first sort key elsewhere
      // so applied jobs sink to the bottom — UNLESS the user picked
      // "keep in place" for that row, in which case the accessor reads
      // 0 and the row stays put.
      //
      // Visual is decoupled from the data accessor: the cell renders a
      // SELECTION checkbox (bound to selectedIds) plus an emerald
      // "Applied" pill when applied. Header checkbox = select-all-visible.
      // Sort id stays 'applied' so setSortingPinned still finds it.
      columnHelper.accessor(
        (r) => {
          const sinkByApply =
            applied.has(r.id) && !(keepInPlaceIds?.has(r.id) ?? false);
          const sinkByPush = pushedToEndIds?.has(r.id) ?? false;
          return sinkByApply || sinkByPush ? 1 : 0;
        },
        {
          id: 'applied',
          // Header is an indeterminate checkbox that selects/deselects every
          // visible row in the current row model.
          header: ({ table }) => {
            const visible = table.getRowModel().rows.map((r) => r.original.id);
            const visibleSelected = visible.filter((id) => selectedIds.has(id)).length;
            const allSelected = visible.length > 0 && visibleSelected === visible.length;
            const someSelected = visibleSelected > 0 && !allSelected;
            const refSet = (el: HTMLInputElement | null) => {
              if (el) el.indeterminate = someSelected;
            };
            return (
              <span className="inline-flex items-center gap-1.5">
                <input
                  type="checkbox"
                  ref={refSet}
                  checked={allSelected}
                  disabled={visible.length === 0}
                  onChange={() => {
                    setSelectedIds((prev) => {
                      const next = new Set(prev);
                      if (allSelected) {
                        for (const id of visible) next.delete(id);
                      } else {
                        for (const id of visible) next.add(id);
                      }
                      return next;
                    });
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="h-3.5 w-3.5 cursor-pointer rounded border-slate-300 text-brand-700 focus:ring-brand-700 disabled:opacity-40"
                  title={
                    visible.length === 0
                      ? 'No rows visible'
                      : allSelected
                      ? `Deselect all ${visible.length} visible`
                      : `Select all ${visible.length} visible`
                  }
                  aria-label="Select all visible rows"
                />
                <span>Selected</span>
              </span>
            );
          },
          cell: (info) => {
            const j = info.row.original;
            const isApplied = applied.has(j.id);
            const isSelected = selectedIds.has(j.id);
            return (
              <div
                className="inline-flex items-center gap-1.5"
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => toggleSelected(j.id)}
                  className="h-4 w-4 cursor-pointer rounded border-slate-300 text-brand-700 focus:ring-brand-700"
                  title={isSelected ? 'Deselect row' : 'Select row'}
                  aria-label={isSelected ? 'Deselect row' : 'Select row'}
                />
                {isApplied && (
                  <span
                    className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700"
                    title="You marked this row as applied"
                  >
                    <Dot color="good" /> Applied
                  </span>
                )}
              </div>
            );
          },
          size: 110,
          enableSorting: true,
          // 'basic' = numeric comparison; works on the 0/1 accessor output.
          sortingFn: 'basic',
        },
      ),
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
                className={clsx(
                  ROW_ACTION_BTN_BASE,
                  'border-slate-300 bg-white text-slate-700 hover:bg-brand-50 hover:text-brand-700',
                )}
                title="Open in new tab + show row actions"
              >
                Open ↗
              </button>
              {onDelete && (
                <button
                  type="button"
                  onClick={() => handleInlineDelete(j.id)}
                  className={clsx(
                    ROW_ACTION_BTN_BASE,
                    'transition-transform',
                    confirmDeleteId === j.id
                      ? 'border-red-600 bg-red-600 text-white hover:bg-red-700'
                      : 'border-slate-300 bg-white text-slate-500 hover:scale-110 hover:bg-red-50 hover:text-red-700 hover:border-red-300',
                  )}
                  title={
                    confirmDeleteId === j.id
                      ? 'Click again to confirm permanent delete'
                      : 'Delete from corpus (also pinned in seen so it won\'t re-appear)'
                  }
                  aria-label="Delete from corpus"
                >
                  {confirmDeleteId === j.id ? (
                    // Confirm-state: text label so it's unmistakable. Width
                    // grows for ~4s during the confirm window — that's the
                    // point, it should grab the eye. Idle state is icon-only.
                    <span className="inline-flex items-center gap-1">
                      <svg
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.75"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="h-3.5 w-3.5"
                        aria-hidden="true"
                      >
                        <path d="M2.5 4h11M5.5 4V2.5h5V4M3.7 4l.5 9.5a1 1 0 0 0 1 .9h5.6a1 1 0 0 0 1-.9l.5-9.5" />
                      </svg>
                      <span>Delete?</span>
                    </span>
                  ) : (
                    <svg
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.25"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="h-4 w-4"
                      aria-hidden="true"
                    >
                      <path d="M2.5 4h11M5.5 4V2.5h5V4M3.7 4l.5 9.5a1 1 0 0 0 1 .9h5.6a1 1 0 0 0 1-.9l.5-9.5M6.5 7v4M9.5 7v4" />
                    </svg>
                  )}
                </button>
              )}
            </div>
          );
        },
      }),
    ],
    [
      confirmDeleteId, handleInlineDelete, onDelete, applied, keepInPlaceIds,
      pushedToEndIds,
      selectedIds, toggleSelected, categoryNamesById,
    ],
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

  // ——— Mobile sort dropdown wiring ———
  // The active dropdown selection mirrors whichever entry of `sorting`
  // is the first NON-applied key (since `applied` is always pinned at
  // index 0 by setSortingPinned).
  const activeMobileSort = useMemo(() => {
    const first = sorting.find((s) => s.id !== 'applied');
    if (!first) return MOBILE_SORT_OPTIONS[0].id;
    const match = MOBILE_SORT_OPTIONS.find((o) => o.id === first.id);
    return (match?.id ?? MOBILE_SORT_OPTIONS[0].id) as typeof MOBILE_SORT_OPTIONS[number]['id'];
  }, [sorting]);

  const onMobileSortChange = (next: typeof MOBILE_SORT_OPTIONS[number]['id']) => {
    const opt = MOBILE_SORT_OPTIONS.find((o) => o.id === next);
    if (!opt) return;
    // Set just this single sort key; setSortingPinned re-prepends the
    // applied pin automatically, preserving the "applied jobs sink" rule.
    setSortingPinned([{ id: opt.id, desc: opt.desc }]);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-auto">
        {/* Mobile sort dropdown — only visible below md. Replaces the table
            column headers (which can't fit on a phone). */}
        {isMobile && (
          <div className="flex items-center gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs">
            <label htmlFor="mobile-sort" className="font-medium text-slate-600">
              Sort:
            </label>
            <select
              id="mobile-sort"
              value={activeMobileSort}
              onChange={(e) => onMobileSortChange(e.target.value as typeof MOBILE_SORT_OPTIONS[number]['id'])}
              className="min-h-[44px] flex-1 rounded border border-slate-300 bg-white px-2 py-1 text-sm text-slate-700"
            >
              {MOBILE_SORT_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
            {/* Bulk-select-all checkbox — repurposed from "Mark all
                visible as applied" to "Select all visible." Same touch
                target, same indeterminate logic; the underlying state is
                now selectedIds. The bulk action then runs from
                BulkActionBar (rendered just below). */}
            {(() => {
              const visible = table.getRowModel().rows.map((r) => r.original.id);
              const visibleSelected = visible.filter((id) => selectedIds.has(id)).length;
              const allSelected = visible.length > 0 && visibleSelected === visible.length;
              const someSelected = visibleSelected > 0 && !allSelected;
              const refSet = (el: HTMLInputElement | null) => {
                if (el) el.indeterminate = someSelected;
              };
              return (
                <label
                  className="inline-flex shrink-0 items-center gap-1.5 text-xs text-slate-600"
                  title={
                    visible.length === 0
                      ? 'No rows visible'
                      : allSelected
                      ? `Deselect all ${visible.length} visible`
                      : `Select all ${visible.length} visible`
                  }
                >
                  <input
                    type="checkbox"
                    ref={refSet}
                    checked={allSelected}
                    disabled={visible.length === 0}
                    onChange={() => {
                      setSelectedIds((prev) => {
                        const next = new Set(prev);
                        if (allSelected) {
                          for (const id of visible) next.delete(id);
                        } else {
                          for (const id of visible) next.add(id);
                        }
                        return next;
                      });
                    }}
                    className="h-4 w-4 rounded border-slate-300 text-brand-700 focus:ring-brand-700 disabled:opacity-40"
                  />
                  All
                </label>
              );
            })()}
          </div>
        )}

        {/* Bulk-action bar — shown when the user has selected rows OR a
            non-default filter is active. Lives inside the table's wrapper
            so it sits above the rows but below the StatsBar / mobile sort
            bar. See BulkActionBar.tsx for the per-button wiring. */}
        {(selectedIds.size > 0 || hasNonDefaultFilter) && (
          <BulkActionBar
            selectedCount={selectedIds.size}
            filteredCount={data.length}
            hasFilter={hasNonDefaultFilter}
            allSelectedApplied={
              selectedIds.size > 0 &&
              [...selectedIds].every((id) => applied.has(id))
            }
            onClear={() => setSelectedIds(new Set())}
            onDeleteSelected={() => {
              if (!onDelete) return;
              const ids = [...selectedIds];
              setSelectedIds(new Set());
              // Fire as a single bulk delete via per-id calls; the backend
              // collapses these into one results.json write through
              // useCorpusActions's deleteJobs([...]) path. We don't have a
              // direct bulk handle here (CorpusPage wires `deleteOne`), so
              // we sequence them — N is typically <= page size.
              void Promise.all(ids.map((id) => onDelete(id)));
            }}
            onApplySelected={() => {
              if (!onSetAppliedMany) return;
              // Bulk Apply honours the move-to-end pref. Default = true
              // (matches today's silent move-to-end behaviour for users
              // who never opened the popover).
              onSetAppliedMany([...selectedIds], true);
              // No keep-in-place override on bulk apply — bulk implies
              // "I'm done with these," sinking them is the right move.
              setSelectedIds(new Set());
            }}
            onMarkUnappliedSelected={() => {
              if (!onSetAppliedMany) return;
              onSetAppliedMany([...selectedIds], false);
              setSelectedIds(new Set());
            }}
            onDeleteAllFiltered={() => {
              if (!onDeleteAllFiltered) return;
              setSelectedIds(new Set());
              onDeleteAllFiltered();
            }}
            onRescoreSelected={() => {
              if (!onRescoreMany) return;
              const ids = [...selectedIds];
              if (ids.length === 0) return;
              // Don't clear selection — user may want to act on the same
              // rows after the rescore completes (e.g. delete the still-
              // bad ones). Selection is harmless across the await.
              void onRescoreMany(ids);
            }}
            rescoreBusy={rescoreBusy}
            onPushToEndSelected={() => {
              if (!onPushManyToEnd) return;
              const ids = [...selectedIds];
              if (ids.length === 0) return;
              onPushManyToEnd(ids);
              setSelectedIds(new Set());
            }}
          />
        )}

        {/* Desktop: existing table. Mobile: card list of the same rows. */}
        {isMobile ? (
          <ul className="divide-y divide-slate-200">
            {table.getRowModel().rows.map((row) => {
              const j = row.original;
              const isApplied = applied.has(j.id);
              const isCursor = cursorRowId === j.id;
              const isOpen = expanded.has(j.id);
              const isHot = isHotJob(j);
              return (
                <li
                  key={j.id}
                  className={clsx(
                    'relative bg-white px-3 py-3 transition-colors active:bg-slate-100',
                    isHot && 'border-l-4 border-l-amber-500',
                    isApplied && 'bg-slate-50 text-slate-500 opacity-80',
                    isCursor && 'bg-brand-50 ring-2 ring-inset ring-brand-700',
                  )}
                >
                  {/* Top row: title + applied checkbox + priority emoji.
                      The whole top row taps through to expand/collapse the
                      card (mirrors the desktop row-click). Checkbox stops
                      propagation. */}
                  <div
                    className="flex items-start gap-2"
                    onClick={() => toggleExpand(j.id)}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="line-clamp-2 text-sm font-medium leading-snug text-slate-900">
                        {j.title}
                      </div>
                      <div className="mt-0.5 truncate text-xs text-slate-600">
                        <span className="font-medium text-slate-700">{j.company}</span>
                        {j.location && (
                          <>
                            <span className="mx-1 text-slate-400">·</span>
                            <span>{j.location}</span>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {isHot && <HotPill />}
                      {isApplied && (
                        <span
                          className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700"
                          title="You marked this row as applied"
                        >
                          <Dot color="good" /> Applied
                        </span>
                      )}
                      {/* Top-right card checkbox now binds to selectedIds
                          (was: applied). Selection is per-table-render
                          ephemeral state — see BulkActionBar above. */}
                      <label
                        className="inline-flex h-11 w-11 cursor-pointer items-center justify-center"
                        onClick={(e) => e.stopPropagation()}
                        title={selectedIds.has(j.id) ? 'Deselect row' : 'Select row'}
                      >
                        <input
                          type="checkbox"
                          checked={selectedIds.has(j.id)}
                          onChange={() => toggleSelected(j.id)}
                          className="h-5 w-5 cursor-pointer rounded border-slate-300 text-brand-700 focus:ring-brand-700"
                          aria-label={selectedIds.has(j.id) ? 'Deselect row' : 'Select row'}
                        />
                      </label>
                    </div>
                  </div>

                  {/* Pills row: fit, source, found relative time, score */}
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
                    {fitBadge(j.fit)}
                    {sourceChip(j.source ?? null)}
                    {j.score != null && (
                      <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs tabular-nums text-slate-600">
                        score {j.score}
                      </span>
                    )}
                    <span
                      className="text-xs text-slate-500"
                      title={(() => {
                        try { return new Date(j.found_at).toLocaleString(); }
                        catch { return j.found_at; }
                      })()}
                    >
                      · {relTime(j.found_at)}
                    </span>
                  </div>

                  {/* Bottom action row — Open / Del. ID copy was dropped to
                      match desktop (which has no ID-copy button); the job ID
                      is still visible in the row-expanded panel as
                      `code`-formatted text the user can long-press to copy.
                      Both buttons use ROW_ACTION_BTN_BASE_MOBILE so they
                      share min-height, padding, font-weight, and focus ring;
                      flex-1 on each makes the row read as an even split. */}
                  <div className="mt-2.5 flex items-stretch gap-2">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (j.url) window.open(j.url, '_blank', 'noopener,noreferrer');
                        if (onRate && onDelete) {
                          setPopoverState({ jobId: j.id, anchor: e.currentTarget });
                        }
                      }}
                      className={clsx(
                        ROW_ACTION_BTN_BASE_MOBILE,
                        'border-slate-300 bg-white text-slate-700 hover:bg-brand-50 hover:text-brand-700',
                      )}
                    >
                      Open ↗
                    </button>
                    {onDelete && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleInlineDelete(j.id);
                        }}
                        className={clsx(
                          ROW_ACTION_BTN_BASE_MOBILE,
                          confirmDeleteId === j.id
                            ? 'border-red-300 bg-red-600 text-white'
                            : 'border-slate-300 bg-white text-slate-500 hover:bg-red-50 hover:text-red-700 hover:border-red-300',
                        )}
                      >
                        {confirmDeleteId === j.id ? 'confirm?' : 'Del'}
                      </button>
                    )}
                  </div>

                  {/* Expanded detail (same content as desktop's expand row,
                      stacked single-column for the narrow viewport). */}
                  {isOpen && (
                    <div className="mt-3 rounded border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs text-slate-700">
                      <div className="mb-2">
                        <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                          Fit reasons
                        </div>
                        <div className="mt-1">
                          {j.fit_reasons.length === 0 ? (
                            <span className="italic text-slate-400">none</span>
                          ) : (
                            <ul className="list-disc pl-5">
                              {j.fit_reasons.map((r, i) => (
                                <li key={i}>{r}</li>
                              ))}
                            </ul>
                          )}
                        </div>
                      </div>
                      <dl className="space-y-1">
                        <div>
                          <span className="font-semibold text-slate-500">Query: </span>
                          <code className="rounded bg-white px-1.5 py-0.5 text-[11px] break-all">
                            {j.query}
                          </code>
                        </div>
                        <div>
                          <span className="font-semibold text-slate-500">Category: </span>
                          {categoryNamesById?.get(j.category) ?? catLabel(j.category)}
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
                          <code className="rounded bg-white px-1.5 py-0.5 text-[11px] break-all">
                            {j.id}
                          </code>
                        </div>
                      </dl>
                      {/* Inline rating + comment editor (same as desktop
                          expanded row). Compact density to keep the card
                          tight. Falls back to read-only when onRate isn't
                          wired. */}
                      {onRate ? (
                        <div className="mt-3 border-t border-slate-200 pt-2">
                          <RatingCommentEditor
                            jobId={j.id}
                            initialRating={j.rating ?? null}
                            initialComment={j.comment ?? null}
                            onSave={(rating, comment) => onRate(j.id, rating, comment)}
                            density="compact"
                          />
                        </div>
                      ) : (
                        j.comment && (
                          <div className="mt-3 border-t border-slate-200 pt-2">
                            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                              Your comment{j.rating != null && ` (rated ${j.rating}/5)`}
                            </div>
                            <div className="mt-1 whitespace-pre-wrap text-xs">
                              {j.comment}
                            </div>
                          </div>
                        )
                      )}
                    </div>
                  )}
                </li>
              );
            })}
            {table.getRowModel().rows.length === 0 && (
              <li className="px-6 py-12 text-center text-sm text-slate-500">
                {emptyState ?? 'No jobs match the current filters.'}
              </li>
            )}
          </ul>
        ) : (
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
                        // Hot match gets an amber accent border. Priority-only
                        // (without good fit) is no longer treated specially —
                        // it's just a filter signal, not a visual one.
                        isHotJob(j) && 'border-l-4 border-l-amber-500',
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
                          {/* Inline rating + comment editor — same component
                              used by the Corpus popover and the Tracker
                              detail modal. Compact density to fit the row.
                              When `onRate` isn't wired, fall back to the
                              previous read-only comment block (used by any
                              caller that doesn't pass mutations). */}
                          {onRate ? (
                            <div className="mt-3 border-t border-slate-200 pt-3">
                              <RatingCommentEditor
                                jobId={j.id}
                                initialRating={j.rating ?? null}
                                initialComment={j.comment ?? null}
                                onSave={(rating, comment) => onRate(j.id, rating, comment)}
                                density="compact"
                              />
                            </div>
                          ) : (
                            j.comment && (
                              <div className="mt-3 border-t border-slate-200 pt-3">
                                <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                                  Your comment{j.rating != null && ` (rated ${j.rating}/5)`}
                                </dt>
                                <dd className="mt-1 whitespace-pre-wrap text-xs text-slate-700">
                                  {j.comment}
                                </dd>
                              </div>
                            )
                          )}
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
        )}
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

      {/* Row-actions popover (Apply / Unapply / rate / delete). Lives at
          table-level so anchor positioning is single-source. The popover
          is shown right after the user clicks "Open ↗" on a row. Apply
          is now an explicit button with a first-time "move to end?" pick;
          see JobActionsPopover.tsx + CorpusPage's applyOne / unapplyOne. */}
      {popoverState && onRate && onDelete && onApply && onUnapply && onSetApplyPref && (() => {
        const job = data.find((j) => j.id === popoverState.jobId);
        if (!job) return null;
        return (
          <JobActionsPopover
            job={job}
            isApplied={applied.has(job.id)}
            onApply={onApply}
            onUnapply={onUnapply}
            onPushToEnd={onPushToEnd}
            applyMovesToEnd={applyMovesToEnd}
            onSetApplyPref={onSetApplyPref}
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
