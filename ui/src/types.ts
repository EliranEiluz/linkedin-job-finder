export type Fit = 'good' | 'ok' | 'skip';
// Categories are user-defined via the Crawler Config page. The string is the
// category id set by the scraper (e.g. "crypto", "companies", or any custom
// id the user created). Legacy jobs still carry "crypto"/"security_researcher"/
// "company" — those render alongside the new ids without special-casing.
export type Category = string;
export type ScoredBy = 'claude' | 'regex' | 'title-filter';
// 'manual' tags rows ingested via the Corpus tab's "+ Add Job" button
// (POST /api/corpus/add-manual). They walk the same per-job pipeline a
// scraped row gets — only this provenance marker (and `manual_added_at`)
// distinguish them. The few-shot loop already counts manual rows as
// positive feedback (search.py:_classify_feedback_row).
export type Source = 'loggedin' | 'guest' | 'manual';

// Application-tracker pipeline. 8 stages in display order — `new` is the
// unset/default seeded by the localStorage→server migration; `take-home`
// is its own column because security-engineer searches generate plenty of
// take-homes that take 1–2 weeks to clear. Keep in lockstep with
// APP_STATUS_VALUES in backend/ctl/corpus_ctl.py and the validator in
// ui/vite.config.ts.
export type AppStatus =
  | 'new'
  | 'applied'
  | 'screening'
  | 'interview'
  | 'take-home'
  | 'offer'
  | 'rejected'
  | 'withdrew';

export const APP_STATUS_ORDER: readonly AppStatus[] = [
  'new',
  'applied',
  'screening',
  'interview',
  'take-home',
  'offer',
  'rejected',
  'withdrew',
] as const;

export interface AppStatusHistoryEntry {
  status: AppStatus;
  at: string;
}

export interface Job {
  id: string;
  title: string;
  company: string;
  location: string;
  url: string;
  query: string;
  category: Category;
  // Human-readable name resolved at scrape time. Stored ON the row (not
  // looked up from the live config) so it survives config rewrites — when
  // the wizard / AI-generated config / profile switch replaces category
  // ids wholesale, old rows still render with their original name. Empty
  // / undefined on legacy rows; UI falls back to the categoryNamesById
  // lookup, then to a deburred id.
  category_name?: string | null;
  found_at: string;
  priority: boolean;
  msc_required: boolean | null;
  fit: Fit | null;
  score: number | null;
  // Backend-derived "noteworthy match" flag, written by
  // search.py:_compute_hot after Claude scoring. Frontend reads this
  // directly — no recomputation — so the UI, the digest email, and
  // the few-shot loop never disagree about which jobs are hot.
  // Optional for backwards-compat with rows persisted before the field
  // existed (the one-shot backfill caught all 209 today).
  hot?: boolean | null;
  fit_reasons: string[];
  scored_by: ScoredBy | null;
  scraped_at?: string;
  source?: Source | null;
  // 1–5 user rating, set via the row-actions popover. Persisted in
  // results.json by `corpus_ctl.py rate`. Null/undefined = unrated.
  rating?: number | null;
  // Free-text note attached to the rating ("interesting but small team").
  // Independent of `rating` — you can have a comment with no rating, or
  // change the rating without touching the comment. Capped at 2000 chars
  // server-side.
  comment?: string | null;
  // ISO-8601 timestamp (UTC) updated whenever rating or comment mutates.
  // Powers the future tracker's stale-row sort + the few-shot loop's
  // recency-weighted example selection.
  rated_at?: string | null;
  // Application-tracker fields, written by `corpus_ctl.py app-status`.
  // `app_status` undefined or "new" both mean "not yet in the pipeline".
  // History is appended on every transition (no-op writes don't double-log)
  // so the tracker can render "moved 4 days ago" pills without recomputing.
  // `app_notes` is a long-form free-text field separate from the rating
  // `comment` (different surface, different purpose); cap 4000 chars.
  app_status?: AppStatus | null;
  app_status_at?: string | null;
  app_status_history?: AppStatusHistoryEntry[];
  app_notes?: string | null;
  // "Sort this row to the bottom even though it isn't applied yet."
  // Persisted server-side via `corpus_ctl.py push-to-end` so the demote
  // survives reloads and syncs across devices. Independent of app_status —
  // applied rows already sink by default; this flag is mainly for "not
  // applied but I don't want to see this near the top right now."
  pushed_to_end?: boolean | null;
  // ISO-8601 timestamp set when the row was ingested via "+ Add Job".
  // Only present on rows with `source === 'manual'`. Useful for an
  // "added by me yesterday" sort + as a debug marker.
  manual_added_at?: string | null;
}
