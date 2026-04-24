import { useCallback, useEffect, useRef, useState } from 'react';

export const useDebounced = <T>(value: T, delay = 150): T => {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setV(value), delay);
    return () => window.clearTimeout(id);
  }, [value, delay]);
  return v;
};

/** Per-job "applied" state, backed by localStorage so it survives reloads
 *  and scraper reruns. Identity is the LinkedIn job ID. */
const APPLIED_KEY = 'linkedinjobs:applied';

const readApplied = (): Set<string> => {
  try {
    const raw = window.localStorage.getItem(APPLIED_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr.filter((x) => typeof x === 'string')) : new Set();
  } catch {
    return new Set();
  }
};

const writeApplied = (s: Set<string>) => {
  try {
    window.localStorage.setItem(APPLIED_KEY, JSON.stringify([...s]));
  } catch {
    /* localStorage blocked / full — fail silently, session-only from here */
  }
};

export const useAppliedJobs = () => {
  const [applied, setApplied] = useState<Set<string>>(readApplied);

  const toggleApplied = useCallback((id: string) => {
    setApplied((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      writeApplied(next);
      return next;
    });
  }, []);

  const clearApplied = useCallback(() => {
    setApplied(new Set());
    writeApplied(new Set());
  }, []);

  /** Bulk-set the applied state for many ids at once.
   *  Used by the JobsTable's Applied-column header checkbox to bulk-toggle
   *  every visible row. Coalesces into a single state update + one
   *  localStorage write, vs N times via toggleApplied in a loop. */
  const setAppliedMany = useCallback((ids: string[], appliedState: boolean) => {
    setApplied((prev) => {
      const next = new Set(prev);
      if (appliedState) ids.forEach((id) => next.add(id));
      else ids.forEach((id) => next.delete(id));
      writeApplied(next);
      return next;
    });
  }, []);

  return { applied, toggleApplied, clearApplied, setAppliedMany };
};

/** Mutation hook for the corpus (delete jobs, set per-job rating).
 *  POSTs to /api/corpus/* and on success fires the existing
 *  `linkedinjobs:corpus-stale` event so CorpusPage / RunHistoryPage
 *  re-fetch their data without a manual reload. */
export interface CorpusActionsResult {
  ok: boolean;
  error?: string;
}

export const useCorpusActions = () => {
  const fireStale = useCallback(() => {
    window.dispatchEvent(new CustomEvent('linkedinjobs:corpus-stale'));
  }, []);

  const deleteJobs = useCallback(
    async (ids: string[]): Promise<CorpusActionsResult> => {
      if (ids.length === 0) return { ok: true };
      try {
        const res = await fetch('/api/corpus/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids }),
        });
        const body = (await res.json()) as { ok?: boolean; error?: string };
        if (!body.ok) return { ok: false, error: body.error || `HTTP ${res.status}` };
        fireStale();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    [fireStale],
  );

  const rateJob = useCallback(
    async (id: string, rating: number | null): Promise<CorpusActionsResult> => {
      try {
        const res = await fetch('/api/corpus/rate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, rating }),
        });
        const body = (await res.json()) as { ok?: boolean; error?: string };
        if (!body.ok) return { ok: false, error: body.error || `HTTP ${res.status}` };
        fireStale();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    [fireStale],
  );

  return { deleteJobs, rateJob };
};

/** Writes the current URLSearchParams to the address bar without navigation. */
export const useUrlSync = (params: URLSearchParams): void => {
  const prev = useRef('');
  useEffect(() => {
    const qs = params.toString();
    if (qs !== prev.current) {
      prev.current = qs;
      const next = qs
        ? `${window.location.pathname}?${qs}`
        : window.location.pathname;
      window.history.replaceState(null, '', next);
    }
  }, [params]);
};
