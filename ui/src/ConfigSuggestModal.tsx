import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import type { CrawlerConfig } from './configTypes';

// Mirrors backend/ctl/config_suggest_ctl.py:MIN_SIGNALS_FOR_SUGGEST.
// Single source of truth for the UI's button-disabled rule. If you change
// this, change the Python constant too — the backend re-checks anyway, but
// the UX should match the server behavior exactly.
export const MIN_SIGNALS_FOR_SUGGEST = 5;

// Shape returned by /api/config/suggest. Keep this in lock-step with
// config_suggest_ctl.py:_shape_suggestions.
export interface AddQuerySuggestion {
  query: string;
  category_id: string;
  reason: string;
}
export interface AddCompanySuggestion {
  name: string;
  reason: string;
}
export interface RegexTweakSuggestion {
  pattern: string;
  action: string; // currently always "add_to_off_topic"
  reason: string;
}
export interface SuggestPayload {
  add_queries: AddQuerySuggestion[];
  add_companies: AddCompanySuggestion[];
  regex_tweaks: RegexTweakSuggestion[];
  reasoning: string;
}

type ModalState =
  | { kind: 'loading' }
  | { kind: 'ready'; suggestions: SuggestPayload; signalCount: number }
  | { kind: 'empty'; reasoning: string; signalCount: number }
  | { kind: 'error'; message: string };

interface Props {
  open: boolean;
  config: CrawlerConfig;
  onClose: () => void;
  onApply: (next: CrawlerConfig) => Promise<void>;
}

// One stable id per row so checkbox state survives re-renders.
const qId = (i: number) => `q-${i}`;
const cId = (i: number) => `c-${i}`;
const rId = (i: number) => `r-${i}`;

export const ConfigSuggestModal = ({ open, config, onClose, onApply }: Props) => {
  const [state, setState] = useState<ModalState>({ kind: 'loading' });
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [applying, setApplying] = useState(false);
  const [applyErr, setApplyErr] = useState<string | null>(null);

  // Map category_id -> display name so we can render "Keywords" instead of
  // "cat-mobyb81c-4". If Claude hands us an unknown id, the row still
  // renders but with the raw id (and gets skipped on apply with a warn).
  const catNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of config.categories) m.set(c.id, c.name);
    return m;
  }, [config.categories]);

  // Fetch suggestions when modal opens. Reset on each open so a stale
  // success/error from a previous session doesn't leak in.
  useEffect(() => {
    if (!open) return;
    setState({ kind: 'loading' });
    setPicked({});
    setApplyErr(null);
    setApplying(false);
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/config/suggest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        const body = (await res.json()) as {
          ok: boolean;
          suggestions?: SuggestPayload;
          signal_count?: number;
          error?: string;
        };
        if (cancelled) return;
        if (!body.ok || !body.suggestions) {
          setState({
            kind: 'error',
            message: body.error || `request failed (HTTP ${res.status})`,
          });
          return;
        }
        const s = body.suggestions;
        const totalActions =
          s.add_queries.length + s.add_companies.length + s.regex_tweaks.length;
        if (totalActions === 0) {
          setState({
            kind: 'empty',
            reasoning: s.reasoning || '',
            signalCount: body.signal_count ?? 0,
          });
        } else {
          setState({
            kind: 'ready',
            suggestions: s,
            signalCount: body.signal_count ?? 0,
          });
        }
      } catch (e) {
        if (cancelled) return;
        setState({ kind: 'error', message: (e as Error).message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // ESC closes (matches AppDetailModal/AddManualModal). We don't dismiss
  // mid-apply because the request is in flight and the parent's state
  // reload depends on us calling onClose AFTER it resolves.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !applying) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, applying]);

  if (!open) return null;

  const toggle = (id: string) =>
    setPicked((prev) => ({ ...prev, [id]: !prev[id] }));

  const pickedCount = Object.values(picked).filter(Boolean).length;

  // Build the next-config and pass it up. The parent owns the actual save
  // so we don't reinvent the save path — spec calls this out explicitly.
  const apply = async () => {
    if (state.kind !== 'ready') return;
    setApplying(true);
    setApplyErr(null);

    const s = state.suggestions;
    const next: CrawlerConfig = {
      ...config,
      categories: config.categories.map((c) => ({ ...c, queries: [...c.queries] })),
      priority_companies: [...config.priority_companies],
      offtopic_title_patterns: [...(config.offtopic_title_patterns ?? [])],
    };

    // Add queries — append into the matching category. Skip if Claude
    // hallucinated a category_id that doesn't exist (logged for inspection).
    for (let i = 0; i < s.add_queries.length; i++) {
      if (!picked[qId(i)]) continue;
      const sug = s.add_queries[i];
      const cat = next.categories.find((c) => c.id === sug.category_id);
      if (!cat) {
        // Hallucinated id — skip with a warn so we can audit if it recurs.
        // eslint-disable-next-line no-console
        console.warn(
          `[ConfigSuggestModal] dropping suggestion: category_id "${sug.category_id}" not found`,
          sug,
        );
        continue;
      }
      // Don't append duplicates (Claude was instructed not to suggest dupes,
      // but defensive — case-insensitive, trim).
      const norm = sug.query.trim();
      const exists = cat.queries.some(
        (q) => q.trim().toLowerCase() === norm.toLowerCase(),
      );
      if (norm && !exists) cat.queries.push(norm);
    }

    // Add companies — lowercased + dedupe (priority_companies is the
    // canonical lowercased list per the existing config-save normalization).
    const seenCo = new Set(next.priority_companies.map((p) => p.toLowerCase()));
    for (let i = 0; i < s.add_companies.length; i++) {
      if (!picked[cId(i)]) continue;
      const name = s.add_companies[i].name.trim().toLowerCase();
      if (name && !seenCo.has(name)) {
        seenCo.add(name);
        next.priority_companies.push(name);
      }
    }

    // Regex tweaks — append to offtopic_title_patterns (the existing field).
    // Dedupe exact-string against current patterns; tolerant of subtle
    // variants (Claude might suggest the same regex with different escaping
    // — a rare edge case the user can clean up via the regex chip editor).
    const existingPatterns = new Set(next.offtopic_title_patterns ?? []);
    const ot = next.offtopic_title_patterns ?? [];
    for (let i = 0; i < s.regex_tweaks.length; i++) {
      if (!picked[rId(i)]) continue;
      const tweak = s.regex_tweaks[i];
      if (tweak.action !== 'add_to_off_topic') continue;
      const pat = tweak.pattern.trim();
      if (pat && !existingPatterns.has(pat)) {
        existingPatterns.add(pat);
        ot.push(pat);
      }
    }
    next.offtopic_title_patterns = ot;

    try {
      await onApply(next);
      onClose();
    } catch (e) {
      setApplyErr((e as Error).message);
    } finally {
      setApplying(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      onClick={() => {
        if (!applying) onClose();
      }}
      role="presentation"
    >
      <div
        className="flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="suggest-title"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <div className="min-w-0">
            <h3
              id="suggest-title"
              className="text-sm font-semibold text-slate-900"
            >
              Suggestions from your feedback
            </h3>
            {state.kind === 'ready' || state.kind === 'empty' ? (
              <div className="mt-0.5 text-[11px] text-slate-500">
                Based on {state.signalCount} feedback{' '}
                {state.signalCount === 1 ? 'signal' : 'signals'} (ratings,
                applications, manual adds).
                {state.kind === 'ready' && (
                  <> Pick the rows you want and click Apply — they get merged into the active profile's <code className="rounded bg-slate-100 px-1 font-mono">config.json</code>.</>
                )}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={applying}
            className="text-xs text-slate-500 hover:text-slate-700 disabled:opacity-40"
            aria-label="Close"
          >
            Esc
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {state.kind === 'loading' && (
            <div className="flex items-center gap-2 rounded border border-slate-200 bg-slate-50 px-3 py-3 text-xs text-slate-700">
              <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-slate-300 border-t-brand-700" />
              <span>Asking Claude to read your signals… (up to 60s)</span>
            </div>
          )}

          {state.kind === 'error' && (
            <div className="rounded border border-rose-200 bg-rose-50 px-3 py-3 text-xs text-rose-800">
              {state.message}
            </div>
          )}

          {state.kind === 'empty' && (
            <>
              {state.reasoning && (
                <p className="mb-3 italic leading-relaxed text-slate-600">
                  {state.reasoning}
                </p>
              )}
              <div className="rounded border border-slate-200 bg-slate-50 px-3 py-3 text-xs text-slate-600">
                No actionable suggestions yet — your config already covers the
                patterns Claude saw.
              </div>
            </>
          )}

          {state.kind === 'ready' && (
            <>
              {state.suggestions.reasoning && (
                <p className="mb-4 text-xs italic leading-relaxed text-slate-600">
                  {state.suggestions.reasoning}
                </p>
              )}

              {state.suggestions.add_queries.length > 0 && (
                <Section title="New queries">
                  {state.suggestions.add_queries.map((s, i) => {
                    const id = qId(i);
                    const catName =
                      catNameById.get(s.category_id) ??
                      `(unknown: ${s.category_id})`;
                    return (
                      <SuggestionRow
                        key={id}
                        id={id}
                        checked={!!picked[id]}
                        onToggle={() => toggle(id)}
                        primary={
                          <>
                            <span className="font-mono">{s.query}</span>
                            <span className="ml-2 rounded bg-brand-50 px-1.5 py-0.5 text-[10px] font-medium text-brand-800">
                              {catName}
                            </span>
                          </>
                        }
                        reason={s.reason}
                      />
                    );
                  })}
                </Section>
              )}

              {state.suggestions.add_companies.length > 0 && (
                <Section title="New priority companies">
                  {state.suggestions.add_companies.map((s, i) => {
                    const id = cId(i);
                    return (
                      <SuggestionRow
                        key={id}
                        id={id}
                        checked={!!picked[id]}
                        onToggle={() => toggle(id)}
                        primary={<span className="font-mono">{s.name}</span>}
                        reason={s.reason}
                      />
                    );
                  })}
                </Section>
              )}

              {state.suggestions.regex_tweaks.length > 0 && (
                <Section title="Off-topic title regex">
                  {state.suggestions.regex_tweaks.map((s, i) => {
                    const id = rId(i);
                    return (
                      <SuggestionRow
                        key={id}
                        id={id}
                        checked={!!picked[id]}
                        onToggle={() => toggle(id)}
                        primary={<span className="font-mono">{s.pattern}</span>}
                        reason={s.reason}
                      />
                    );
                  })}
                </Section>
              )}

              {applyErr && (
                <div className="mt-3 rounded border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
                  Apply failed: {applyErr}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 border-t border-slate-200 bg-slate-50 px-4 py-2.5">
          <button
            type="button"
            onClick={onClose}
            disabled={applying}
            className="inline-flex items-center justify-center rounded border border-slate-300 bg-white px-3 py-1 text-xs font-medium leading-5 text-slate-700 transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700 focus-visible:ring-offset-1 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void apply()}
            disabled={applying || pickedCount === 0 || state.kind !== 'ready'}
            className="inline-flex items-center justify-center rounded border border-transparent bg-brand-700 px-3 py-1 text-xs font-medium leading-5 text-white transition-colors hover:bg-brand-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {applying
              ? 'Applying…'
              : pickedCount === 0
                ? 'Apply selected'
                : `Apply ${pickedCount} selected`}
          </button>
        </div>
      </div>
    </div>
  );
};

// Sentence-cased section header + bordered group. Mirrors the visual
// language of the cards on ConfigPage so the modal feels native.
const Section = ({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) => (
  <div className="mb-4 last:mb-0">
    <h4 className="mb-1.5 text-xs font-semibold tracking-tight text-slate-700">
      {title}
    </h4>
    <ul className="divide-y divide-slate-100 rounded border border-slate-200">
      {children}
    </ul>
  </div>
);

// One checkbox row. Reason is small grey text below the primary content.
// Whole row is a label so the user can tap anywhere to toggle.
const SuggestionRow = ({
  id,
  checked,
  onToggle,
  primary,
  reason,
}: {
  id: string;
  checked: boolean;
  onToggle: () => void;
  primary: React.ReactNode;
  reason: string;
}) => (
  <li>
    <label
      htmlFor={id}
      className={clsx(
        'flex cursor-pointer items-start gap-2.5 px-3 py-2 hover:bg-slate-50',
        checked && 'bg-brand-50/40',
      )}
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-brand-700"
      />
      <div className="min-w-0 flex-1">
        <div className="text-xs text-slate-800">{primary}</div>
        {reason && (
          <div className="mt-0.5 text-[11px] leading-snug text-slate-500">
            {reason}
          </div>
        )}
      </div>
    </label>
  </li>
);
