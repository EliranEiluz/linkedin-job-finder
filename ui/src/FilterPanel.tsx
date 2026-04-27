import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import type { Category } from './types';
import { Dot, type DotColor } from './Dot';
import {
  ALL_CATEGORIES,
  ALL_FITS,
  ALL_SCORED_BY,
  ALL_SOURCES,
  type FilterState,
  type FitKey,
  type ScoredByKey,
  type SourceKey,
  type Tri,
  type DateQuick,
  defaultFilters,
  isDefault,
} from './filters';

interface Props {
  value: FilterState;
  onChange: (f: FilterState) => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
  // Category ids present in the currently-loaded corpus. Optional: if
  // omitted we fall back to the legacy ALL_CATEGORIES constant so the
  // panel still renders before jobs finish loading.
  availableCategories?: Category[];
  // Live count of jobs marked applied — rendered next to the Applied
  // tri-toggle so "0 applied" is obvious when the filter returns empty.
  appliedCount?: number;
  // category-id → human-readable name from /api/config. When the id is
  // present in the map we render the name ("Security"); otherwise we fall
  // back to the LEGACY_CAT_LABELS table or id-de-snaking.
  categoryNamesById?: Map<string, string>;
}

// localStorage key for the desktop sidebar collapsed state. Mobile uses
// the in-memory `open` drawer flag — no persistence needed there.
const SIDEBAR_COLLAPSED_KEY = 'corpus.sidebar.collapsed';

const toggle = <T,>(set: Set<T>, v: T): Set<T> => {
  const next = new Set(set);
  if (next.has(v)) next.delete(v);
  else next.add(v);
  return next;
};

/**
 * Click handler for an enum filter where empty = "match all" (uniform model).
 * - If currently empty (all-mode): clicking expands to "all options minus this".
 * - If non-empty: toggles this option in/out.
 * - If toggling fills the set with every option, collapses back to empty.
 */
const cycleEnumFilter = <T,>(set: Set<T>, options: readonly T[], clicked: T): Set<T> => {
  if (set.size === 0) {
    const next = new Set(options);
    next.delete(clicked);
    return next;
  }
  const next = toggle(set, clicked);
  return next.size === options.length ? new Set() : next;
};

// Section: a header with optional right-side accessory + tight gap to its
// children. Replaces the flat `mt-4` headers — section spacing now lives on
// the wrapper, not on the header itself, so the first section doesn't push
// off the sidebar header.
const Section = ({
  title,
  hint,
  accessory,
  children,
  className,
}: {
  title: string;
  hint?: string;
  accessory?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) => (
  <section className={clsx('flex flex-col gap-1.5', className)}>
    <div className="flex items-baseline justify-between gap-2">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
        {title}
        {hint && (
          <span className="ml-1.5 text-[10px] font-normal normal-case tracking-normal text-slate-400">
            {hint}
          </span>
        )}
      </h3>
      {accessory}
    </div>
    {children}
  </section>
);

// Pill row used by fit / scoredBy / source / category. One row per option,
// full-width, with a leading semantic dot, sentence-case label, and a check
// glyph on the right when "selected" (i.e. the option survives the filter).
//
// Min height 32px desktop, 36px on touch (`md:min-h-8 min-h-9`) — Apple HIG
// 44px gets satisfied via wrapping padding + tap target on the parent <li>.
//
// Selected = bg-slate-50 (very subtle), with leading dot + checkmark glyph.
// Unselected = no bg, dot is at 50% opacity to telegraph "filtered out".
const PillRow = ({
  selected,
  onClick,
  dot,
  label,
  count,
  tooltip,
}: {
  selected: boolean;
  onClick: () => void;
  dot?: DotColor;
  label: string;
  count?: number;
  tooltip?: string;
}) => (
  <button
    type="button"
    onClick={onClick}
    title={tooltip}
    aria-pressed={selected}
    className={clsx(
      'group flex min-h-9 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
      'transition-colors focus-visible:outline-none focus-visible:ring-2',
      'focus-visible:ring-brand-700 focus-visible:ring-offset-1 md:min-h-8',
      selected
        ? 'bg-slate-100 text-slate-900 hover:bg-slate-200'
        : 'text-slate-500 hover:bg-slate-50 hover:text-slate-700',
    )}
  >
    {dot && (
      <span className={clsx('shrink-0', !selected && 'opacity-40')}>
        <Dot color={dot} />
      </span>
    )}
    <span className="flex-1 truncate">{label}</span>
    {count !== undefined && (
      <span className="shrink-0 tabular-nums text-xs text-slate-400">
        {count}
      </span>
    )}
    {selected && (
      <svg
        viewBox="0 0 16 16"
        className="h-3.5 w-3.5 shrink-0 text-brand-700"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M3 8.5l3.5 3.5L13 5" />
      </svg>
    )}
  </button>
);

// Tri-toggle: 3-segmented control. Selected segment fills brand; others are
// neutral. 32px desktop / 36px mobile minimum. Equal-width via `flex-1` so
// the buttons don't shift when their labels change widths.
const TriToggle = ({
  value,
  onChange,
  labels,
  ariaLabel,
}: {
  value: Tri;
  onChange: (v: Tri) => void;
  labels: [string, string, string];
  ariaLabel: string;
}) => (
  <div
    role="radiogroup"
    aria-label={ariaLabel}
    className="flex w-full overflow-hidden rounded-md border border-slate-300 bg-white text-xs font-medium"
  >
    {(['all', 'yes', 'no'] as const).map((k, i) => {
      const isSel = value === k;
      return (
        <button
          key={k}
          type="button"
          role="radio"
          aria-checked={isSel}
          onClick={() => onChange(k)}
          className={clsx(
            // Equal-width segments. `min-h-9 md:min-h-8` = 36/32px tap target.
            'inline-flex flex-1 items-center justify-center px-2 py-1.5 leading-5',
            'transition-colors focus-visible:outline-none focus-visible:ring-2',
            'focus-visible:ring-inset focus-visible:ring-brand-700 min-h-9 md:min-h-8',
            i > 0 && 'border-l border-slate-300',
            isSel
              ? 'bg-brand-700 text-white'
              : 'bg-white text-slate-600 hover:bg-slate-50 hover:text-slate-900',
          )}
        >
          {labels[i]}
        </button>
      );
    })}
  </div>
);

const DualRange = ({
  min,
  max,
  lo,
  hi,
  onChange,
  isDefault: isAll,
}: {
  min: number;
  max: number;
  lo: number;
  hi: number;
  onChange: (lo: number, hi: number) => void;
  isDefault: boolean;
}) => {
  const range = max - min;
  const loPct = ((lo - min) / range) * 100;
  const hiPct = ((hi - min) / range) * 100;
  return (
    <div className="px-1">
      <div className="mb-1 flex items-center justify-between text-xs text-slate-600">
        <span className="tabular-nums font-medium text-slate-700">{lo}</span>
        <span className={clsx('text-[10px] uppercase tracking-wider', isAll ? 'text-slate-400' : 'text-brand-700')}>
          {isAll ? 'Any' : `${lo}–${hi}`}
        </span>
        <span className="tabular-nums font-medium text-slate-700">{hi}</span>
      </div>
      <div className="relative h-5">
        <div className="absolute left-0 right-0 top-1/2 h-1 -translate-y-1/2 rounded bg-slate-200" />
        <div
          className="absolute top-1/2 h-1 -translate-y-1/2 rounded bg-brand-700"
          style={{ left: `${loPct}%`, right: `${100 - hiPct}%` }}
        />
        <input
          type="range"
          min={min}
          max={max}
          value={lo}
          onChange={(e) => {
            const v = Math.min(Number(e.target.value), hi);
            onChange(v, hi);
          }}
          className="range-thumb"
          aria-label="Minimum score"
        />
        <input
          type="range"
          min={min}
          max={max}
          value={hi}
          onChange={(e) => {
            const v = Math.max(Number(e.target.value), lo);
            onChange(lo, v);
          }}
          className="range-thumb"
          aria-label="Maximum score"
        />
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────
// Label tables. Sentence case across the board (Nord/PatternFly/Carbon).
// "OK" stays uppercase (acronym). "Logged-in" hyphenated.
// Source labels lost their decorative emojis in §3 polish (JobsTable did
// the same). The dot color carries the semantic cue.
// ─────────────────────────────────────────────────────────────────────

const fitMeta: Record<FitKey, { label: string; dot: DotColor }> = {
  good: { label: 'Good', dot: 'good' },
  ok: { label: 'OK', dot: 'warn' },
  skip: { label: 'Skip', dot: 'neutral' },
  unscored: { label: 'Unscored', dot: 'neutral' },
};

const LEGACY_CAT_LABELS: Record<string, string> = {
  crypto: 'Crypto',
  security_researcher: 'Security researcher',
  company: 'Company',
};
const catLabel = (id: string): string =>
  LEGACY_CAT_LABELS[id] ??
  id.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

const byMeta: Record<ScoredByKey, { label: string; dot: DotColor; tooltip: string }> = {
  claude: {
    label: 'Claude',
    dot: 'brand',
    tooltip: 'Scored by Claude — ranked your CV vs the job description',
  },
  regex: {
    label: 'Regex',
    dot: 'neutral',
    tooltip: 'Scored by the regex fallback (when Claude was unavailable)',
  },
  'title-filter': {
    label: 'Title-filter',
    dot: 'warn',
    tooltip: 'Dropped by the off-topic title pre-filter — never sent to Claude',
  },
  none: {
    label: 'Not scored',
    dot: 'neutral',
    tooltip: 'Not scored yet — ran with --no-enrich or fetch failed',
  },
};

const srcMeta: Record<SourceKey, { label: string; dot: DotColor; tooltip: string }> = {
  loggedin: {
    label: 'Logged-in',
    dot: 'brand',
    tooltip: 'Scraped via Playwright + saved LinkedIn session',
  },
  guest: {
    label: 'Guest',
    dot: 'good',
    tooltip: 'Scraped via the unauthenticated /jobs-guest API',
  },
  manual: {
    label: 'Manual',
    dot: 'warn',
    tooltip: 'Added via the Corpus tab\'s "+ Add Job" button',
  },
  unknown: {
    label: 'Unknown (legacy)',
    dot: 'neutral',
    tooltip: 'Scraped before mode-tagging existed (mid-April 2026)',
  },
};

const dateMeta: Record<DateQuick, string> = {
  '24h': 'Today',
  '7d': '7 days',
  '30d': '30 days',
  all: 'Anytime',
  custom: 'Custom',
};

// Active-filter count for the sidebar header badge. Mirrors `isDefault`'s
// dimensions so a value of 0 ⇔ isDefault is true.
const countActive = (f: FilterState): number => {
  const d = defaultFilters();
  let n = 0;
  if (f.search.trim()) n++;
  if (f.fits.size !== d.fits.size) n++;
  if (f.priority !== d.priority) n++;
  if (f.categories.size !== d.categories.size) n++;
  if (f.scoredBy.size !== d.scoredBy.size) n++;
  if (f.sources.size !== d.sources.size) n++;
  if (f.scoreMin !== d.scoreMin || f.scoreMax !== d.scoreMax) n++;
  if (f.dateQuick !== d.dateQuick || f.dateFrom || f.dateTo) n++;
  if (f.applied !== d.applied) n++;
  return n;
};

export const FilterPanel = ({
  value, onChange, searchRef, availableCategories, appliedCount = 0,
  categoryNamesById,
}: Props) => {
  const [open, setOpen] = useState(false);
  // Desktop-only collapse. Mobile keeps the drawer (`open`) untouched.
  // Persisted to localStorage so reloads remember the user's pick.
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true';
    } catch {
      /* SSR / sandbox / localStorage blocked */
      return false;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? 'true' : 'false');
    } catch {
      /* localStorage blocked — non-fatal */
    }
  }, [collapsed]);
  const f = value;
  const isClean = isDefault(f);
  const activeCount = useMemo(() => countActive(f), [f]);

  // Prefer the dynamic list from the loaded corpus; fall back to the legacy
  // static set so the panel still renders pre-load.
  const categoryOptions: Category[] =
    (availableCategories && availableCategories.length > 0)
      ? availableCategories
      : ALL_CATEGORIES;

  const setQuick = (q: DateQuick) =>
    onChange({ ...f, dateQuick: q, ...(q !== 'custom' ? { dateFrom: '', dateTo: '' } : {}) });

  const clearAll = () => onChange(defaultFilters());

  const scoreIsAny = f.scoreMin === 1 && f.scoreMax === 10;

  // Right-side "Reset" mini-button for individual sections — only renders when
  // the section has been touched. Keeps the sidebar header's Clear-all as the
  // global reset.
  const SectionReset = ({ show, onReset }: { show: boolean; onReset: () => void }) =>
    show ? (
      <button
        type="button"
        onClick={onReset}
        className="text-[10px] font-medium uppercase tracking-wider text-slate-400 hover:text-brand-700"
      >
        Reset
      </button>
    ) : null;

  const panel = (
    <div className="flex h-full flex-col gap-5 overflow-y-auto px-3 pb-8 pt-3">
      {/* Search — first section, no header above it. The placeholder + kbd
          hint do all the labeling. */}
      <div className="relative">
        <input
          ref={searchRef}
          type="text"
          placeholder="Search title, company, reason…"
          value={f.search}
          onChange={(e) => onChange({ ...f, search: e.target.value })}
          className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 pr-16 text-sm placeholder:text-slate-400 focus:border-brand-700 focus:outline-none focus:ring-1 focus:ring-brand-700"
        />
        {f.search ? (
          <button
            type="button"
            onClick={() => onChange({ ...f, search: '' })}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        ) : (
          <kbd className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-[10px] text-slate-400 md:inline-block">
            /
          </kbd>
        )}
      </div>

      {/* ── Scope group ───────────────────────────────────── */}
      <Section
        title="Fit"
        hint={f.fits.size === 0 ? 'all' : `${ALL_FITS.length - f.fits.size} hidden`}
        accessory={
          <SectionReset
            show={f.fits.size > 0}
            onReset={() => onChange({ ...f, fits: new Set() })}
          />
        }
      >
        <div className="flex flex-col gap-0.5">
          {ALL_FITS.map((k) => {
            const m = fitMeta[k];
            return (
              <PillRow
                key={k}
                label={m.label}
                dot={m.dot}
                selected={f.fits.size === 0 || f.fits.has(k)}
                onClick={() =>
                  onChange({ ...f, fits: cycleEnumFilter(f.fits, ALL_FITS, k) })
                }
              />
            );
          })}
        </div>
      </Section>

      <Section title="Priority company">
        <TriToggle
          value={f.priority}
          onChange={(v) => onChange({ ...f, priority: v })}
          labels={['All', 'Only', 'Hide']}
          ariaLabel="Priority company filter"
        />
      </Section>

      <Section
        title="Category"
        hint={f.categories.size === 0 ? 'all' : `${categoryOptions.length - f.categories.size} hidden`}
        accessory={
          <SectionReset
            show={f.categories.size > 0}
            onReset={() => onChange({ ...f, categories: new Set() })}
          />
        }
      >
        <div className="flex flex-col gap-0.5">
          {categoryOptions.map((k) => (
            <PillRow
              key={k}
              label={categoryNamesById?.get(k) ?? catLabel(k)}
              selected={f.categories.size === 0 || f.categories.has(k)}
              onClick={() =>
                onChange({
                  ...f,
                  categories: cycleEnumFilter(f.categories, categoryOptions, k),
                })
              }
            />
          ))}
        </div>
      </Section>

      {/* Subtle divider between scope (what jobs are) and metadata
          (where they came from / when / scoring). */}
      <hr className="border-slate-200" />

      {/* ── Metadata group ────────────────────────────────── */}
      <Section
        title="Source"
        accessory={
          <SectionReset
            show={f.sources.size > 0}
            onReset={() => onChange({ ...f, sources: new Set() })}
          />
        }
      >
        <div className="flex flex-col gap-0.5">
          {ALL_SOURCES.map((k) => {
            const m = srcMeta[k];
            return (
              <PillRow
                key={k}
                label={m.label}
                dot={m.dot}
                tooltip={m.tooltip}
                selected={f.sources.size === 0 || f.sources.has(k)}
                onClick={() =>
                  onChange({
                    ...f,
                    sources: cycleEnumFilter(f.sources, ALL_SOURCES, k),
                  })
                }
              />
            );
          })}
        </div>
      </Section>

      <Section
        title="Scored by"
        accessory={
          <SectionReset
            show={f.scoredBy.size > 0}
            onReset={() => onChange({ ...f, scoredBy: new Set() })}
          />
        }
      >
        <div className="flex flex-col gap-0.5">
          {ALL_SCORED_BY.map((k) => {
            const m = byMeta[k];
            return (
              <PillRow
                key={k}
                label={m.label}
                dot={m.dot}
                tooltip={m.tooltip}
                selected={f.scoredBy.size === 0 || f.scoredBy.has(k)}
                onClick={() =>
                  onChange({
                    ...f,
                    scoredBy: cycleEnumFilter(f.scoredBy, ALL_SCORED_BY, k),
                  })
                }
              />
            );
          })}
        </div>
      </Section>

      <Section
        title="Score"
        hint="1–10"
        accessory={
          <SectionReset
            show={!scoreIsAny}
            onReset={() => onChange({ ...f, scoreMin: 1, scoreMax: 10 })}
          />
        }
      >
        <DualRange
          min={1}
          max={10}
          lo={f.scoreMin}
          hi={f.scoreMax}
          onChange={(scoreMin, scoreMax) => onChange({ ...f, scoreMin, scoreMax })}
          isDefault={scoreIsAny}
        />
        {!scoreIsAny && (
          <p className="px-1 text-[11px] text-slate-400">
            Narrowing the range hides unscored jobs.
          </p>
        )}
      </Section>

      <Section
        title="Found at"
        accessory={
          <SectionReset
            show={f.dateQuick !== 'all' || !!f.dateFrom || !!f.dateTo}
            onReset={() => onChange({ ...f, dateQuick: 'all', dateFrom: '', dateTo: '' })}
          />
        }
      >
        <div className="flex flex-wrap gap-1">
          {(['24h', '7d', '30d', 'all', 'custom'] as DateQuick[]).map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => setQuick(q)}
              className={clsx(
                'rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
                'min-h-8 focus-visible:outline-none focus-visible:ring-2',
                'focus-visible:ring-brand-700 focus-visible:ring-offset-1',
                f.dateQuick === q
                  ? 'border-brand-700 bg-brand-700 text-white'
                  : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50',
              )}
            >
              {dateMeta[q]}
            </button>
          ))}
        </div>
        {f.dateQuick === 'custom' && (
          <div className="mt-1 grid grid-cols-2 gap-1.5">
            <input
              type="date"
              value={f.dateFrom}
              onChange={(e) => onChange({ ...f, dateFrom: e.target.value })}
              className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs focus:border-brand-700 focus:outline-none focus:ring-1 focus:ring-brand-700"
              aria-label="From date"
            />
            <input
              type="date"
              value={f.dateTo}
              onChange={(e) => onChange({ ...f, dateTo: e.target.value })}
              className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs focus:border-brand-700 focus:outline-none focus:ring-1 focus:ring-brand-700"
              aria-label="To date"
            />
          </div>
        )}
      </Section>

      <Section
        title="Applied"
        hint={`${appliedCount} marked`}
      >
        <TriToggle
          value={f.applied}
          onChange={(v) => onChange({ ...f, applied: v })}
          labels={['All', 'Applied', 'Open']}
          ariaLabel="Applied filter"
        />
      </Section>
    </div>
  );

  // Sidebar header — shows active-filter count + Clear-all when dirty.
  // Replaces the silent "Filters" strip with something that actually
  // communicates state. Desktop variant also gets a small collapse chevron
  // on the far right that flips the sidebar to its thin-rail mode.
  const headerBar = (
    <div className="flex items-center justify-between gap-2 border-b border-slate-200 bg-white px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-slate-800">Filters</span>
        {activeCount > 0 && (
          <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-brand-700 px-1.5 text-[10px] font-semibold tabular-nums text-white">
            {activeCount}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={clearAll}
          disabled={isClean}
          className={clsx(
            'rounded px-2 py-0.5 text-xs font-medium transition-colors',
            isClean
              ? 'cursor-not-allowed text-slate-300'
              : 'text-brand-700 hover:bg-brand-50',
          )}
        >
          Clear all
        </button>
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          aria-expanded={true}
          aria-label="Collapse filters sidebar"
          title="Collapse"
          className="hidden rounded p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700 md:inline-flex"
        >
          {/* Double-chevron pointing left = collapse/hide. Matches the
              16px/strokeWidth-2 icon language already used elsewhere in
              this file (close glyph, search clear). */}
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M9.5 3.5L5 8l4.5 4.5M13.5 3.5L9 8l4.5 4.5" />
          </svg>
        </button>
      </div>
    </div>
  );

  return (
    <>
      {/* Mobile toggle bar — shows count badge so user knows filters are on. */}
      <div className="flex items-center justify-between border-b border-slate-200 bg-white px-3 py-2 md:hidden">
        <button
          type="button"
          onClick={() => setOpen((s) => !s)}
          className="inline-flex min-h-9 items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
            <path d="M2 4h12M4 8h8M6 12h4" />
          </svg>
          <span>Filters</span>
          {activeCount > 0 && (
            <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-brand-700 px-1 text-[10px] font-semibold tabular-nums text-white">
              {activeCount}
            </span>
          )}
        </button>
        {!isClean && (
          <button
            type="button"
            onClick={clearAll}
            className="text-xs font-medium text-brand-700 hover:underline"
          >
            Clear all
          </button>
        )}
      </div>

      {/* Desktop: sidebar is either the full panel (w-64) or a thin rail
          (w-10) the user can click to expand. Persisted to localStorage
          via the `collapsed` state. The width transition is intentionally
          subtle (200ms) so the jobs table reflows smoothly. */}
      <aside
        className={clsx(
          'hidden shrink-0 flex-col border-r border-slate-200 bg-white transition-[width] duration-200 md:flex',
          collapsed ? 'w-10' : 'w-64',
        )}
      >
        {collapsed ? (
          // Rail mode — the entire rail is one big button so the whole
          // strip is a tap target. Vertical "Filters" label + count badge
          // up top so the badge doesn't disappear when collapsed.
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            aria-expanded={false}
            aria-label={
              activeCount > 0
                ? `Expand filters sidebar (${activeCount} active)`
                : 'Expand filters sidebar'
            }
            title="Expand filters"
            className="group flex h-full w-full flex-col items-center gap-3 py-3 text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-700"
          >
            {/* Double-chevron pointing right mirrors the collapse glyph in
                the expanded header. */}
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M6.5 3.5L11 8l-4.5 4.5M2.5 3.5L7 8l-4.5 4.5" />
            </svg>
            {activeCount > 0 && (
              <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-brand-700 px-1.5 text-[10px] font-semibold tabular-nums text-white">
                {activeCount}
              </span>
            )}
            {/* Vertical "Filters" label — bottom-up so it reads naturally
                when leaning your head left. tracking-wider + uppercase
                matches the section headers' visual rhythm. */}
            <span
              className="select-none text-[11px] font-semibold uppercase tracking-wider text-slate-500 group-hover:text-slate-800"
              style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
            >
              Filters
            </span>
          </button>
        ) : (
          <>
            {headerBar}
            {panel}
          </>
        )}
      </aside>

      {/* Mobile: overlay drawer */}
      {open && (
        <div className="fixed inset-0 z-40 flex md:hidden">
          <div
            className="flex-1 bg-slate-900/40"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
          <div className="flex w-[85vw] max-w-sm flex-col bg-white shadow-xl">
            <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-3 py-2.5">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-slate-800">Filters</span>
                {activeCount > 0 && (
                  <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-brand-700 px-1.5 text-[10px] font-semibold tabular-nums text-white">
                    {activeCount}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={clearAll}
                  disabled={isClean}
                  className={clsx(
                    'rounded px-2 py-1 text-xs font-medium',
                    isClean ? 'cursor-not-allowed text-slate-300' : 'text-brand-700 hover:bg-brand-50',
                  )}
                >
                  Clear all
                </button>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close filters"
                  className="rounded p-1.5 text-slate-500 hover:bg-slate-100"
                >
                  <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                    <path d="M4 4l8 8M12 4l-8 8" />
                  </svg>
                </button>
              </div>
            </div>
            {panel}
          </div>
        </div>
      )}
    </>
  );
};
