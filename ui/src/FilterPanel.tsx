import { useState } from 'react';
import clsx from 'clsx';
import type { Category } from './types';
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

const SectionHeader = ({ children }: { children: React.ReactNode }) => (
  <div className="mb-1.5 mt-4 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
    {children}
  </div>
);

const Check = ({
  checked,
  onChange,
  label,
  count,
  tooltip,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  count?: number;
  tooltip?: string;
}) => (
  <label
    className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-0.5 text-sm hover:bg-slate-100"
    title={tooltip}
  >
    <input
      type="checkbox"
      checked={checked}
      onChange={onChange}
      className="h-3.5 w-3.5 rounded border-slate-300 text-brand-700 focus:ring-brand-700"
    />
    <span className="flex-1 truncate">{label}</span>
    {count !== undefined && (
      <span className="tabular-nums text-xs text-slate-400">{count}</span>
    )}
  </label>
);

const TriToggle = ({
  value,
  onChange,
  labels = ['all', 'yes', 'no'],
}: {
  value: Tri;
  onChange: (v: Tri) => void;
  labels?: [string, string, string];
}) => (
  <div className="inline-flex overflow-hidden rounded border border-slate-300 text-xs">
    {(['all', 'yes', 'no'] as const).map((k, i) => (
      <button
        key={k}
        type="button"
        onClick={() => onChange(k)}
        className={clsx(
          'px-2.5 py-1 transition-colors',
          value === k
            ? 'bg-brand-700 text-white'
            : 'bg-white text-slate-700 hover:bg-slate-100',
        )}
      >
        {labels[i]}
      </button>
    ))}
  </div>
);

const DualRange = ({
  min,
  max,
  lo,
  hi,
  onChange,
}: {
  min: number;
  max: number;
  lo: number;
  hi: number;
  onChange: (lo: number, hi: number) => void;
}) => {
  const range = max - min;
  const loPct = ((lo - min) / range) * 100;
  const hiPct = ((hi - min) / range) * 100;
  return (
    <div className="px-1">
      <div className="flex items-center justify-between text-xs text-slate-600">
        <span className="tabular-nums">{lo}</span>
        <span className="tabular-nums">{hi}</span>
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
        />
      </div>
    </div>
  );
};

const fitLabel: Record<FitKey, string> = {
  good: 'Good',
  ok: 'OK',
  skip: 'Skip',
  unscored: 'Unscored',
};
// Pretty label for a category id. Legacy ids get human-readable names;
// user-defined category ids render title-cased from the id itself.
const LEGACY_CAT_LABELS: Record<string, string> = {
  crypto: 'Crypto',
  security_researcher: 'Security Researcher',
  company: 'Company',
};
const catLabel = (id: string): string =>
  LEGACY_CAT_LABELS[id] ??
  id.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const byLabel: Record<ScoredByKey, string> = {
  claude: 'Claude',
  regex: 'Regex',
  'title-filter': 'Title-filter',
  none: 'None',
};
const byTooltip: Record<ScoredByKey, string> = {
  claude: 'Scored by Claude — ranked your CV vs the job description',
  regex: 'Scored by the regex fallback (when Claude was unavailable)',
  'title-filter': 'Dropped by the off-topic title pre-filter — never sent to Claude',
  none: 'Not scored yet — ran with --no-enrich or fetch failed',
};
const srcLabel: Record<SourceKey, string> = {
  loggedin: '🔐 Logged-in',
  guest: '🌐 Guest',
  unknown: 'Unknown (legacy)',
};
const srcTooltip: Record<SourceKey, string> = {
  loggedin: 'Job scraped via Playwright + saved LinkedIn session',
  guest: 'Job scraped via the unauthenticated /jobs-guest API',
  unknown: 'Scraped before mode-tagging existed (mid-April 2026)',
};

export const FilterPanel = ({
  value, onChange, searchRef, availableCategories, appliedCount = 0,
  categoryNamesById,
}: Props) => {
  const [open, setOpen] = useState(false);
  const f = value;
  // Prefer the dynamic list from the loaded corpus; fall back to the legacy
  // static set so the panel still renders pre-load.
  const categoryOptions: Category[] =
    (availableCategories && availableCategories.length > 0)
      ? availableCategories
      : ALL_CATEGORIES;

  const setQuick = (q: DateQuick) =>
    onChange({ ...f, dateQuick: q, ...(q !== 'custom' ? { dateFrom: '', dateTo: '' } : {}) });

  const panel = (
    <div className="flex h-full flex-col gap-1 overflow-y-auto px-3 pb-6">
      {/* Search */}
      <SectionHeader>Search</SectionHeader>
      <input
        ref={searchRef}
        type="text"
        placeholder="Title, company, reason…  (press /)"
        value={f.search}
        onChange={(e) => onChange({ ...f, search: e.target.value })}
        className="w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-sm focus:border-brand-700 focus:outline-none focus:ring-1 focus:ring-brand-700"
      />

      {/* Fit — empty Set = match all (uniform "auto-marked" model). */}
      <SectionHeader>Fit</SectionHeader>
      <div className="flex flex-col gap-0.5">
        {ALL_FITS.map((k) => (
          <Check
            key={k}
            label={fitLabel[k]}
            checked={f.fits.size === 0 || f.fits.has(k)}
            onChange={() =>
              onChange({ ...f, fits: cycleEnumFilter(f.fits, ALL_FITS, k) })
            }
          />
        ))}
      </div>

      {/* Priority */}
      <SectionHeader>Priority company</SectionHeader>
      <TriToggle
        value={f.priority}
        onChange={(v) => onChange({ ...f, priority: v })}
        labels={['all', 'only', 'hide']}
      />

      {/* Category — same auto-marked semantics. New user-defined ids
          surface automatically when the corpus reloads with them. */}
      <SectionHeader>Category</SectionHeader>
      <div className="flex flex-col gap-0.5">
        {categoryOptions.map((k) => (
          <Check
            key={k}
            label={categoryNamesById?.get(k) ?? catLabel(k)}
            checked={f.categories.size === 0 || f.categories.has(k)}
            onChange={() =>
              onChange({
                ...f,
                categories: cycleEnumFilter(f.categories, categoryOptions, k),
              })
            }
          />
        ))}
      </div>

      {/* Scored by — auto-marked. */}
      <SectionHeader>Scored by</SectionHeader>
      <div className="flex flex-col gap-0.5">
        {ALL_SCORED_BY.map((k) => (
          <Check
            key={k}
            label={byLabel[k]}
            tooltip={byTooltip[k]}
            checked={f.scoredBy.size === 0 || f.scoredBy.has(k)}
            onChange={() =>
              onChange({
                ...f,
                scoredBy: cycleEnumFilter(f.scoredBy, ALL_SCORED_BY, k),
              })
            }
          />
        ))}
      </div>

      {/* Source — auto-marked. */}
      <SectionHeader>Source</SectionHeader>
      <div className="flex flex-col gap-0.5">
        {ALL_SOURCES.map((k) => (
          <Check
            key={k}
            label={srcLabel[k]}
            tooltip={srcTooltip[k]}
            checked={f.sources.size === 0 || f.sources.has(k)}
            onChange={() =>
              onChange({
                ...f,
                sources: cycleEnumFilter(f.sources, ALL_SOURCES, k),
              })
            }
          />
        ))}
      </div>

      {/* Score */}
      <SectionHeader>Score (1–10)</SectionHeader>
      <DualRange
        min={1}
        max={10}
        lo={f.scoreMin}
        hi={f.scoreMax}
        onChange={(scoreMin, scoreMax) => onChange({ ...f, scoreMin, scoreMax })}
      />
      <p className="px-1 pt-1 text-[11px] text-slate-400">
        Narrowing the range hides unscored jobs.
      </p>

      {/* Date */}
      <SectionHeader>Found at</SectionHeader>
      <div className="flex flex-wrap gap-1">
        {(['24h', '7d', '30d', 'all', 'custom'] as DateQuick[]).map((q) => (
          <button
            key={q}
            type="button"
            onClick={() => setQuick(q)}
            className={clsx(
              'rounded border px-2 py-0.5 text-xs',
              f.dateQuick === q
                ? 'border-brand-700 bg-brand-700 text-white'
                : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-100',
            )}
          >
            {q}
          </button>
        ))}
      </div>
      {f.dateQuick === 'custom' && (
        <div className="mt-1 grid grid-cols-2 gap-1.5">
          <input
            type="date"
            value={f.dateFrom}
            onChange={(e) => onChange({ ...f, dateFrom: e.target.value })}
            className="rounded border border-slate-300 bg-white px-1.5 py-1 text-xs"
          />
          <input
            type="date"
            value={f.dateTo}
            onChange={(e) => onChange({ ...f, dateTo: e.target.value })}
            className="rounded border border-slate-300 bg-white px-1.5 py-1 text-xs"
          />
        </div>
      )}

      {/* Applied — label includes the live count so "0 applied" is obvious
           when the filter hides everything. */}
      <SectionHeader>
        Applied <span className="text-[10px] font-normal tracking-normal text-slate-400">
          ({appliedCount} marked)
        </span>
      </SectionHeader>
      <TriToggle
        value={f.applied}
        onChange={(v) => onChange({ ...f, applied: v })}
        labels={['all', 'applied', 'open']}
      />

      {/* Clear */}
      <div className="mt-5 border-t border-slate-200 pt-3">
        <button
          type="button"
          onClick={() => onChange(defaultFilters())}
          disabled={isDefault(f)}
          className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Clear all filters
        </button>
      </div>
    </div>
  );

  return (
    <>
      {/* Mobile toggle */}
      <div className="flex items-center justify-between border-b border-slate-200 bg-white px-3 py-2 md:hidden">
        <button
          type="button"
          onClick={() => setOpen((s) => !s)}
          className="inline-flex items-center gap-1.5 rounded border border-slate-300 bg-white px-2.5 py-1 text-sm"
        >
          <span>☰</span> Filters
        </button>
      </div>

      {/* Desktop: always visible sidebar */}
      <aside className="hidden w-64 shrink-0 border-r border-slate-200 bg-white md:flex md:flex-col">
        <div className="border-b border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700">
          Filters
        </div>
        {panel}
      </aside>

      {/* Mobile: overlay drawer */}
      {open && (
        <div className="fixed inset-0 z-40 flex md:hidden">
          <div
            className="flex-1 bg-black/30"
            onClick={() => setOpen(false)}
          />
          <div className="flex w-72 flex-col bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
              <span className="text-sm font-semibold">Filters</span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded px-2 py-0.5 text-slate-500 hover:bg-slate-100"
              >
                ✕
              </button>
            </div>
            {panel}
          </div>
        </div>
      )}
    </>
  );
};
