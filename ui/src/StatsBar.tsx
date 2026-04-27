import type { Job } from './types';
import { Dot } from './Dot';

interface Props {
  all: Job[];
  filtered: Job[];
  applied: Set<string>;
  // Hover-tooltip text for the "loaded" timestamp — replaces the old standalone
  // toolbar so the user can still see when the corpus was loaded.
  loadedAt?: Date;
  // Refresh trigger + busy indicator. The button now lives inside this row
  // (right-aligned) instead of in a separate toolbar above.
  onRefresh: () => void;
  refreshing?: boolean;
  // Manual-add CTA — kept here so the entire corpus toolbar collapses into
  // one row.
  onAddManual?: () => void;
  // categoryNamesById was used by the old per-category chip rendering. Kept
  // in the prop interface for backwards compatibility with the parent's
  // existing call site, even though we no longer render per-category chips
  // (they live in FilterPanel).
  categoryNamesById?: Map<string, string>;
}

// Compact summary line for the Corpus tab. Replaces the old multi-row chip
// wall with a single-line text summary with `tabular-nums`. Tiny semantic
// dots prefix only the four fit numbers — that's the only color in the bar.
//
// Per design doc §2 (alternative A):
//   - Source pills (loggedin/guest) dropped: duplicated in FilterPanel.
//   - Per-category chips dropped: duplicated in FilterPanel + already a
//     filter affordance.
//   - "loaded HH:MM" toolbar collapsed into the Refresh button's title attr.
export const StatsBar = ({
  all, filtered, applied, loadedAt, onRefresh, refreshing, onAddManual,
}: Props) => {
  const byFit = { good: 0, ok: 0, skip: 0, unscored: 0 };
  let priorityCount = 0;
  let appliedCount = 0;
  const companies = new Set<string>();
  for (const j of all) {
    if (j.fit === 'good') byFit.good++;
    else if (j.fit === 'ok') byFit.ok++;
    else if (j.fit === 'skip') byFit.skip++;
    else byFit.unscored++;
    if (j.priority) priorityCount++;
    if (applied.has(j.id)) appliedCount++;
    if (j.company) companies.add(j.company.toLowerCase());
  }

  const totalLabel =
    filtered.length === all.length
      ? `${all.length.toLocaleString()} jobs`
      : `${filtered.length.toLocaleString()} of ${all.length.toLocaleString()} jobs`;

  // Title attribute on Refresh — collapses the redundant "loaded HH:MM"
  // toolbar that used to live above this row.
  const refreshTitle = loadedAt
    ? `Re-fetch results.json — last loaded ${loadedAt.toLocaleTimeString()}`
    : 'Re-fetch results.json';

  return (
    <div className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 backdrop-blur">
      {/* Mobile: horizontal-scroll if the line overflows the 393px viewport.
          Desktop: same single line, no scroll. The Refresh+Add buttons sit at
          the right edge via `ml-auto`. */}
      <div className="no-scrollbar flex items-center gap-x-4 gap-y-1 overflow-x-auto whitespace-nowrap px-4 py-2 text-sm text-slate-600">
        <span className="shrink-0 font-semibold tabular-nums text-slate-900">
          {totalLabel}
        </span>
        <span className="text-slate-300">·</span>
        <SummaryNum n={byFit.good} label="Good" dot="good" />
        <SummaryNum n={byFit.ok} label="OK" dot="warn" />
        <SummaryNum n={byFit.skip} label="Skip" dot="neutral" />
        <SummaryNum n={byFit.unscored} label="Unscored" dot="neutral" />
        <span className="text-slate-300">·</span>
        <SummaryNum
          n={priorityCount}
          label="Priority"
          tooltip="Companies on your priority_companies list"
        />
        <SummaryNum
          n={appliedCount}
          label="Applied"
          tooltip="Jobs you've ticked the Applied checkbox on"
        />
        <span className="text-slate-300">·</span>
        <SummaryNum n={companies.size} label="Companies" />

        {/* Right-side action cluster — Add Job + Refresh. Pushed to the
            edge with ml-auto so it survives the horizontal scroll on mobile. */}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {onAddManual && (
            <button
              type="button"
              onClick={onAddManual}
              className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-0.5 text-xs text-slate-700 hover:bg-brand-50 hover:text-brand-700"
              title="Paste a LinkedIn URL or job ID to ingest one job manually"
            >
              <span aria-hidden="true">＋</span> Add Job
            </button>
          )}
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className="inline-flex items-center gap-1 rounded border border-slate-300 bg-white px-2 py-0.5 text-xs text-slate-700 hover:bg-brand-50 hover:text-brand-700 disabled:opacity-50"
            title={refreshTitle}
          >
            <span aria-hidden="true">↻</span> Refresh
          </button>
        </span>
      </div>
    </div>
  );
};

// Inline-text summary entry: optional dot + bold tabular number + label.
// No background, no chip — just text. Color lives in the dot when present;
// otherwise the whole entry is neutral slate.
const SummaryNum = ({
  n, label, dot, tooltip,
}: {
  n: number;
  label: string;
  dot?: 'good' | 'warn' | 'bad' | 'neutral';
  tooltip?: string;
}) => (
  <span
    className="inline-flex shrink-0 items-center gap-1.5"
    title={tooltip}
  >
    {dot && <Dot color={dot} />}
    <span className="font-semibold tabular-nums text-slate-900">
      {n.toLocaleString()}
    </span>
    <span>{label}</span>
  </span>
);
