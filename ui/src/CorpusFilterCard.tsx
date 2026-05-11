// Corpus filter card for the Crawler Config tab. Renders the two
// post-scoring filter knobs (min fit + min score) using the same card
// chrome as SchedulerCard / LLMProviderCard / RemoteAccessCard /
// NotificationsCard. Issue #117.
//
// The filter itself is implemented backend-side in
// search.py:_passes_corpus_filter. This UI only writes the corpus_filter
// block of the active config; the card never writes /api/config itself
// — it bubbles the change up so ConfigPage runs the full serialize/save
// path that the rest of the page already uses.
//
// Behavior:
//   - Min Fit select: "Off" | "Drop bad" (=ok) | "Drop bad + ok" (=good).
//     "Off" maps to min_fit: null. The select is the source of truth;
//     the saved config is one of {null, "ok", "good"}.
//   - Min Score: a checkbox + a 0..10 number input. Checked = persist
//     the numeric value; unchecked = persist null. Toggling the checkbox
//     restores the most-recent numeric value the user typed (so the
//     ticker doesn't reset to 0 every time they re-enable it).
//   - Optional "X filtered last run" badge reads /run_history.json's
//     latest entry's totals.filtered_out; hides itself if the field is
//     missing (pre-feature run history rows) OR zero.
//
// Help text below the controls explains the contract: filtered jobs are
// remembered (stay in seen_jobs.json) but won't appear in the corpus.

import { useCallback, useEffect, useState } from 'react';
import type { CorpusFilter } from './configTypes';
import type { RunHistoryFile } from './runHistoryTypes';

export interface CorpusFilterCardProps {
  // The current corpus_filter slice of the draft config. Always
  // materialized by normalizeConfig() so the card never has to handle
  // undefined sub-fields. The parent owns the draft state; this card
  // is a controlled component.
  current: CorpusFilter;
  // Called whenever the user changes either knob. Parent threads the
  // new value back through its existing save path (saveConfig in
  // ConfigPage). The card doesn't hit /api/config on its own — same
  // pattern as LLMProviderCard.
  onChange: (next: CorpusFilter) => void;
}

const RUN_HISTORY_URL = `${import.meta.env.BASE_URL}run_history.json`;

// Reads the latest run's filtered_out count. Returns null if anything's
// unreadable (no history file, network error, malformed JSON, or the
// field is missing on the most recent row — which would be the case on
// any history captured before this feature shipped).
const fetchLatestFilteredOut = async (): Promise<number | null> => {
  try {
    const res = await fetch(`${RUN_HISTORY_URL}?t=${Date.now().toString()}`);
    if (!res.ok) return null;
    const text = await res.text();
    if (!text.trim()) return null;
    const data = JSON.parse(text) as RunHistoryFile;
    if (!Array.isArray(data.runs) || data.runs.length === 0) return null;
    const latest = data.runs[data.runs.length - 1];
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime data
    const v = latest?.totals.filtered_out;
    return typeof v === 'number' ? v : null;
  } catch {
    return null;
  }
};

export const CorpusFilterCard = ({ current, onChange }: CorpusFilterCardProps) => {
  // Stash the most-recent score the user picked so toggling the checkbox
  // doesn't lose it. Starts at the current value (if any) or 5 (a
  // reasonable midpoint on the 0..10 LLM scoring scale).
  const [scoreDraft, setScoreDraft] = useState<number>(current.min_score ?? 5);
  const [filteredLastRun, setFilteredLastRun] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const n = await fetchLatestFilteredOut();
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- mutated by cleanup
      if (!cancelled) setFilteredLastRun(n);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onFitChange = useCallback(
    (raw: string) => {
      const next: CorpusFilter['min_fit'] =
        raw === 'ok' || raw === 'good' ? raw : null;
      onChange({ ...current, min_fit: next });
    },
    [current, onChange],
  );

  const onScoreEnabledChange = useCallback(
    (checked: boolean) => {
      if (checked) {
        onChange({ ...current, min_score: scoreDraft });
      } else {
        onChange({ ...current, min_score: null });
      }
    },
    [current, onChange, scoreDraft],
  );

  const onScoreValueChange = useCallback(
    (raw: string) => {
      const n = parseInt(raw, 10);
      if (!Number.isFinite(n)) return;
      const clamped = Math.min(10, Math.max(0, n));
      setScoreDraft(clamped);
      // Only push through if the score is currently enabled. If the
      // user typed a number while the checkbox is off, we keep the
      // draft for when they re-enable it but don't dirty the config.
      if (current.min_score !== null) {
        onChange({ ...current, min_score: clamped });
      }
    },
    [current, onChange],
  );

  const scoreEnabled = current.min_score !== null;
  const showBadge = filteredLastRun !== null && filteredLastRun > 0;

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-1 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-600">
          Corpus filter
        </h2>
        {showBadge && (
          <span
            className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700"
            data-testid="corpus-filter-last-run-badge"
            title={`${filteredLastRun.toString()} jobs were dropped from results.json on the most recent run.`}
          >
            <span className="font-semibold tabular-nums">{filteredLastRun}</span>
            <span className="opacity-75">filtered last run</span>
          </span>
        )}
      </div>
      <p className="mb-3 text-xs text-slate-500">
        Post-scoring gate. Filtered jobs are remembered (won&apos;t be
        re-scored on the next run) but won&apos;t appear in your corpus.
        Useful when running broad keyword searches that pull in a lot of
        noise. Manual-add bypasses the filter.
      </p>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <label
            htmlFor="corpus-filter-min-fit"
            className="mb-1 block text-xs font-semibold text-slate-700"
          >
            Min fit
          </label>
          <select
            id="corpus-filter-min-fit"
            value={current.min_fit ?? ''}
            onChange={(e) => { onFitChange(e.target.value); }}
            className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm focus:border-brand-700 focus:outline-none focus:ring-1 focus:ring-brand-700"
          >
            <option value="">Off (no filter)</option>
            <option value="ok">Drop bad</option>
            <option value="good">Drop bad + ok</option>
          </select>
        </div>

        <div>
          <span className="mb-1 block text-xs font-semibold text-slate-700">
            Min score
          </span>
          <div className="flex items-center gap-2">
            <label className="inline-flex items-center gap-1.5 text-xs text-slate-700">
              <input
                type="checkbox"
                checked={scoreEnabled}
                onChange={(e) => { onScoreEnabledChange(e.target.checked); }}
                className="h-3.5 w-3.5 rounded border-slate-300 text-brand-700 focus:ring-brand-700"
                aria-label="Enable score threshold"
              />
              <span>Enable</span>
            </label>
            <input
              type="number"
              min={0}
              max={10}
              value={scoreEnabled ? (current.min_score ?? scoreDraft) : scoreDraft}
              onChange={(e) => { onScoreValueChange(e.target.value); }}
              disabled={!scoreEnabled}
              aria-label="Min score (0-10)"
              className="w-20 rounded border border-slate-300 bg-white px-2 py-1 text-sm tabular-nums focus:border-brand-700 focus:outline-none focus:ring-1 focus:ring-brand-700 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400"
            />
            <span className="text-[11px] text-slate-500">/ 10</span>
          </div>
        </div>
      </div>
    </section>
  );
};
