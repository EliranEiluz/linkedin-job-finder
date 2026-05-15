// Single source of truth for the natural-language filter envelope shape.
//
// This is the on-the-wire contract between corpus_nl_ctl.py and
// CorpusNLBox. Adding/removing/renaming a filter field requires editing
// only this file:
//   - the TypeScript type the React tree consumes (via z.infer)
//   - the runtime validator on the client (filterStateSchema.parse)
//   - the JSON Schema served to the backend (z.toJSONSchema)
//   - the backend ctl reads the same JSON Schema from disk to build
//     the LLM prompt OR the structured-output API call
//
// Static-vs-dynamic vocabulary split
// ----------------------------------
// `fits`, `priority`, `applied`, `dateQuick` are static enums hardcoded
// in this schema — the UI's FilterPanel offers a fixed set of checkboxes
// for each. `categories`, `scoredBy`, `sources` are dynamic — their
// vocabulary depends on the user's config and on the corpus contents
// (see backend/ctl/corpus_nl_ctl.py:_load_categories). The schema models
// those as plain `string[]` so any value passes the structural check;
// vocabulary validity is enforced server-side at prompt-build time
// (the ctl injects the live list into the LLM context) and again at
// LLM-output validation time (unknown ids are silently dropped).
//
// Why partial / fields optional
// -----------------------------
// The LLM may legitimately set only one or two fields when the user
// types "last week". Omitted fields fall back to defaultFilters() on
// the client. This matches the user's mental model: "type a query →
// that's the new filter", not "merge with my current ticks".

import { z } from 'zod';

// ─── Static enums (mirrored to the UI's FilterPanel checkboxes) ─────────
//
// Keep these tuples in lockstep with ALL_FITS, ALL_SCORED_BY, etc. in
// ui/src/filters.ts and the legacy VALID_* frozensets in
// backend/ctl/corpus_nl_ctl.py — those are derived from this file via
// the schema dump (see scripts/dumpFilterSchema.ts).

export const FIT_KEYS = ['good', 'ok', 'skip', 'unscored'] as const;
export const SCORED_BY_KEYS = ['claude', 'regex', 'title-filter', 'none'] as const;
export const SOURCE_KEYS = ['loggedin', 'guest', 'manual', 'unknown'] as const;
export const TRI_VALUES = ['all', 'yes', 'no'] as const;
export const DATE_QUICK_VALUES = ['all', '24h', '7d', '30d', 'custom'] as const;

// ─── Schema ─────────────────────────────────────────────────────────────
//
// `.describe()` on each field surfaces in the generated JSON Schema so
// the backend prompt builder can render human-readable hints without
// duplicating the prose anywhere else. Treat the descriptions as part
// of the LLM contract — they're what the model reads when the ctl
// embeds the schema into a non-structured-output prompt.

export const FilterStateSchema = z
  .object({
    categories: z
      .array(z.string().min(1))
      .optional()
      .describe(
        'Category ids from the user-defined catalog (filled in at prompt time). Match by name OR id (case-insensitive). Empty / omitted means "no category filter".',
      ),
    fits: z
      .array(z.enum(FIT_KEYS))
      .optional()
      .describe('Subset of allowed fit buckets. Omitted means "no fit filter".'),
    scoredBy: z
      .array(z.enum(SCORED_BY_KEYS))
      .optional()
      .describe(
        'Subset of allowed scorer ids. "claude" = LLM-scored (any provider). "none" = unscored.',
      ),
    sources: z
      .array(z.enum(SOURCE_KEYS))
      .optional()
      .describe(
        'Subset of allowed corpus sources. "manual" = user-added via "+ Add Job".',
      ),
    priority: z
      .enum(TRI_VALUES)
      .optional()
      .describe('Tri-state on priority-company flag. "yes" narrows to priority only.'),
    applied: z
      .enum(TRI_VALUES)
      .optional()
      .describe('Tri-state on the application-tracker flag. "no" = not-yet-applied.'),
    scoreMin: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe('Integer 1-10. Combined with scoreMax to form a closed range.'),
    scoreMax: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe('Integer 1-10. Combined with scoreMin to form a closed range.'),
    dateQuick: z
      .enum(DATE_QUICK_VALUES)
      .optional()
      .describe(
        '"24h" / "7d" / "30d" map to the same buckets the UI quick-filter offers. "custom" is reserved for the date-picker — the LLM should not emit it.',
      ),
    search: z
      .string()
      .max(2000)
      .optional()
      .describe(
        'Free-text keyword matched against job title / company / fit-reasons. Extract specific tech/product nouns only — do not dump the whole query here.',
      ),
  })
  // strip means: silently drop unknown keys at parse time (no error, no
  // crash). The backend ctl validator does the same — alien fields from
  // an older deploy / future schema get logged and ignored, never land
  // in FilterState.
  .strip();

export type FilterEnvelope = z.infer<typeof FilterStateSchema>;

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Parse a raw server envelope's `filters` slice. Unknown keys are
 * dropped; unknown enum values cause the surrounding field to be
 * omitted (caller falls back to defaultFilters() for that slot).
 *
 * The strategy is "field-level salvage" not "all-or-nothing":
 * - Per-field schemas are validated independently via .safeParse on a
 *   single-field shape, so one bad field doesn't poison the others.
 * - For array enum fields (fits/scoredBy/sources), we drop individual
 *   bad members rather than the whole array — matches the ctl's
 *   `[f for f in raw_fits if f in VALID_FITS]` behavior.
 *
 * Returns `(envelope, droppedFields)` where droppedFields is the list
 * of keys that failed validation — useful for the "did the LLM emit
 * something unexpected?" telemetry path.
 */
export const parseFilterEnvelope = (
  raw: unknown,
): { envelope: FilterEnvelope; dropped: string[] } => {
  if (!raw || typeof raw !== 'object') {
    return { envelope: {}, dropped: [] };
  }
  const rawObj = raw as Record<string, unknown>;
  const envelope: FilterEnvelope = {};
  const dropped: string[] = [];

  // Field-by-field salvage — keep the good, log the bad. We can't just
  // do FilterStateSchema.safeParse(raw) because Zod would drop the
  // whole envelope on a single bad enum value (e.g. fits: ["great"]
  // would invalidate `fits`, but the test contract says "great"
  // disappears and "good" survives).
  for (const key of Object.keys(FilterStateSchema.shape) as (keyof FilterEnvelope)[]) {
    const value = rawObj[key];
    if (value === undefined) continue;

    // Array enum fields: salvage member-by-member.
    if (key === 'fits' || key === 'scoredBy' || key === 'sources') {
      if (!Array.isArray(value)) {
        dropped.push(key);
        continue;
      }
      const enumValues =
        key === 'fits' ? FIT_KEYS : key === 'scoredBy' ? SCORED_BY_KEYS : SOURCE_KEYS;
      const enumSet: ReadonlySet<string> = new Set(enumValues);
      const kept: string[] = [];
      for (const item of value) {
        if (typeof item === 'string' && enumSet.has(item)) kept.push(item);
      }
      if (kept.length > 0) {
        // Assignment safe — we just filtered to a subset of the enum.
        (envelope as Record<string, unknown>)[key] = kept;
      }
      continue;
    }

    // categories — array of any non-empty string (dynamic vocabulary,
    // see the file header for the static-vs-dynamic split). Trim and
    // drop empties.
    if (key === 'categories') {
      if (!Array.isArray(value)) {
        dropped.push(key);
        continue;
      }
      const kept: string[] = [];
      for (const item of value) {
        if (typeof item === 'string') {
          const t = item.trim();
          if (t) kept.push(t);
        }
      }
      if (kept.length > 0) envelope.categories = kept;
      continue;
    }

    // Scalar fields — delegate to a per-field Zod parse.
    const fieldSchema = FilterStateSchema.shape[key];
    const r = fieldSchema.safeParse(value);
    if (r.success && r.data !== undefined) {
      (envelope as Record<string, unknown>)[key] = r.data;
    } else {
      dropped.push(key);
    }
  }

  // Score range — swap if min > max so the UI sliders stay coherent.
  if (
    typeof envelope.scoreMin === 'number' &&
    typeof envelope.scoreMax === 'number' &&
    envelope.scoreMin > envelope.scoreMax
  ) {
    const tmp = envelope.scoreMin;
    envelope.scoreMin = envelope.scoreMax;
    envelope.scoreMax = tmp;
  }

  return { envelope, dropped };
};
