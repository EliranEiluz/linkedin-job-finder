import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Job } from './types';
import {
  allCategoriesFromJobs,
  applyFilters,
  defaultFilters,
  fromSearchParams,
  isDefault,
  toSearchParams,
  type FilterState,
} from './filters';
import { useAppStatus, useCorpusActions, useDebounced, useUrlSync } from './hooks';
import { StatsBar } from './StatsBar';
import { FilterPanel } from './FilterPanel';
import { JobsTable } from './JobsTable';
import { AddManualModal } from './AddManualModal';
import { normalizeConfig } from './configMigrate';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ok'; jobs: Job[]; loadedAt: Date }
  | { kind: 'empty'; loadedAt: Date }
  | { kind: 'error'; message: string };

const RESULTS_URL = `${import.meta.env.BASE_URL}results.json`;

const fetchJobs = async (): Promise<LoadState> => {
  try {
    // Cache-bust so Refresh re-reads the file even if the symlink target changed.
    const res = await fetch(`${RESULTS_URL}?t=${Date.now()}`);
    if (!res.ok) {
      return {
        kind: 'error',
        message: `Fetch failed: HTTP ${res.status} for ${RESULTS_URL}. Is the symlink in ui/public/ set up?`,
      };
    }
    const text = await res.text();
    if (!text.trim()) {
      return { kind: 'empty', loadedAt: new Date() };
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return {
        kind: 'error',
        message: `results.json is not valid JSON: ${(e as Error).message}`,
      };
    }
    if (!Array.isArray(data)) {
      return {
        kind: 'error',
        message: 'results.json root must be an array.',
      };
    }
    if (data.length === 0) {
      return { kind: 'empty', loadedAt: new Date() };
    }
    return { kind: 'ok', jobs: data as Job[], loadedAt: new Date() };
  } catch (e) {
    return { kind: 'error', message: (e as Error).message };
  }
};

// Empty-state and error-state per §3.5: text-only headlines, no 6xl emoji.
// The text carries the message; a CTA / fix-it block carries the action.
const EmptyState = () => (
  <div className="flex h-full flex-col items-center justify-center px-6 py-20 text-center">
    <h2 className="mb-2 text-xl font-semibold text-slate-800">No jobs yet</h2>
    <p className="mb-3 max-w-md text-sm text-slate-600">
      First time? Visit the <span className="font-semibold">Setup</span> tab to
      build a config from your CV, then <span className="font-semibold">Crawler Config</span>{' '}
      to run a scrape.
    </p>
    <p className="mb-6 max-w-md text-sm text-slate-600">
      Or run the scraper from the terminal:
    </p>
    <code className="rounded bg-slate-900 px-4 py-2 font-mono text-sm text-emerald-300">
      python3 search.py
    </code>
    <p className="mt-6 text-xs text-slate-500">
      After the run finishes, hit <span className="font-semibold">Refresh</span> above.
    </p>
  </div>
);

const ErrorState = ({ message }: { message: string }) => (
  <div className="flex h-full flex-col items-center justify-center px-6 py-20 text-center">
    <h2 className="mb-2 text-xl font-semibold text-slate-800">
      Couldn't load results.json
    </h2>
    <p className="mb-5 max-w-lg text-sm text-slate-600">{message}</p>
    <div className="rounded border border-slate-300 bg-white p-4 text-left text-xs">
      <p className="mb-2 font-semibold text-slate-700">Likely fix — create the symlink:</p>
      <code className="block whitespace-pre-wrap rounded bg-slate-900 p-3 font-mono text-emerald-300">
        cd {'<repo root>'}/ui/public{'\n'}
        ln -sf ../../results.json results.json
      </code>
    </div>
  </div>
);

// 4-row skeleton roughly matching JobsTable's column shape. Uses Tailwind
// `animate-pulse` for the gentle pulse — no extra deps.
// Build a list of "non-default" filter description chips for the empty state.
// Each entry shows what's been narrowed without dumping the whole FilterState.
const activeFilterChips = (f: FilterState): string[] => {
  const chips: string[] = [];
  const d = defaultFilters();
  // Fits — list whichever subset is currently checked when it differs from default.
  const fitsArr = [...f.fits].sort();
  const defaultFitsArr = [...d.fits].sort();
  if (fitsArr.join(',') !== defaultFitsArr.join(','))
    chips.push(`Fit: ${fitsArr.join(', ') || '(none)'}`);
  if (f.priority !== d.priority) chips.push(`Priority: ${f.priority}`);
  if (f.applied !== d.applied)
    chips.push(`Applied: ${f.applied === 'yes' ? 'only' : 'hide'}`);
  if (f.categories.size !== d.categories.size)
    chips.push(`Categories: ${f.categories.size}`);
  if (f.scoredBy.size !== d.scoredBy.size)
    chips.push(`Scored by: ${[...f.scoredBy].join(', ') || '(none)'}`);
  if (f.sources.size !== d.sources.size)
    chips.push(`Source: ${[...f.sources].join(', ') || '(none)'}`);
  if (f.scoreMin !== d.scoreMin || f.scoreMax !== d.scoreMax)
    chips.push(`Score: ${f.scoreMin}–${f.scoreMax}`);
  if (f.dateQuick !== d.dateQuick) chips.push(`Found: ${f.dateQuick}`);
  if (f.search) chips.push(`Search: "${f.search}"`);
  return chips;
};

const LoadingState = () => {
  // Approximate JobsTable column widths so the layout doesn't jump.
  const cols = [
    'w-6', 'w-12', 'w-32', 'w-56', 'w-32', 'w-14', 'w-10', 'w-20', 'w-20', 'w-24', 'w-24',
  ];
  return (
    <div className="h-full overflow-hidden">
      <div className="border-b border-slate-200 bg-slate-50 px-3 py-2">
        <div className="flex gap-3">
          {cols.map((w, i) => (
            <div key={i} className={`h-3 ${w} rounded bg-slate-200`} />
          ))}
        </div>
      </div>
      {[0, 1, 2, 3].map((r) => (
        <div
          key={r}
          className="flex animate-pulse gap-3 border-b border-slate-100 px-3 py-3"
        >
          {cols.map((w, i) => (
            <div key={i} className={`h-3 ${w} rounded bg-slate-200`} />
          ))}
        </div>
      ))}
    </div>
  );
};

export const CorpusPage = () => {
  const [filters, setFilters] = useState<FilterState>(() =>
    fromSearchParams(new URLSearchParams(window.location.search)),
  );
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [categoryNamesById, setCategoryNamesById] = useState<Map<string, string>>(
    () => new Map(),
  );
  // True after the first /api/config fetch settles (success OR failure).
  // Drives the JobsTable's category-cell fallback: while !configReady, an
  // unresolved id renders as "…" instead of the noisy de-snaked id, so the
  // user doesn't see a flash of "cat security swe" before the proper
  // "Security SWE" name lands ~100-300ms later.
  const [configReady, setConfigReady] = useState(false);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const { setAppStatus } = useAppStatus();
  const { rateJob, deleteJobs, rescoreJobs, pushToEndJobs } = useCorpusActions();
  // Set of job ids currently being rescored. Tied to ids (not the checkbox
  // selection) so unchecking a row mid-rescore doesn't make the loading
  // indicator vanish — the row stays visually "in flight" until the POST
  // resolves. Multiple overlapping rescores compose by id.
  const [rescoringIds, setRescoringIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  // Source of truth for "applied" is now the server (`job.app_status`),
  // unifying state with the Tracker tab. localStorage was a per-browser
  // silo that diverged: iPhone Safari and Mac Chrome each had their own
  // independent set, and toggling in Corpus never reached the Tracker.
  //
  // We keep the existing `applied: Set<string>` prop interface for
  // JobsTable / StatsBar / filters by deriving it from the corpus data,
  // overlaid with optimistic in-flight overrides so checkbox clicks feel
  // instant (the API round-trip is ~100-300ms).
  const [appliedPending, setAppliedPending] = useState<
    Map<string, 'add' | 'remove'>
  >(new Map());

  // Memoized so downstream useMemo / useCallback dep arrays don't churn
  // every render — re-creating an empty `[]` literal would invalidate them.
  const allJobs: Job[] = useMemo(
    () => (state.kind === 'ok' ? state.jobs : []),
    [state],
  );

  // Per-row "applied but keep in place" override. When the user clicks
  // "Apply but keep in place" in the popover (or the per-row equivalent),
  // we add the id here so the JobsTable's `applied` sort accessor reads
  // the row as NOT-applied for sort purposes — even though the row IS
  // applied for everything else (pill, filter, dimmed treatment). Cleared
  // on stale-event reload so the natural sort picks back up after a fresh
  // scrape repopulates the corpus.
  // (keepInPlaceIds removed — sort is now driven purely by pushed_to_end,
  // which is server-persisted. Apply with moveToEnd=false sets
  // pushed_to_end=false, with moveToEnd=true sets pushed_to_end=true.)

  // "Push to end without applying" — promoted from local-only state to a
  // persisted field on the row (`pushed_to_end`). The Set passed into
  // JobsTable is derived from corpus rows (true = in set) plus an
  // optimistic-overrides Map so clicks feel instant before the
  // /api/corpus/push-to-end round-trip + corpus reload completes.
  const [pushedPending, setPushedPending] = useState<
    Map<string, 'add' | 'remove'>
  >(new Map());

  const pushedToEndIds = useMemo(() => {
    const result = new Set<string>();
    for (const j of allJobs) {
      const isPushedOnServer = j.pushed_to_end === true;
      const pendingOp = pushedPending.get(j.id);
      const effective =
        pendingOp === 'add'
          ? true
          : pendingOp === 'remove'
            ? false
            : isPushedOnServer;
      if (effective) result.add(j.id);
    }
    return result;
  }, [allJobs, pushedPending]);

  const pushToEnd = useCallback(
    (id: string) => {
      setPushedPending((m) => new Map(m).set(id, 'add'));
      void pushToEndJobs([id], true).then((r) => {
        // On success: leave the pending mark — the corpus reload
        // (fired via fireStale inside the hook) will repopulate the
        // row's pushed_to_end and the pending mark becomes redundant.
        // We GC the pending Map after a beat to keep it small.
        if (r.ok) {
          window.setTimeout(
            () => { setPushedPending((m) => {
              const next = new Map(m);
              next.delete(id);
              return next;
            }); },
            1500,
          );
        } else {
          // Roll back optimistic flip on failure.
          setPushedPending((m) => {
            const next = new Map(m);
            next.delete(id);
            return next;
          });
          window.alert(`Move to end failed: ${r.error}`);
        }
      });
    },
    [pushToEndJobs],
  );

  const restoreFromEnd = useCallback(
    (id: string) => {
      setPushedPending((m) => new Map(m).set(id, 'remove'));
      void pushToEndJobs([id], false).then((r) => {
        if (r.ok) {
          window.setTimeout(
            () => { setPushedPending((m) => {
              const next = new Map(m);
              next.delete(id);
              return next;
            }); },
            1500,
          );
        } else {
          setPushedPending((m) => {
            const next = new Map(m);
            next.delete(id);
            return next;
          });
          window.alert(`Restore failed: ${r.error}`);
        }
      });
    },
    [pushToEndJobs],
  );

  const pushManyToEnd = useCallback(
    (ids: string[]) => {
      setPushedPending((m) => {
        const next = new Map(m);
        for (const id of ids) next.set(id, 'add');
        return next;
      });
      void pushToEndJobs(ids, true).then((r) => {
        if (r.ok) {
          window.setTimeout(
            () => { setPushedPending((m) => {
              const next = new Map(m);
              for (const id of ids) next.delete(id);
              return next;
            }); },
            1500,
          );
        } else {
          setPushedPending((m) => {
            const next = new Map(m);
            for (const id of ids) next.delete(id);
            return next;
          });
          window.alert(`Move to end failed: ${r.error}`);
        }
      });
    },
    [pushToEndJobs],
  );

  // Global "should Apply move the row to the end?" preference. Persists in
  // localStorage so the choice survives reloads. `null` (= no key set) means
  // "the user has not made an explicit choice yet" — the popover shows two
  // buttons + a Remember toggle. Once set, the popover shows one button.
  // Bulk Apply also reads this; if unset, it defaults to true (matches
  // today's silent move-to-end behaviour for users who never opened the
  // popover before).
  const APPLY_PREF_KEY = 'corpus.applyMovesToEnd';
  const [applyMovesToEnd, setApplyMovesToEndState] = useState<boolean | null>(() => {
    try {
      const v = window.localStorage.getItem(APPLY_PREF_KEY);
      if (v === 'true') return true;
      if (v === 'false') return false;
      return null;
    } catch {
      return null;
    }
  });
  const setApplyMovesToEnd = useCallback((v: boolean | null) => {
    try {
      if (v === null) window.localStorage.removeItem(APPLY_PREF_KEY);
      else window.localStorage.setItem(APPLY_PREF_KEY, v ? 'true' : 'false');
    } catch {
      // localStorage unavailable (private mode, etc.) — pref stays in-memory.
    }
    setApplyMovesToEndState(v);
  }, []);

  const applied = useMemo(() => {
    const result = new Set<string>();
    for (const j of allJobs) {
      const isAppliedOnServer =
        j.app_status != null && j.app_status !== 'new';
      const override = appliedPending.get(j.id);
      if (override === 'add') result.add(j.id);
      else if (override === 'remove') {
        // explicitly removed in-flight — skip
      } else if (isAppliedOnServer) {
        result.add(j.id);
      }
    }
    return result;
  }, [allJobs, appliedPending]);

  const toggleApplied = useCallback(
    (id: string) => {
      const isCurrentlyApplied = applied.has(id);
      const nextStatus: 'applied' | 'new' = isCurrentlyApplied
        ? 'new'
        : 'applied';
      // Optimistic flip — visible immediately.
      setAppliedPending((prev) => {
        const next = new Map(prev);
        next.set(id, isCurrentlyApplied ? 'remove' : 'add');
        return next;
      });
      void setAppStatus(id, nextStatus).then((r) => {
        // Either way, drop the override — server fetch (fired by
        // setAppStatus's fireStale event) will reconcile state.
        setAppliedPending((prev) => {
          const next = new Map(prev);
          next.delete(id);
          return next;
        });
        if (!r.ok) {
          // Best-effort: surface the error inline. The corpus refresh
          // will reset the visible state regardless.
          console.error('app-status toggle failed:', r.error);
        }
      });
    },
    [applied, setAppStatus],
  );

  const setAppliedMany = useCallback(
    (ids: string[], appliedState: boolean) => {
      const nextStatus: 'applied' | 'new' = appliedState ? 'applied' : 'new';
      setAppliedPending((prev) => {
        const next = new Map(prev);
        for (const id of ids) {
          next.set(id, appliedState ? 'add' : 'remove');
        }
        return next;
      });
      // Bulk apply also flips pushed_to_end per the user's pref. Bulk
      // unapply does NOT touch pushed_to_end — the user may have a
      // mix of states they want preserved across the unapply.
      if (appliedState) {
        const moveToEnd = applyMovesToEnd ?? true;
        setPushedPending((prev) => {
          const next = new Map(prev);
          for (const id of ids) next.set(id, moveToEnd ? 'add' : 'remove');
          return next;
        });
        void pushToEndJobs(ids, moveToEnd);
      }
      // Fire all in parallel — the existing endpoint is per-id; for
      // typical bulk-toggles (visible page = up to 200 rows) this is fine.
      void Promise.all(
        ids.map((id) => setAppStatus(id, nextStatus)),
      ).then((results) => {
        setAppliedPending((prev) => {
          const next = new Map(prev);
          for (const id of ids) next.delete(id);
          return next;
        });
        const failedCount = results.filter((r) => !r.ok).length;
        if (failedCount > 0) {
          console.error(`bulk app-status: ${failedCount} of ${ids.length} failed`);
        }
      });
    },
    [setAppStatus, applyMovesToEnd, pushToEndJobs],
  );
  // Wrap deleteJobs into a single-id helper for the row popover.
  const deleteOne = useCallback(
    (id: string) => deleteJobs([id]),
    [deleteJobs],
  );

  // Apply a single row with explicit "move to end?" choice. Both fields
  // are now persisted server-side as separate concerns: `app_status`
  // says "I applied to this", `pushed_to_end` says "sort to bottom".
  // moveToEnd=true → both. moveToEnd=false → applied without demoting.
  const applyOne = useCallback(
    (id: string, moveToEnd: boolean) => {
      setAppliedPending((prev) => {
        const next = new Map(prev);
        next.set(id, 'add');
        return next;
      });
      // Optimistic flip on pushed_to_end too, then fire-and-forget
      // both POSTs in parallel.
      setPushedPending((prev) => {
        const next = new Map(prev);
        next.set(id, moveToEnd ? 'add' : 'remove');
        return next;
      });
      void pushToEndJobs([id], moveToEnd);
      void setAppStatus(id, 'applied').then((r) => {
        setAppliedPending((prev) => {
          const next = new Map(prev);
          next.delete(id);
          return next;
        });
        if (!r.ok) console.error('apply failed:', r.error);
      });
    },
    [setAppStatus, pushToEndJobs],
  );

  const unapplyOne = useCallback(
    (id: string) => {
      setAppliedPending((prev) => {
        const next = new Map(prev);
        next.set(id, 'remove');
        return next;
      });
      // Un-applying does NOT touch pushed_to_end — the user may have
      // explicitly demoted the row independently of the apply state,
      // and clearing the demote here would surprise them. They can
      // restore the natural sort separately via the popover toggle.
      void setAppStatus(id, 'new').then((r) => {
        setAppliedPending((prev) => {
          const next = new Map(prev);
          next.delete(id);
          return next;
        });
        if (!r.ok) console.error('unapply failed:', r.error);
      });
    },
    [setAppStatus],
  );

  const reload = useCallback(async () => {
    setState({ kind: 'loading' });
    setState(await fetchJobs());
  }, []);

  // Wraps useCorpusActions().rateJob with an optimistic local state patch.
  // We deliberately do NOT fire corpus-stale on a rate save (that would
  // wipe an in-progress comment edit elsewhere — see commit d87be0a). But
  // the row's `rating` / `comment` props still need to reflect the save
  // when the popover closes and re-opens; otherwise the editor remounts
  // reading stale props until the user hard-refreshes.
  // Fix: mutate the matching row in the in-memory corpus on save success.
  // No reload, no remount disruption, fresh props on next open.
  const wrappedRateJob = useCallback(
    async (id: string, rating: number | null, comment?: string | null) => {
      const result = await rateJob(id, rating, comment);
      if (result.ok) {
        setState((prev) => {
          if (prev.kind !== 'ok') return prev;
          const nowIso = new Date().toISOString();
          const nextJobs = prev.jobs.map((j) => {
            if (j.id !== id) return j;
            const updated: Job = { ...j, rating, rated_at: nowIso };
            if (comment !== undefined) updated.comment = comment;
            return updated;
          });
          return { ...prev, jobs: nextJobs };
        });
      }
      return result;
    },
    [rateJob],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  // Fetch /api/config once so we can render category names ("Security",
  // "Companies") instead of de-snaked ids ("Cat Mobyb81c 5"). Best-effort:
  // any failure leaves the map empty. The configReady flag flips either
  // way so the table stops showing the loading placeholder.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/config?t=${Date.now().toString()}`);
        if (!res.ok) return;
        const cfg = normalizeConfig(await res.json());
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- mutated by cleanup
        if (cancelled) return;
        const m = new Map<string, string>();
        for (const c of cfg.categories) {
          if (c.id && c.name) m.set(c.id, c.name);
        }
        setCategoryNamesById(m);
      } catch {
        // ignore — fallback display is fine
      } finally {
        // `cancelled` is mutated by the cleanup return below; the linter
        // can't see that mutation across the await boundary, so disable
        // the always-truthy check here.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (!cancelled) setConfigReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Merge category_name values stored on corpus rows into the lookup map.
  // This is what makes orphan ids (categories that were renamed/replaced
  // by a later config rewrite) keep displaying their ORIGINAL name on
  // existing rows. New scrapes write category_name at scrape time; old
  // rows backfilled by `tools/backfill_category_name.py`.
  useEffect(() => {
    if (allJobs.length === 0) return;
    let changed = false;
    const m = new Map(categoryNamesById);
    for (const j of allJobs) {
      const id = j.category;
      const name = j.category_name;
      if (id && name && !m.has(id)) {
        m.set(id, name);
        changed = true;
      }
    }
    if (changed) setCategoryNamesById(m);
    // Intentionally NOT depending on categoryNamesById to avoid a loop —
    // we only want this to react to allJobs changes. The map merge is
    // additive so it's safe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allJobs]);

  // Listen for ScrapeRunPanel's "scrape finished" signal and re-fetch.
  useEffect(() => {
    const onStale = () => {
      void reload();
    };
    window.addEventListener('linkedinjobs:corpus-stale', onStale);
    return () => { window.removeEventListener('linkedinjobs:corpus-stale', onStale); };
  }, [reload]);

  // URL sync — preserve the active tab when rewriting filters.
  const urlParams = useMemo(() => {
    const p = toSearchParams(filters);
    p.set('tab', 'corpus');
    return p;
  }, [filters]);
  useUrlSync(urlParams);

  // —— B4: Keyboard navigation ——
  // State declarations only (cursor + cheatsheet). The actual keydown
  // handler + clamp effect live AFTER `filtered` is computed below — they
  // need to read it without violating temporal-dead-zone rules.
  const [cursorIndex, setCursorIndex] = useState(0);
  const [showCheatsheet, setShowCheatsheet] = useState(false);
  const [addManualOpen, setAddManualOpen] = useState(false);

  // Debounce search for the applyFilters pass (keeps the input snappy).
  const debouncedSearch = useDebounced(filters.search, 120);
  const effectiveFilters = useMemo(
    () => ({ ...filters, search: debouncedSearch }),
    [filters, debouncedSearch],
  );

  // (allJobs is declared up top — used by both the `applied` derivation
  // and the filter pipeline below.)
  const filtered = useMemo(
    () => applyFilters(allJobs, effectiveFilters, applied),
    [allJobs, effectiveFilters, applied],
  );
  // Dynamic category list for the filter sidebar — unions whatever category
  // ids the loaded corpus contains (so user-defined categories auto-surface).
  const availableCategories = useMemo(
    () => allCategoriesFromJobs(allJobs),
    [allJobs],
  );

  // —— B4 keyboard nav (handler + clamp; state lives above) ——
  // Keys:  / focus search · Esc blur/close · j↓ k↑ cursor · a toggle applied
  //        · o open in new tab · ? cheatsheet
  // Enter intentionally NOT bound (would require lifting JobsTable's
  // `expanded` Set state — out of scope for this pass).
  useEffect(() => {
    if (cursorIndex >= filtered.length) {
      setCursorIndex(filtered.length === 0 ? 0 : filtered.length - 1);
    }
  }, [filtered.length, cursorIndex]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const isInput =
        !!t &&
        (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (e.key === 'Escape') {
        if (showCheatsheet) {
          setShowCheatsheet(false);
          e.preventDefault();
          return;
        }
        if (isInput) (t).blur();
        return;
      }
      if (isInput) return;
      switch (e.key) {
        case '/':
          e.preventDefault();
          searchRef.current?.focus();
          searchRef.current?.select();
          break;
        case '?':
          e.preventDefault();
          setShowCheatsheet((v) => !v);
          break;
        case 'j':
        case 'ArrowDown':
          if (filtered.length === 0) break;
          e.preventDefault();
          setCursorIndex((i) => Math.min(filtered.length - 1, i + 1));
          break;
        case 'k':
        case 'ArrowUp':
          if (filtered.length === 0) break;
          e.preventDefault();
          setCursorIndex((i) => Math.max(0, i - 1));
          break;
        case 'a': {
          const j = filtered[cursorIndex];
          if (j) { e.preventDefault(); toggleApplied(j.id); }
          break;
        }
        case 'o': {
          const j = filtered[cursorIndex];
          if (j?.url) {
            e.preventDefault();
            window.open(j.url, '_blank', 'noopener,noreferrer');
          }
          break;
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); };
  }, [cursorIndex, filtered, showCheatsheet, toggleApplied]);

  const cursorRowId = filtered[cursorIndex]?.id ?? null;

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar collapsed: Refresh + Add Job moved into StatsBar's right
          edge; the redundant "loaded HH:MM" line is now a tooltip on the
          Refresh button. See §2 alt A in DESIGN_UI_POLISH.md. */}
      <AddManualModal
        open={addManualOpen}
        onClose={() => { setAddManualOpen(false); }}
      />

      {state.kind === 'ok' && (
        <StatsBar
          all={state.jobs}
          filtered={filtered}
          applied={applied}
          loadedAt={state.loadedAt}
          onRefresh={() => void reload()}
          refreshing={false}
          onAddManual={() => { setAddManualOpen(true); }}
          categoryNamesById={categoryNamesById}
        />
      )}

      {/* On mobile, FilterPanel renders a horizontal toggle bar (md:hidden)
          that must stack ABOVE the table — not sit beside it. flex-col on
          mobile achieves that; md+ restores the desktop sidebar+main layout. */}
      <div className="flex flex-1 flex-col overflow-hidden md:flex-row">
        {state.kind === 'ok' && (
          <FilterPanel
            value={filters}
            onChange={setFilters}
            searchRef={searchRef}
            availableCategories={availableCategories}
            appliedCount={applied.size}
            categoryNamesById={categoryNamesById}
          />
        )}

        <main className="flex-1 overflow-hidden bg-white">
          {state.kind === 'loading' && <LoadingState />}
          {state.kind === 'error' && <ErrorState message={state.message} />}
          {state.kind === 'empty' && <EmptyState />}
          {state.kind === 'ok' && (
            <JobsTable
              data={filtered}
              applied={applied}
              pushedToEndIds={pushedToEndIds}
              onPushToEnd={pushToEnd}
              onRestoreFromEnd={restoreFromEnd}
              onPushManyToEnd={pushManyToEnd}
              onToggleApplied={toggleApplied}
              onSetAppliedMany={setAppliedMany}
              onApply={applyOne}
              onUnapply={unapplyOne}
              applyMovesToEnd={applyMovesToEnd}
              onSetApplyPref={setApplyMovesToEnd}
              hasNonDefaultFilter={!isDefault(filters)}
              onDeleteAllFiltered={() => { void deleteJobs(filtered.map((j) => j.id)); }}
              onRescoreMany={async (ids) => {
                setRescoringIds((prev) => {
                  const next = new Set(prev);
                  for (const id of ids) next.add(id);
                  return next;
                });
                try {
                  const r = await rescoreJobs(ids);
                  if (!r.ok) {
                    window.alert(`Re-score failed: ${r.error}`);
                  } else {
                    const claude = r.claude_rescored ?? r.rescored ?? 0;
                    const regex = r.regex_fallback ?? 0;
                    const failed = r.failed ?? 0;
                    const parts: string[] = [];
                    if (claude > 0) parts.push(`${claude} re-scored by Claude`);
                    if (regex > 0) {
                      parts.push(
                        `${regex} unchanged (Claude unavailable — kept regex score)`,
                      );
                    }
                    if (failed > 0) parts.push(`${failed} failed`);
                    // Only nag with an alert when something went wrong or
                    // partially. A clean "all by Claude" run stays silent.
                    if (regex > 0 || failed > 0) {
                      window.alert(
                        `Re-score of ${ids.length} job(s):\n  ` +
                          parts.join('\n  ') +
                          (regex > 0
                            ? '\n\nTry again in a few minutes — check run.log if it persists.'
                            : ''),
                      );
                    }
                  }
                } finally {
                  setRescoringIds((prev) => {
                    const next = new Set(prev);
                    for (const id of ids) next.delete(id);
                    return next;
                  });
                }
              }}
              rescoringIds={rescoringIds}
              onRate={wrappedRateJob}
              onDelete={deleteOne}
              categoryNamesById={categoryNamesById}
              configReady={configReady}
              cursorRowId={cursorRowId}
              emptyState={
                isDefault(filters) ? (
                  <span>No jobs in the corpus.</span>
                ) : (
                  <div className="flex flex-col items-center gap-3">
                    <span>No jobs match the current filters.</span>
                    <div className="flex flex-wrap justify-center gap-1.5">
                      {activeFilterChips(filters).map((c) => (
                        <span
                          key={c}
                          className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-xs text-slate-600"
                        >
                          {c}
                        </span>
                      ))}
                    </div>
                    <button
                      type="button"
                      onClick={() => { setFilters(defaultFilters()); }}
                      className="rounded border border-brand-700 bg-white px-3 py-1 text-xs font-medium text-brand-700 hover:bg-brand-50"
                    >
                      Clear all filters
                    </button>
                  </div>
                )
              }
            />
          )}
        </main>
      </div>

      {/* B4 keyboard cheatsheet overlay (toggle with `?`) */}
      {showCheatsheet && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-4"
          onClick={() => { setShowCheatsheet(false); }}
        >
          <div
            className="max-w-md rounded-lg border border-slate-200 bg-white p-5 shadow-xl"
            onClick={(e) => { e.stopPropagation(); }}
          >
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900">Keyboard shortcuts</h3>
              <button
                type="button"
                onClick={() => { setShowCheatsheet(false); }}
                className="text-xs text-slate-500 hover:text-slate-700"
              >
                Esc
              </button>
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
              {[
                ['/', 'Focus search'],
                ['j  ↓', 'Cursor down'],
                ['k  ↑', 'Cursor up'],
                ['a', 'Toggle applied on cursor row'],
                ['o', 'Open cursor row on LinkedIn'],
                ['?', 'Toggle this cheatsheet'],
                ['Esc', 'Blur input / close cheatsheet'],
              ].map(([k, v]) => (
                <Fragment key={k}>
                  <dt>
                    <kbd className="rounded border border-slate-300 bg-slate-50 px-1.5 py-0.5 font-mono text-xs text-slate-700">
                      {k}
                    </kbd>
                  </dt>
                  <dd className="text-slate-600">{v}</dd>
                </Fragment>
              ))}
            </dl>
          </div>
        </div>
      )}
    </div>
  );
};
