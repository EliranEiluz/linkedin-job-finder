import type { Job, Fit, Category, ScoredBy, Source } from './types';

export type Tri = 'all' | 'yes' | 'no';
export type FitKey = Fit | 'unscored';
export type ScoredByKey = ScoredBy | 'none';
export type SourceKey = Source | 'unknown';
export type DateQuick = 'all' | '24h' | '7d' | '30d' | 'custom';

export interface FilterState {
  fits: Set<FitKey>;
  priority: Tri;
  categories: Set<Category>;
  scoredBy: Set<ScoredByKey>;
  sources: Set<SourceKey>;
  scoreMin: number;
  scoreMax: number;
  dateQuick: DateQuick;
  dateFrom: string; // ISO date (YYYY-MM-DD), only used if dateQuick === 'custom'
  dateTo: string;
  applied: Tri; // 'all' = both, 'yes' = only applied, 'no' = only not-applied
  search: string;
}

export const ALL_FITS: FitKey[] = ['good', 'ok', 'skip', 'unscored'];
// Legacy default set — still used as the initial `categories` selection so
// first-render filtering doesn't accidentally hide anything before the
// corpus loads. Runtime code should prefer `allCategoriesFromJobs(jobs)`
// which unions whatever category ids the loaded corpus actually contains
// (so user-defined categories from config.json auto-surface in filters
// and stats).
export const ALL_CATEGORIES: Category[] = [
  'crypto',
  'security_researcher',
  'company',
];

export const allCategoriesFromJobs = (jobs: Job[]): Category[] => {
  const seen = new Set<string>();
  const out: Category[] = [];
  for (const j of jobs) {
    const c = j.category;
    if (c && !seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  }
  return out;
};

export const ALL_SCORED_BY: ScoredByKey[] = [
  'claude',
  'regex',
  'title-filter',
  'none',
];
export const ALL_SOURCES: SourceKey[] = ['loggedin', 'guest', 'manual', 'unknown'];

// Default fit set HIDES `skip` — most users never want to look at skip jobs,
// and unhiding is one click in the Fit panel. `isDefault()` and
// `toSearchParams()` both compare against this same set, so the URL stays
// clean (no ?fits=...) when the default is in effect.
export const DEFAULT_FITS: FitKey[] = ['good', 'ok', 'unscored'];

export const defaultFilters = (): FilterState => ({
  // All enum filters use "empty Set = match all" uniformly. FilterPanel
  // renders all checkboxes as ticked when the set is empty; clicking one
  // expands to an explicit "all minus that one" Set; ticking everything
  // back collapses to empty. Benefits:
  //   - new user-defined categories auto-show without manual re-ticking
  //   - URL stays clean when no filter is active (no ?fits=…&cat=… etc.)
  //   - consistent semantics across fits / categories / scoredBy / sources
  // Note: this overrides the earlier "default-hide skip" choice — the
  // user explicitly asked for uniform auto-marked filters.
  fits: new Set(),
  priority: 'all',
  categories: new Set(),
  scoredBy: new Set(),
  sources: new Set(),
  scoreMin: 1,
  scoreMax: 10,
  dateQuick: 'all',
  dateFrom: '',
  dateTo: '',
  applied: 'all',
  search: '',
});

export const isDefault = (f: FilterState): boolean => {
  const d = defaultFilters();
  return (
    eqSet(f.fits, d.fits) &&
    f.priority === d.priority &&
    eqSet(f.categories, d.categories) &&
    eqSet(f.scoredBy, d.scoredBy) &&
    eqSet(f.sources, d.sources) &&
    f.scoreMin === d.scoreMin &&
    f.scoreMax === d.scoreMax &&
    f.dateQuick === d.dateQuick &&
    f.dateFrom === d.dateFrom &&
    f.dateTo === d.dateTo &&
    f.applied === d.applied &&
    f.search === d.search
  );
};

const eqSet = <T>(a: Set<T>, b: Set<T>): boolean => {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
};

/* --------------- URL <-> FilterState --------------- */

export const toSearchParams = (f: FilterState): URLSearchParams => {
  const p = new URLSearchParams();
  const d = defaultFilters();
  if (!eqSet(f.fits, d.fits))
    p.set('fits', [...f.fits].sort().join(','));
  if (f.priority !== d.priority) p.set('priority', f.priority);
  if (!eqSet(f.categories, d.categories))
    p.set('cat', [...f.categories].sort().join(','));
  if (!eqSet(f.scoredBy, d.scoredBy))
    p.set('by', [...f.scoredBy].sort().join(','));
  if (!eqSet(f.sources, d.sources))
    p.set('src', [...f.sources].sort().join(','));
  if (f.scoreMin !== d.scoreMin) p.set('smin', String(f.scoreMin));
  if (f.scoreMax !== d.scoreMax) p.set('smax', String(f.scoreMax));
  if (f.dateQuick !== d.dateQuick) p.set('d', f.dateQuick);
  if (f.dateFrom) p.set('df', f.dateFrom);
  if (f.dateTo) p.set('dt', f.dateTo);
  if (f.applied !== d.applied) p.set('applied', f.applied);
  if (f.search) p.set('q', f.search);
  return p;
};

export const fromSearchParams = (p: URLSearchParams): FilterState => {
  const f = defaultFilters();
  const parseCsv = <T extends string>(key: string, allowed: readonly T[]): Set<T> | null => {
    const raw = p.get(key);
    if (raw === null) return null;
    if (raw === '') return new Set();
    const set = new Set<T>();
    for (const piece of raw.split(',')) {
      if ((allowed as readonly string[]).includes(piece)) set.add(piece as T);
    }
    return set;
  };

  // Like parseCsv but accepts ANY non-empty string. Used for the category
  // dimension where ids are user-defined (`cat-mobyb81c-4` etc.) and a
  // fixed allowlist would silently drop them on every URL refresh.
  const parseStringSet = (key: string): Set<string> | null => {
    const raw = p.get(key);
    if (raw === null) return null;
    if (raw === '') return new Set();
    const set = new Set<string>();
    for (const piece of raw.split(',')) {
      const trimmed = piece.trim();
      if (trimmed) set.add(trimmed);
    }
    return set;
  };

  const fits = parseCsv<FitKey>('fits', ALL_FITS);
  if (fits) f.fits = fits;
  const cats = parseStringSet('cat');
  if (cats) f.categories = cats;
  const by = parseCsv<ScoredByKey>('by', ALL_SCORED_BY);
  if (by) f.scoredBy = by;
  const src = parseCsv<SourceKey>('src', ALL_SOURCES);
  if (src) f.sources = src;

  const priority = p.get('priority');
  if (priority === 'all' || priority === 'yes' || priority === 'no')
    f.priority = priority;

  const applied = p.get('applied');
  if (applied === 'all' || applied === 'yes' || applied === 'no')
    f.applied = applied;

  const smin = p.get('smin');
  if (smin !== null) {
    const n = parseInt(smin, 10);
    if (Number.isFinite(n) && n >= 1 && n <= 10) f.scoreMin = n;
  }
  const smax = p.get('smax');
  if (smax !== null) {
    const n = parseInt(smax, 10);
    if (Number.isFinite(n) && n >= 1 && n <= 10) f.scoreMax = n;
  }
  if (f.scoreMin > f.scoreMax) {
    const t = f.scoreMin;
    f.scoreMin = f.scoreMax;
    f.scoreMax = t;
  }

  const d = p.get('d');
  if (d === 'all' || d === '24h' || d === '7d' || d === '30d' || d === 'custom')
    f.dateQuick = d;

  f.dateFrom = p.get('df') ?? '';
  f.dateTo = p.get('dt') ?? '';
  f.search = p.get('q') ?? '';
  return f;
};

/* --------------- Filtering --------------- */

const quickCutoff = (q: DateQuick): number | null => {
  if (q === '24h') return Date.now() - 24 * 3600 * 1000;
  if (q === '7d') return Date.now() - 7 * 24 * 3600 * 1000;
  if (q === '30d') return Date.now() - 30 * 24 * 3600 * 1000;
  return null;
};

export const applyFilters = (
  jobs: Job[],
  f: FilterState,
  applied: Set<string> = new Set(),
): Job[] => {
  const q = f.search.trim().toLowerCase();
  const cutoff = f.dateQuick === 'custom' ? null : quickCutoff(f.dateQuick);
  const fromTs =
    f.dateQuick === 'custom' && f.dateFrom
      ? new Date(f.dateFrom + 'T00:00:00').getTime()
      : null;
  const toTs =
    f.dateQuick === 'custom' && f.dateTo
      ? new Date(f.dateTo + 'T23:59:59').getTime()
      : null;

  return jobs.filter((j) => {
    // Fit — empty set means "no fit filter" (match all).
    const fitKey: FitKey = j.fit ?? 'unscored';
    if (f.fits.size > 0 && !f.fits.has(fitKey)) return false;

    // Priority
    if (f.priority === 'yes' && !j.priority) return false;
    if (f.priority === 'no' && j.priority) return false;

    // Category — empty set means "no category filter" (match all). The UI
    // shows all checkboxes as ticked in this state; clicking one expands
    // to an explicit "all minus that one" set.
    if (f.categories.size > 0 && !f.categories.has(j.category)) return false;

    // Scored by — empty set = match all.
    const byKey: ScoredByKey = j.scored_by ?? 'none';
    if (f.scoredBy.size > 0 && !f.scoredBy.has(byKey)) return false;

    // Source — empty set = match all (legacy jobs without the field count
    // as "unknown" for filtering purposes).
    const srcKey: SourceKey = j.source ?? 'unknown';
    if (f.sources.size > 0 && !f.sources.has(srcKey)) return false;

    // Score range — unscored jobs pass iff the full range is selected
    if (j.score !== null) {
      if (j.score < f.scoreMin || j.score > f.scoreMax) return false;
    } else if (f.scoreMin !== 1 || f.scoreMax !== 10) {
      return false;
    }

    // Applied
    if (f.applied === 'yes' && !applied.has(j.id)) return false;
    if (f.applied === 'no' && applied.has(j.id)) return false;

    // Date
    const ts = Date.parse(j.found_at);
    if (!Number.isNaN(ts)) {
      if (cutoff !== null && ts < cutoff) return false;
      if (fromTs !== null && ts < fromTs) return false;
      if (toTs !== null && ts > toTs) return false;
    }

    // Text search
    if (q) {
      const hay = (
        j.title +
        ' ' +
        j.company +
        ' ' +
        j.fit_reasons.join(' ')
      ).toLowerCase();
      if (!hay.includes(q)) return false;
    }

    return true;
  });
};
