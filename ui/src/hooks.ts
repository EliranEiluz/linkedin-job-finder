import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppStatus } from './types';

export const useDebounced = <T>(value: T, delay = 150): T => {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setV(value), delay);
    return () => window.clearTimeout(id);
  }, [value, delay]);
  return v;
};

/** Per-job "applied" state used to live in localStorage via this hook.
 *  Removed 2026-04-27: source of truth is now the server (`job.app_status`)
 *  via `useAppStatus` so Corpus checkbox and Tracker kanban stay in sync
 *  across browsers/devices. CorpusPage derives an `applied: Set<string>`
 *  itself from the corpus data + optimistic in-flight overrides; see the
 *  comment block above its `applied` useMemo for the full pattern. */

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

  // `comment` is tri-state on the wire: undefined = don't touch the field,
  // null = clear it, string = set it (server truncates to 2000 chars).
  const rateJob = useCallback(
    async (
      id: string,
      rating: number | null,
      comment?: string | null,
    ): Promise<CorpusActionsResult> => {
      try {
        const payload: Record<string, unknown> = { id, rating };
        if (comment !== undefined) payload.comment = comment;
        const res = await fetch('/api/corpus/rate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
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

/** Application-tracker mutation hook. Wraps `/api/corpus/app-status` and
 *  `/api/corpus/applied-bulk-import`. Both fire the corpus-stale event on
 *  success so any open page re-fetches without a manual reload.
 *
 *  This is a Stage 3-A primitive — `useAppliedJobs` (localStorage-based) is
 *  intentionally left alone for backwards compat until Stage 3-B's UI lands
 *  and the migration runs. */
export interface AppStatusActionsResult {
  ok: boolean;
  error?: string;
}

export interface BulkImportResult extends AppStatusActionsResult {
  imported?: number;
}

export const useAppStatus = () => {
  const fireStale = useCallback(() => {
    window.dispatchEvent(new CustomEvent('linkedinjobs:corpus-stale'));
  }, []);

  // `note` is tri-state on the wire — undefined (key absent) means
  // "don't touch app_notes"; null clears it; string sets it. Forwarding
  // the key only when defined preserves that sentinel through the stack.
  const setAppStatus = useCallback(
    async (
      id: string,
      status: AppStatus,
      note?: string | null,
    ): Promise<AppStatusActionsResult> => {
      try {
        const payload: Record<string, unknown> = { id, status };
        if (note !== undefined) payload.note = note;
        const res = await fetch('/api/corpus/app-status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
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

  const bulkImportApplied = useCallback(
    async (ids: string[]): Promise<BulkImportResult> => {
      try {
        const res = await fetch('/api/corpus/applied-bulk-import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ applied_ids: ids }),
        });
        const body = (await res.json()) as {
          ok?: boolean; error?: string; imported?: number;
        };
        if (!body.ok) return { ok: false, error: body.error || `HTTP ${res.status}` };
        fireStale();
        return { ok: true, imported: body.imported ?? 0 };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    [fireStale],
  );

  return { setAppStatus, bulkImportApplied };
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
