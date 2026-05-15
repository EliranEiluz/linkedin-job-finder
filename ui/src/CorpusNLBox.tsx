// CorpusNLBox — small natural-language filter input that sits above
// FilterPanel on the Corpus tab. Single-input, no chat UI: the user
// types something like "security jobs from priority companies last
// week" and the LLM (via /api/corpus/nl) translates it into a partial
// FilterState. We render the parse summary as a preview line and ask
// the user to confirm with Apply before mutating the parent's filters.
//
// Why a confirmation step (instead of auto-applying):
// - LLM misparses are inevitable; auto-apply would silently wipe the
//   user's current filter state.
// - The preview line is the UX contract — "this is what I'm about to
//   apply" — so a misparse is one click of Cancel away from recovery.
//
// Mobile considerations: on the Corpus page FilterPanel collapses
// behind a drawer on <md screens. The NL box stays visible so it
// becomes the primary mobile filtering affordance. The input is
// full-width, the button is >=44px tall (Apple HIG tap target), and
// the container has scroll-margin-top so the iOS keyboard can scroll
// it into view without hiding it behind the sticky toolbar above.

import { useCallback, useRef, useState } from 'react';
import type { FilterState } from './filters';
import {
  validateServerFilters,
  type ServerEnvelope,
} from './corpusNlValidate';

interface Props {
  // Pulled from the parent so the NL box's "Apply" handoff can build a
  // FULL FilterState (the ctl only emits the fields the user mentioned).
  // We deliberately do NOT take the current filters as input — the user's
  // mental model is "type a query → that's the new filter", not "merge with
  // whatever I already had ticked". This matches isDefault / URL semantics.
  onApply: (filters: FilterState) => void;
}

// Local typing of the validated parse result. parse_summary is whatever
// the server rendered — we just display the string, no formatting on the
// client side (single source of truth for what-will-happen is the ctl).
interface ParsedPreview {
  filters: FilterState;
  parseSummary: string;
}

export const CorpusNLBox = ({ onApply }: Props) => {
  const [query, setQuery] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [preview, setPreview] = useState<ParsedPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Reset to the input state. Called from Cancel and from the error
  // "retry" affordance. We keep the query string around so the user
  // can tweak-and-resend without retyping the whole thing.
  const reset = useCallback(() => {
    setPreview(null);
    setError(null);
    // Defer focus to next tick so React has restored the input from the
    // preview-card render.
    queueMicrotask(() => inputRef.current?.focus());
  }, []);

  const submit = useCallback(async () => {
    const trimmed = query.trim();
    if (!trimmed) return;
    setSubmitting(true);
    setError(null);
    setPreview(null);
    try {
      const res = await fetch('/api/corpus/nl', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: trimmed }),
      });
      // Even on 4xx/5xx the body is structured JSON (envelope-passthrough
      // on the middleware), so we read it the same way for ok and error.
      // If the body fails to parse, fall back to a generic error message
      // that still gives the user something actionable.
      let body: ServerEnvelope | null = null;
      try {
        body = (await res.json()) as ServerEnvelope;
      } catch {
        body = null;
      }
      if (!body) {
        setError(`Server returned ${String(res.status)} but no JSON body.`);
        return;
      }
      if (!body.ok) {
        setError(body.error ?? 'Could not parse query.');
        return;
      }
      const validated = validateServerFilters(body.filters);
      const summary = body.parse_summary?.trim() ?? '';
      setPreview({
        filters: validated,
        parseSummary:
          summary || 'No filters detected — Apply will clear all filters.',
      });
    } catch (e) {
      setError((e as Error).message || 'Network error.');
    } finally {
      setSubmitting(false);
    }
  }, [query]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void submit();
      }
    },
    [submit],
  );

  const applyPreview = useCallback(() => {
    if (!preview) return;
    onApply(preview.filters);
    // Clear the preview but keep the query in the input — common follow-up
    // is "tweak the query slightly and re-apply".
    setPreview(null);
  }, [onApply, preview]);

  // ─── Render ──────────────────────────────────────────────────────────

  // scroll-margin-top here so when the iOS keyboard pushes the input into
  // view, the toolbar above doesn't cover it. Value tuned to roughly the
  // height of StatsBar + tab nav.
  return (
    <div
      className="border-b border-slate-200 bg-slate-50 px-3 py-2.5"
      style={{ scrollMarginTop: 96 }}
      data-testid="corpus-nl-box"
    >
      {preview === null && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <label className="sr-only" htmlFor="corpus-nl-input">
            Natural-language filter
          </label>
          <input
            ref={inputRef}
            id="corpus-nl-input"
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
            }}
            onKeyDown={onKeyDown}
            disabled={submitting}
            placeholder="Filter by typing: 'security jobs from priority companies, last week'"
            // Full-width on mobile; flex-1 takes the remaining row on >=sm.
            className="w-full flex-1 rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600 disabled:bg-slate-100 disabled:text-slate-500"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <button
            type="button"
            onClick={() => void submit()}
            disabled={submitting || !query.trim()}
            // min-h-[44px] for the iOS tap-target requirement. The same
            // button on desktop is comfortable at the default text size.
            className="inline-flex min-h-[44px] items-center justify-center gap-2 whitespace-nowrap rounded border border-brand-700 bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-800 focus:outline-none focus:ring-2 focus:ring-brand-600 disabled:cursor-not-allowed disabled:border-slate-300 disabled:bg-slate-300"
          >
            {submitting && (
              <span
                className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white"
                aria-hidden="true"
              />
            )}
            <span>{submitting ? 'Parsing…' : 'Filter'}</span>
          </button>
        </div>
      )}

      {preview !== null && (
        <div className="flex flex-col gap-2">
          <div className="rounded border border-brand-200 bg-white px-3 py-2 text-sm text-slate-800">
            <span className="font-medium text-slate-600">Will filter by:</span>{' '}
            <span data-testid="corpus-nl-preview-summary">
              {preview.parseSummary}
            </span>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <button
              type="button"
              onClick={applyPreview}
              className="inline-flex min-h-[44px] items-center justify-center rounded border border-brand-700 bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-800 focus:outline-none focus:ring-2 focus:ring-brand-600"
            >
              Apply
            </button>
            <button
              type="button"
              onClick={reset}
              className="inline-flex min-h-[44px] items-center justify-center rounded border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 focus:outline-none focus:ring-2 focus:ring-brand-600"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error !== null && (
        <div
          role="alert"
          className="mt-2 flex flex-col gap-1.5 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 sm:flex-row sm:items-center sm:justify-between"
          data-testid="corpus-nl-error"
        >
          <span className="break-words">{error}</span>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={submitting || !query.trim()}
            className="self-start rounded border border-red-300 bg-white px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50 sm:self-auto"
          >
            Retry
          </button>
        </div>
      )}
    </div>
  );
};
