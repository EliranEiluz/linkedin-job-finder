// Defensive client-side validator for the corpus_nl_ctl envelope. The
// ctl already validates the LLM output server-side, but we re-validate
// here so a future ctl change (or an older deploy with a wider schema)
// can't inject unexpected values into FilterState.
//
// As of the schema-centralize refactor this module is a thin adapter:
// the actual schema lives in ./filterStateSchema (Zod source of truth)
// and parseFilterEnvelope does the field-level salvage. This file
// just maps the parsed envelope onto the existing FilterState shape
// (Set<T> wrappers, defaults for omitted fields) so callers don't have
// to know about the wire-protocol primitives.
//
// Lives in its own module (not inline in CorpusNLBox.tsx) so eslint's
// react-refresh/only-export-components rule stays happy — components
// shouldn't co-export non-component values.

import {
  defaultFilters,
  type FilterState,
  type FitKey,
  type ScoredByKey,
  type SourceKey,
} from './filters';
import { parseFilterEnvelope } from './filterStateSchema';

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

// Returns a FULL FilterState — fields the ctl didn't emit keep their
// `defaultFilters()` values. The result is what the parent's setFilters
// receives on Apply, i.e. a wholesale replacement of the existing
// FilterState (matches the user's mental model of "type a query →
// that's the new filter").
//
// Anything the schema rejects (alien keys, wrong enum values, out-of-
// range scores) silently degrades to the default for that field. This
// matches CorpusNLBox.test's "drops invalid enum values" pin.
export const validateServerFilters = (
  raw: ServerFilters | undefined,
): FilterState => {
  const out = defaultFilters();
  const { envelope } = parseFilterEnvelope(raw);

  // categories — Set<string> in FilterState. Schema's `categories` is
  // a dynamic-vocabulary array; we re-Set here without further checks
  // (URL parsing does the same — user-defined ids must round-trip).
  if (envelope.categories && envelope.categories.length > 0) {
    out.categories = new Set(envelope.categories);
  }

  // fits / scoredBy / sources — array → typed Set. The schema already
  // enforced the enum so the cast is sound (zod-validated string ∈ enum).
  if (envelope.fits && envelope.fits.length > 0) {
    out.fits = new Set(envelope.fits as FitKey[]);
  }
  if (envelope.scoredBy && envelope.scoredBy.length > 0) {
    out.scoredBy = new Set(envelope.scoredBy as ScoredByKey[]);
  }
  if (envelope.sources && envelope.sources.length > 0) {
    out.sources = new Set(envelope.sources as SourceKey[]);
  }

  // Scalars — schema already enforced shape. Score swap done inside
  // parseFilterEnvelope so {min:9,max:3} → {min:3,max:9} here.
  if (envelope.priority !== undefined) out.priority = envelope.priority;
  if (envelope.applied !== undefined) out.applied = envelope.applied;
  if (envelope.scoreMin !== undefined) out.scoreMin = envelope.scoreMin;
  if (envelope.scoreMax !== undefined) out.scoreMax = envelope.scoreMax;
  if (envelope.dateQuick !== undefined) out.dateQuick = envelope.dateQuick;
  if (envelope.search !== undefined) {
    const s = envelope.search.trim();
    if (s) out.search = s;
  }

  return out;
};
