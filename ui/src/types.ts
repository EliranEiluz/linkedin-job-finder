export type Fit = 'good' | 'ok' | 'skip';
// Categories are user-defined via the Crawler Config page. The string is the
// category id set by the scraper (e.g. "crypto", "companies", or any custom
// id the user created). Legacy jobs still carry "crypto"/"security_researcher"/
// "company" — those render alongside the new ids without special-casing.
export type Category = string;
export type ScoredBy = 'claude' | 'regex' | 'title-filter';
export type Source = 'loggedin' | 'guest';

export interface Job {
  id: string;
  title: string;
  company: string;
  location: string;
  url: string;
  query: string;
  category: Category;
  found_at: string;
  priority: boolean;
  msc_required: boolean | null;
  fit: Fit | null;
  score: number | null;
  fit_reasons: string[];
  scored_by: ScoredBy | null;
  scraped_at?: string;
  source?: Source | null;
  // 1–5 user rating, set via the row-actions popover. Persisted in
  // results.json by `corpus_ctl.py rate`. Null/undefined = unrated.
  rating?: number | null;
}
