// Tests for src/configMigrate.ts — the legacy-config -> new-schema
// migration helper. Critical because every load_config() round-trips
// through it; a regression silently corrupts user config on save.
//
// The high-value property is the round-trip:
//   raw -> normalizeConfig -> serializeConfig -> normalizeConfig === normalized
// (idempotent after the first normalization). Anything that breaks that
// would corrupt the user's edits after a save+reload cycle.

import { describe, it, expect } from 'vitest';
import { normalizeConfig, serializeConfig, validateGeoId } from './configMigrate';

describe('normalizeConfig — basic shapes', () => {
  it('returns sane defaults for an empty input', () => {
    const cfg = normalizeConfig({});
    expect(cfg.location).toBe('');
    expect(cfg.date_filter).toBe('');
    expect(cfg.geo_id).toBe('');
    expect(cfg.max_pages).toBe(3);
    expect(cfg.priority_companies).toEqual([]);
    // Synthesized fallback when no legacy / new fields populated.
    expect(cfg.categories.length).toBeGreaterThan(0);
  });

  it('passes through a valid new-schema config', () => {
    const cfg = normalizeConfig({
      categories: [
        { id: 'c1', name: 'ML', type: 'keyword', queries: ['ml engineer'] },
      ],
      location: 'Remote',
      date_filter: 'r604800',
      geo_id: '101620260',
      max_pages: 5,
      priority_companies: ['acme', 'foo'],
    });
    expect(cfg.categories).toEqual([
      { id: 'c1', name: 'ML', type: 'keyword', queries: ['ml engineer'] },
    ]);
    expect(cfg.location).toBe('Remote');
    expect(cfg.geo_id).toBe('101620260');
    expect(cfg.max_pages).toBe(5);
  });

  it('clamps max_pages into [1, 20]', () => {
    expect(normalizeConfig({ max_pages: 999 }).max_pages).toBe(20);
    expect(normalizeConfig({ max_pages: -5 }).max_pages).toBe(1);
    expect(normalizeConfig({ max_pages: 7.6 }).max_pages).toBe(8); // rounded
    expect(normalizeConfig({ max_pages: 'huge' }).max_pages).toBe(3); // default
  });

  it('clamps feedback_examples_max into [0, 20]', () => {
    expect(normalizeConfig({ feedback_examples_max: 30 }).feedback_examples_max).toBe(20);
    expect(normalizeConfig({ feedback_examples_max: -2 }).feedback_examples_max).toBe(0);
    expect(normalizeConfig({ feedback_examples_max: 'NaN' }).feedback_examples_max).toBeUndefined();
  });
});

describe('normalizeConfig — legacy migration', () => {
  it('synthesizes categories from search_queries + company_queries', () => {
    const cfg = normalizeConfig({
      search_queries: ['python', 'rust'],
      company_queries: ['Acme'],
    });
    const types = cfg.categories.map((c) => c.type);
    expect(types).toContain('keyword');
    expect(types).toContain('company');
    const cosKw = cfg.categories.find((c) => c.type === 'keyword');
    expect(cosKw?.queries).toEqual(['python', 'rust']);
  });

  it('respects an explicitly-empty categories array (user wiped it)', () => {
    const cfg = normalizeConfig({
      categories: [],
      // No legacy fields populated — the helper should NOT re-synthesize.
    });
    expect(cfg.categories).toEqual([]);
  });

  it('drops malformed category entries', () => {
    const cfg = normalizeConfig({
      categories: [
        { id: 'c1', name: 'OK', type: 'keyword', queries: ['x'] },
        'junk',                                  // string entry — drop
        { name: 'Bad type', type: 'weird' },     // bad type → fallback to keyword
        { queries: 42 },                          // queries not array → []
      ],
    });
    expect(cfg.categories.length).toBeGreaterThanOrEqual(1);
    const ok = cfg.categories.find((c) => c.id === 'c1');
    expect(ok).toBeTruthy();
    // The 'weird' type entry is salvaged, NOT dropped.
    const salvaged = cfg.categories.find((c) => c.name === 'Bad type');
    expect(salvaged?.type).toBe('keyword');
  });
});

describe('normalizeConfig — priority_companies', () => {
  it('accepts an array of strings', () => {
    expect(normalizeConfig({ priority_companies: ['a', 'b'] }).priority_companies).toEqual([
      'a',
      'b',
    ]);
  });

  it('accepts a CSV string and splits it', () => {
    expect(normalizeConfig({ priority_companies: 'acme, foo, bar' }).priority_companies)
      .toEqual(['acme', 'foo', 'bar']);
  });

  it('drops empty / whitespace-only entries', () => {
    expect(normalizeConfig({ priority_companies: ['  ', 'a', ''] }).priority_companies)
      .toEqual(['a']);
  });
});

describe('normalizeConfig — llm_provider', () => {
  it('keeps a valid provider', () => {
    const cfg = normalizeConfig({ llm_provider: { name: 'gemini', model: 'gemini-2.5-flash' } });
    expect(cfg.llm_provider).toEqual({ name: 'gemini', model: 'gemini-2.5-flash' });
  });

  it('drops invalid provider names', () => {
    const cfg = normalizeConfig({ llm_provider: { name: 'fake-llm' } });
    expect(cfg.llm_provider).toBeUndefined();
  });

  it('drops non-object providers', () => {
    expect(normalizeConfig({ llm_provider: 'auto' }).llm_provider).toBeUndefined();
  });
});

describe('normalizeConfig — default_mode', () => {
  it.each([
    ['guest', 'guest'],
    ['loggedin', 'loggedin'],
    ['anything-else', undefined],
  ])('default_mode=%s -> %s', (input, expected) => {
    expect(normalizeConfig({ default_mode: input }).default_mode).toBe(expected);
  });
});

describe('validateGeoId', () => {
  it.each([
    ['', ''],            // empty -> empty
    ['101620260', '101620260'], // known
    ['12345', '12345'],  // unknown but digit-only — accept (warn)
    ['IL', ''],          // non-digit garbage — drop
    ['  92000000  ', '92000000'], // trim
  ])('validateGeoId(%j) -> %j', (input, expected) => {
    expect(validateGeoId(input)).toBe(expected);
  });

  it('rejects non-string inputs', () => {
    expect(validateGeoId(null)).toBe('');
    expect(validateGeoId(undefined)).toBe('');
    expect(validateGeoId(101_620_260)).toBe('');
  });
});

describe('serializeConfig — round-trip', () => {
  it('round-trips a representative config', () => {
    const raw = {
      categories: [
        { id: 'c1', name: 'ML', type: 'keyword', queries: ['ml'] },
        { id: 'c2', name: 'Companies', type: 'company', queries: ['Acme'] },
      ],
      location: 'Remote',
      date_filter: 'r604800',
      geo_id: '92000000',
      max_pages: 5,
      priority_companies: ['acme'],
      claude_scoring_prompt: 'Score this CV against jobs',
      fit_positive_patterns: ['rust'],
      fit_negative_patterns: ['php'],
      offtopic_title_patterns: ['intern'],
      feedback_examples_max: 10,
      llm_provider: { name: 'gemini', model: 'gemini-2.5-flash' },
      default_mode: 'guest',
    };
    const normalized1 = normalizeConfig(raw);
    const serialized = serializeConfig(normalized1);
    const normalized2 = normalizeConfig(serialized);
    expect(normalized2).toEqual(normalized1);
  });

  it('strips legacy fields from the serialized output', () => {
    const cfg = normalizeConfig({
      search_queries: ['x'],
      company_queries: ['Acme'],
    });
    const out = serializeConfig(cfg);
    expect(out.search_queries).toBeUndefined();
    expect(out.company_queries).toBeUndefined();
    expect(out.categories).toBeDefined();
  });

  it('omits optional fields that were undefined', () => {
    const cfg = normalizeConfig({});
    const out = serializeConfig(cfg);
    expect(out.claude_scoring_prompt).toBeUndefined();
    expect(out.fit_positive_patterns).toBeUndefined();
    expect(out.feedback_examples_max).toBeUndefined();
    expect(out.llm_provider).toBeUndefined();
    expect(out.default_mode).toBeUndefined();
  });
});
