// Tests for src/filters.ts — defaultFilters / isDefault / fromSearchParams /
// toSearchParams + applyFilters. Pure functions, no DOM.

import { describe, it, expect } from 'vitest';
import {
  defaultFilters,
  isDefault,
  toSearchParams,
  fromSearchParams,
  applyFilters,
  ALL_FITS,
  ALL_SCORED_BY,
  ALL_SOURCES,
} from './filters';
import type { Job } from './types';

const jobOf = (overrides: Partial<Job> = {}): Job => ({
  id: '1',
  title: 'Engineer',
  company: 'Acme',
  location: 'Remote',
  url: 'https://x',
  query: 'engineer',
  category: 'crypto',
  found_at: '2026-04-15T10:00:00',
  priority: false,
  msc_required: false,
  fit: 'good',
  score: 8,
  fit_reasons: [],
  scored_by: 'claude',
  ...overrides,
});

describe('defaultFilters / isDefault', () => {
  it('round-trips: defaultFilters() is isDefault()', () => {
    expect(isDefault(defaultFilters())).toBe(true);
  });

  it('any tweak makes it non-default', () => {
    const f = defaultFilters();
    f.search = 'x';
    expect(isDefault(f)).toBe(false);
    const f2 = defaultFilters();
    f2.scoreMin = 5;
    expect(isDefault(f2)).toBe(false);
    const f3 = defaultFilters();
    f3.fits = new Set(['good']);
    expect(isDefault(f3)).toBe(false);
  });
});

describe('toSearchParams / fromSearchParams round-trip', () => {
  it('default state -> empty querystring -> default state', () => {
    const f = defaultFilters();
    const qs = toSearchParams(f);
    expect(qs.toString()).toBe('');
    expect(isDefault(fromSearchParams(qs))).toBe(true);
  });

  it('preserves a fit filter through the round-trip', () => {
    const f = defaultFilters();
    f.fits = new Set(['good', 'ok']);
    const qs = toSearchParams(f);
    expect(qs.get('fits')).toBe('good,ok');
    const back = fromSearchParams(qs);
    expect([...back.fits].sort()).toEqual(['good', 'ok']);
  });

  it('preserves the search query', () => {
    const f = defaultFilters();
    f.search = 'rust';
    expect(toSearchParams(f).get('q')).toBe('rust');
    expect(fromSearchParams(toSearchParams(f)).search).toBe('rust');
  });

  it('preserves score range', () => {
    const f = defaultFilters();
    f.scoreMin = 7;
    f.scoreMax = 9;
    const qs = toSearchParams(f);
    expect(qs.get('smin')).toBe('7');
    expect(qs.get('smax')).toBe('9');
    const back = fromSearchParams(qs);
    expect(back.scoreMin).toBe(7);
    expect(back.scoreMax).toBe(9);
  });

  it('preserves applied tri-state', () => {
    for (const v of ['yes', 'no'] as const) {
      const f = defaultFilters();
      f.applied = v;
      expect(fromSearchParams(toSearchParams(f)).applied).toBe(v);
    }
  });

  it('preserves dateQuick', () => {
    const f = defaultFilters();
    f.dateQuick = '7d';
    expect(fromSearchParams(toSearchParams(f)).dateQuick).toBe('7d');
  });

  it('swaps inverted score range to ascending', () => {
    const qs = new URLSearchParams('smin=9&smax=3');
    const f = fromSearchParams(qs);
    expect(f.scoreMin).toBe(3);
    expect(f.scoreMax).toBe(9);
  });

  it('preserves user-defined category ids (non-allowlisted)', () => {
    // Category ids are user-defined like `cat-mobyb81c-4` — fromSearchParams
    // must accept them through the parseStringSet path.
    const qs = new URLSearchParams('cat=cat-abc-1,cat-xyz-2');
    const f = fromSearchParams(qs);
    expect([...f.categories].sort()).toEqual(['cat-abc-1', 'cat-xyz-2']);
  });

  it('rejects unknown enum values (fits)', () => {
    const qs = new URLSearchParams('fits=good,definitely-not-a-fit');
    const f = fromSearchParams(qs);
    expect([...f.fits]).toEqual(['good']);
  });
});

describe('applyFilters', () => {
  const jobs: Job[] = [
    jobOf({ id: 'a', fit: 'good', score: 9, category: 'crypto' }),
    jobOf({ id: 'b', fit: 'ok', score: 5, category: 'crypto' }),
    jobOf({ id: 'c', fit: 'skip', score: 2, category: 'company' }),
    jobOf({ id: 'd', fit: null, score: null, category: 'security' }),
    jobOf({ id: 'e', fit: 'good', score: 9, priority: true, category: 'company' }),
  ];

  it('default filters return all rows (and unscored is included)', () => {
    const out = applyFilters(jobs, defaultFilters());
    expect(out.map((j) => j.id).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('fits=good only keeps fit=good rows', () => {
    const f = defaultFilters();
    f.fits = new Set(['good']);
    expect(applyFilters(jobs, f).map((j) => j.id).sort()).toEqual(['a', 'e']);
  });

  it('fits=skip keeps only skip rows', () => {
    const f = defaultFilters();
    f.fits = new Set(['skip']);
    expect(applyFilters(jobs, f).map((j) => j.id)).toEqual(['c']);
  });

  it('fits=unscored matches null-fit rows', () => {
    const f = defaultFilters();
    f.fits = new Set(['unscored']);
    expect(applyFilters(jobs, f).map((j) => j.id)).toEqual(['d']);
  });

  it('priority=yes keeps only priority rows', () => {
    const f = defaultFilters();
    f.priority = 'yes';
    expect(applyFilters(jobs, f).map((j) => j.id)).toEqual(['e']);
  });

  it('priority=no excludes priority rows', () => {
    const f = defaultFilters();
    f.priority = 'no';
    expect(applyFilters(jobs, f).map((j) => j.id).sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('category filter restricts by category id', () => {
    const f = defaultFilters();
    f.categories = new Set(['crypto']);
    expect(applyFilters(jobs, f).map((j) => j.id).sort()).toEqual(['a', 'b']);
  });

  it('score range excludes rows outside the band', () => {
    const f = defaultFilters();
    f.scoreMin = 7;
    f.scoreMax = 10;
    expect(applyFilters(jobs, f).map((j) => j.id).sort()).toEqual(['a', 'e']);
  });

  it('non-default score range excludes unscored rows', () => {
    const f = defaultFilters();
    f.scoreMin = 5;
    f.scoreMax = 10;
    // 'd' has score=null; with smin/smax not at the [1,10] default, it drops out.
    expect(applyFilters(jobs, f).map((j) => j.id)).not.toContain('d');
  });

  it('search query matches title or company', () => {
    const f = defaultFilters();
    f.search = 'engineer';
    // All 5 share 'Engineer' as title.
    expect(applyFilters(jobs, f).length).toBe(5);
    f.search = 'no-such-string';
    expect(applyFilters(jobs, f).length).toBe(0);
  });

  it('applied=yes filters by the externally-supplied applied set', () => {
    const f = defaultFilters();
    f.applied = 'yes';
    const applied = new Set(['a', 'c']);
    expect(applyFilters(jobs, f, applied).map((j) => j.id).sort()).toEqual(['a', 'c']);
  });

  it('applied=no excludes the applied set', () => {
    const f = defaultFilters();
    f.applied = 'no';
    const applied = new Set(['a', 'c']);
    expect(applyFilters(jobs, f, applied).map((j) => j.id).sort()).toEqual(['b', 'd', 'e']);
  });

  it('dateQuick=24h excludes rows older than 24h', () => {
    // Use a fixed-old timestamp so this is deterministic.
    const old = jobOf({ id: 'old', found_at: '1990-01-01T00:00:00' });
    const fresh = jobOf({ id: 'fresh', found_at: new Date().toISOString() });
    const f = defaultFilters();
    f.dateQuick = '24h';
    const out = applyFilters([old, fresh], f);
    expect(out.map((j) => j.id)).toContain('fresh');
    expect(out.map((j) => j.id)).not.toContain('old');
  });
});

describe('constants', () => {
  it('ALL_FITS includes the unscored sentinel', () => {
    expect(ALL_FITS).toContain('unscored');
  });
  it('ALL_SCORED_BY includes none', () => {
    expect(ALL_SCORED_BY).toContain('none');
  });
  it('ALL_SOURCES includes unknown', () => {
    expect(ALL_SOURCES).toContain('unknown');
  });
});
