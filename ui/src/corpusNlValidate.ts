// Defensive client-side validator for the corpus_nl_ctl envelope. The
// ctl already validates the LLM output server-side, but we re-validate
// here so a future ctl change (or an older deploy with a wider schema)
// can't inject unexpected values into FilterState. This is the type
// boundary between "string the server gave us" and "FilterState the
// React tree believes" — if FilterState grows a new field, this is
// where the trust gate goes.
//
// Lives in its own module (not inline in CorpusNLBox.tsx) so eslint's
// react-refresh/only-export-components rule stays happy — components
// shouldn't co-export non-component values.

import {
  ALL_FITS,
  ALL_SCORED_BY,
  ALL_SOURCES,
  defaultFilters,
  type DateQuick,
  type FilterState,
  type FitKey,
  type ScoredByKey,
  type SourceKey,
  type Tri,
} from './filters';

// Mirrors corpus_nl_ctl.py's stdout `filters` object. All fields are
// optional — the ctl omits any field that failed validation rather than
// emitting a default value. `unknown` so callers MUST run through this
// validator before reading the field.
export interface ServerFilters {
  categories?: unknown;
  fits?: unknown;
  scoredBy?: unknown;
  sources?: unknown;
  priority?: unknown;
  applied?: unknown;
  scoreMin?: unknown;
  scoreMax?: unknown;
  dateQuick?: unknown;
  search?: unknown;
}

export interface ServerEnvelope {
  ok: boolean;
  filters?: ServerFilters;
  parse_summary?: string;
  error?: string;
  raw?: string;
}

const VALID_DATE_QUICK: ReadonlySet<DateQuick> = new Set<DateQuick>([
  'all',
  '24h',
  '7d',
  '30d',
  'custom',
]);
const VALID_TRI: ReadonlySet<Tri> = new Set<Tri>(['all', 'yes', 'no']);

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

// Returns a FULL FilterState — fields the ctl didn't emit keep their
// `defaultFilters()` values. The result is what the parent's setFilters
// receives on Apply, i.e. a wholesale replacement of the existing
// FilterState (matches the user's mental model of "type a query →
// that's the new filter").
export const validateServerFilters = (
  raw: ServerFilters | undefined,
): FilterState => {
  const out = defaultFilters();
  if (!raw || typeof raw !== 'object') return out;

  // categories — list of user-defined ids. We don't have the live config
  // here (the ctl already validated against it), so accept any non-empty
  // string. URL parsing does the same.
  if (isStringArray(raw.categories)) {
    const cats = new Set<string>();
    for (const c of raw.categories) {
      const t = c.trim();
      if (t) cats.add(t);
    }
    if (cats.size > 0) out.categories = cats;
  }

  if (isStringArray(raw.fits)) {
    const fits = new Set<FitKey>();
    for (const f of raw.fits) {
      if ((ALL_FITS as readonly string[]).includes(f)) fits.add(f as FitKey);
    }
    if (fits.size > 0) out.fits = fits;
  }

  if (isStringArray(raw.scoredBy)) {
    const sb = new Set<ScoredByKey>();
    for (const s of raw.scoredBy) {
      if ((ALL_SCORED_BY as readonly string[]).includes(s))
        sb.add(s as ScoredByKey);
    }
    if (sb.size > 0) out.scoredBy = sb;
  }

  if (isStringArray(raw.sources)) {
    const sr = new Set<SourceKey>();
    for (const s of raw.sources) {
      if ((ALL_SOURCES as readonly string[]).includes(s))
        sr.add(s as SourceKey);
    }
    if (sr.size > 0) out.sources = sr;
  }

  if (typeof raw.priority === 'string' && VALID_TRI.has(raw.priority as Tri)) {
    out.priority = raw.priority as Tri;
  }

  if (typeof raw.applied === 'string' && VALID_TRI.has(raw.applied as Tri)) {
    out.applied = raw.applied as Tri;
  }

  // scoreMin / scoreMax — integers in [1..10]; preserve defaults otherwise.
  // The ctl already swaps min>max, but we re-clamp here so a misbehaving
  // ctl can't violate the invariant.
  const coerceScore = (v: unknown): number | null => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    const n = Math.trunc(v);
    if (n < 1 || n > 10) return null;
    return n;
  };
  const smin = coerceScore(raw.scoreMin);
  const smax = coerceScore(raw.scoreMax);
  if (smin !== null && smax !== null && smin > smax) {
    out.scoreMin = smax;
    out.scoreMax = smin;
  } else {
    if (smin !== null) out.scoreMin = smin;
    if (smax !== null) out.scoreMax = smax;
  }

  if (
    typeof raw.dateQuick === 'string' &&
    VALID_DATE_QUICK.has(raw.dateQuick as DateQuick)
  ) {
    out.dateQuick = raw.dateQuick as DateQuick;
  }

  if (typeof raw.search === 'string') {
    const s = raw.search.trim();
    if (s) out.search = s;
  }

  return out;
};
