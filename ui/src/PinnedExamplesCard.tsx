// Management card for the user's hard-pinned few-shot example ids
// (issue #124). Lives in the Crawler Config tab's "AI Pipeline" section.
//
// Source of truth for the list is config.pinned_examples (a list[str] of
// job ids). The card resolves each id against the live results.json to
// render title + company + score, then exposes a per-row unpin button
// that calls /api/corpus/pin-example with pinned=false.
//
// Behavior:
//   - Count display: `N / cap slots used` where cap = feedback_examples_max
//     (with the same default + clamp the backend uses). Cap is intentionally
//     a hint, not a hard wall — the picker drops excess pinned ids from the
//     end of the list, never from the middle, so the user can see at a
//     glance whether their pin list is over budget.
//   - Each pinned row shows title (truncated), company, and score chip.
//     Ids that no longer resolve against results.json render with a muted
//     "(not in current corpus)" label — they stay in the config until the
//     user explicitly unpins. This mirrors the backend's silent-drop
//     behavior at READ time.
//   - Empty state nudges the user toward the corpus row action menu.
//
// The card never writes config.json directly — it goes through the
// /api/corpus/pin-example endpoint so the read-modify-write is atomic
// and the backend's normalizer is the single source of truth.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { postJson } from './api';
import type { Job } from './types';

// Mirror of search.py:FEEDBACK_EXAMPLES_MAX_DEFAULT — the card just needs
// a sensible fallback when feedback_examples_max isn't set in the config.
// Picker clamps to [0, 20] backend-side; UI just renders the count.
const FEEDBACK_EXAMPLES_MAX_DEFAULT = 6;

const RESULTS_URL = `${import.meta.env.BASE_URL}results.json`;

export interface PinnedExamplesCardProps {
  // Current list of pinned job ids (already normalized by the config
  // load path — non-empty trimmed strings, deduped, user-ordered).
  pinnedIds: string[];
  // The few-shot count config knob. Drives the "N / cap slots used"
  // display. Optional — when undefined the card uses the default cap.
  cap?: number;
  // Called after a successful unpin so the parent can update its draft
  // state without a /api/config round-trip. The backend returns the
  // post-mutation list; we pass it through so the parent stays in sync
  // with whatever the normalizer settled on.
  onPinnedChange: (next: string[]) => void;
}

// Slim projection of the corpus row — only the fields the card needs.
// Resolved off the live results.json fetch; missing id => row stays
// rendered with the "(not in current corpus)" placeholder.
interface PinnedRowDisplay {
  id: string;
  title?: string;
  company?: string;
  score?: number | null;
  missing: boolean;
}

const fetchCorpusById = async (
  ids: string[],
): Promise<Map<string, Job>> => {
  const out = new Map<string, Job>();
  if (ids.length === 0) return out;
  try {
    const res = await fetch(`${RESULTS_URL}?t=${Date.now().toString()}`);
    if (!res.ok) return out;
    const text = await res.text();
    if (!text.trim()) return out;
    const data: unknown = JSON.parse(text);
    if (!Array.isArray(data)) return out;
    const wanted = new Set(ids);
    for (const raw of data) {
      if (!raw || typeof raw !== 'object') continue;
      const j = raw as Job;
      if (typeof j.id === 'string' && wanted.has(j.id)) {
        out.set(j.id, j);
      }
    }
  } catch {
    // ignore — empty map renders as "(not in current corpus)" rows
  }
  return out;
};

export const PinnedExamplesCard = ({
  pinnedIds, cap, onPinnedChange,
}: PinnedExamplesCardProps) => {
  const [byId, setById] = useState<Map<string, Job>>(() => new Map());
  const [resolving, setResolving] = useState<boolean>(false);
  // Per-row in-flight flag so the unpin button can show a disabled
  // state without yanking the row out of the list while the round-trip
  // is mid-flight (the parent state update lands when the POST resolves).
  const [pendingUnpinId, setPendingUnpinId] = useState<string | null>(null);

  // Resolve ids against results.json whenever the list changes (e.g.
  // a different profile is loaded, or the user pinned/unpinned from
  // the corpus tab and the parent passed a new list down).
  useEffect(() => {
    let cancelled = false;
    setResolving(true);
    void fetchCorpusById(pinnedIds).then((m) => {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- mutated by cleanup
      if (cancelled) return;
      setById(m);
      setResolving(false);
    });
    return () => {
      cancelled = true;
    };
  }, [pinnedIds]);

  const rows: PinnedRowDisplay[] = useMemo(() => {
    return pinnedIds.map((id) => {
      const j = byId.get(id);
      if (!j) {
        return { id, missing: true };
      }
      return {
        id,
        title: j.title,
        company: j.company,
        score: j.score ?? null,
        missing: false,
      };
    });
  }, [pinnedIds, byId]);

  const effectiveCap = cap ?? FEEDBACK_EXAMPLES_MAX_DEFAULT;
  const overBudget = pinnedIds.length > effectiveCap;

  const unpin = useCallback(
    async (id: string) => {
      setPendingUnpinId(id);
      try {
        const res = await postJson('/api/corpus/pin-example', { id, pinned: false });
        const body = (await res.json()) as {
          ok?: boolean;
          error?: string;
          pinned_examples?: string[];
        };
        if (!body.ok) {
          window.alert(`Unpin failed: ${body.error ?? `HTTP ${res.status.toString()}`}`);
          return;
        }
        // Hand the authoritative post-mutation list back up so the
        // card re-renders with the unpinned row gone (and the count
        // updates instantly).
        if (body.pinned_examples) onPinnedChange(body.pinned_examples);
      } catch (e) {
        window.alert(`Unpin failed: ${(e as Error).message}`);
      } finally {
        setPendingUnpinId(null);
      }
    },
    [onPinnedChange],
  );

  return (
    <section className="mb-4 rounded border border-slate-200 bg-white">
      <header className="border-b border-slate-200 px-4 py-3">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-800">
            Pinned few-shot examples
          </h3>
          <span
            className={
              overBudget
                ? 'text-xs font-medium tabular-nums text-amber-700'
                : 'text-xs tabular-nums text-slate-500'
            }
            title={
              overBudget
                ? 'Pinned list exceeds the few-shot slot cap — the picker drops excess pinned ids from the end'
                : undefined
            }
          >
            {pinnedIds.length} / {effectiveCap} slots used
          </span>
        </div>
        <p className="mt-1 text-xs text-slate-500">
          These jobs are always included in the calibration examples sent
          to the LLM, alongside the most recent ones.
        </p>
      </header>

      {pinnedIds.length === 0 ? (
        <div className="px-4 py-6 text-center text-xs text-slate-500">
          No pinned examples yet. Pin from any corpus row&rsquo;s actions menu.
        </div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {rows.map((r) => {
            const isPending = pendingUnpinId === r.id;
            return (
              <li
                key={r.id}
                className="flex items-center gap-3 px-4 py-2.5 text-xs"
              >
                <div className="min-w-0 flex-1">
                  {r.missing ? (
                    <>
                      <div className="truncate font-mono text-slate-500">
                        {r.id}
                      </div>
                      <div className="text-[11px] text-slate-400">
                        (not in current corpus &mdash; pin preserved)
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="truncate font-medium text-slate-800">
                        {r.title ?? <span className="italic text-slate-400">(no title)</span>}
                      </div>
                      <div className="truncate text-[11px] text-slate-500">
                        {r.company ?? '—'}
                      </div>
                    </>
                  )}
                </div>
                {!r.missing && r.score != null && (
                  <span className="inline-flex shrink-0 items-center rounded-full bg-slate-100 px-2 py-0.5 tabular-nums text-slate-600">
                    score {r.score}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => { void unpin(r.id); }}
                  disabled={isPending}
                  className={
                    'shrink-0 rounded border px-2 py-1 text-[11px] font-medium transition-colors ' +
                    (isPending
                      ? 'cursor-not-allowed border-slate-200 bg-slate-50 text-slate-400'
                      : 'border-slate-300 bg-white text-slate-600 hover:border-red-300 hover:bg-red-50 hover:text-red-700')
                  }
                  title="Remove this row from the LLM few-shot examples"
                  aria-label={`Unpin ${r.title ?? r.id}`}
                >
                  {isPending ? 'Unpinning…' : 'Unpin'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {resolving && pinnedIds.length > 0 && (
        <div className="border-t border-slate-100 px-4 py-1.5 text-[11px] text-slate-400">
          Resolving corpus rows…
        </div>
      )}
    </section>
  );
};
