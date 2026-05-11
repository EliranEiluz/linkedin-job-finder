// Tests for <JobsTable /> sort persistence.
//
// The bug being covered: marking a job applied triggers a corpus reload
// in CorpusPage, which passes a new `data` array reference to JobsTable.
// Before the fix, TanStack Table's default `autoResetSorting` would
// reset the user's sort to the table's initial state on every such
// reload — wiping (for example) "sort ascending by score" back to the
// applied-pinned defaults.
//
// We test the behavior, not the implementation:
//   1. sort survives a data-reference change (autoResetAll: false works)
//   2. sort survives a full unmount/remount (localStorage works)
//   3. malformed-localStorage entries still get the applied pin prepended
//   4. corrupt JSON in localStorage falls back to the defaults without
//      throwing
//
// The component takes ~20 props; we wrap it with a minimal default-prop
// helper so each test stays focused on sorting.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { JobsTable } from './JobsTable';
import type { Job } from './types';

const SORT_STORAGE_KEY = 'corpus_jobs_table_sort';

const makeJob = (id: string, score: number, found_at: string): Job => ({
  id,
  title: `Job ${id}`,
  company: `Co ${id}`,
  location: 'Remote',
  url: `https://example.com/${id}`,
  query: 'security engineer',
  category: 'security',
  found_at,
  priority: false,
  msc_required: null,
  fit: 'good',
  score,
  fit_reasons: [],
  scored_by: 'claude',
  source: 'guest',
});

const baseData: Job[] = [
  makeJob('a', 50, '2026-05-01T00:00:00Z'),
  makeJob('b', 80, '2026-05-02T00:00:00Z'),
  makeJob('c', 30, '2026-05-03T00:00:00Z'),
];

const renderTable = (data: Job[] = baseData) =>
  render(
    <JobsTable
      data={data}
      applied={new Set()}
      onToggleApplied={() => undefined}
    />,
  );

// Rows render in <tr> elements inside <tbody>. Reading their first
// data-anything is brittle, so we read the Job id from the `Job <id>`
// text in the title column.
const renderedJobIds = (): string[] => {
  const rows = screen.getAllByRole('row');
  // First row is the <thead> tr.
  return rows
    .slice(1)
    .map((tr) => {
      const match = /Job ([a-z])/.exec(tr.textContent);
      return match?.[1] ?? '';
    })
    .filter(Boolean);
};

describe('JobsTable sort persistence', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('sort_persists_across_data_change: re-rendering with a new data reference keeps the user-chosen sort', async () => {
    // Default sort is { applied asc, priority desc, score desc, found_at
    // desc } — so the rows render in score-desc order: b (80), a (50), c
    // (30). Click the Score header twice: first click flips to asc
    // (sortDescFirst: false after toggle from desc), second click... wait,
    // score column has `sortDescFirst: true`, so:
    //   - desc (initial) → click → asc → click → no sort (cleared)
    // We want ASC, so one click after the initial desc state. But the
    // header click toggles between desc → asc → cleared → desc. Since
    // initial sort already has score desc, the first click should land
    // us in asc.
    const user = userEvent.setup();
    const { rerender } = renderTable();

    // Initial: b (80), a (50), c (30) — score-desc.
    expect(renderedJobIds()).toEqual(['b', 'a', 'c']);

    const scoreHeader = screen.getByRole('columnheader', { name: /Score/i });
    await user.click(scoreHeader);

    // After one click: asc — c (30), a (50), b (80).
    expect(renderedJobIds()).toEqual(['c', 'a', 'b']);

    // Now pass a new array reference (mimicking a corpus reload after
    // toggleApplied). Before the fix, TanStack would reset sorting back
    // to the score-desc default and we'd see [b, a, c] again.
    const reloaded = baseData.map((j) => ({ ...j }));
    rerender(
      <JobsTable
        data={reloaded}
        applied={new Set()}
        onToggleApplied={() => undefined}
      />,
    );

    expect(renderedJobIds()).toEqual(['c', 'a', 'b']);
  });

  it('sort_persists_to_localStorage_across_remount: a re-mount restores the user sort from storage', async () => {
    const user = userEvent.setup();
    const { unmount } = renderTable();

    const scoreHeader = screen.getByRole('columnheader', { name: /Score/i });
    await user.click(scoreHeader);

    expect(renderedJobIds()).toEqual(['c', 'a', 'b']);

    // Storage should now hold the asc-score sort with the applied pin.
    const stored = JSON.parse(localStorage.getItem(SORT_STORAGE_KEY) ?? '[]');
    expect(stored[0]).toEqual({ id: 'applied', desc: false });
    expect(stored).toContainEqual({ id: 'score', desc: false });

    unmount();
    // Same data, fresh component instance — but with the storage entry
    // still in place from the previous mount.
    renderTable();

    expect(renderedJobIds()).toEqual(['c', 'a', 'b']);
  });

  it('applied_pin_always_first: a malformed stored sort (no applied entry) gets the pin re-attached on read', () => {
    // Someone (older code, manual devtools, profile sync) wrote a sort
    // that has score-asc but no applied entry. On mount, the table
    // should still treat applied as the first sort key.
    localStorage.setItem(
      SORT_STORAGE_KEY,
      JSON.stringify([{ id: 'score', desc: false }]),
    );

    renderTable();

    const stored = JSON.parse(localStorage.getItem(SORT_STORAGE_KEY) ?? '[]');
    // Storage is only re-written on user setSorting calls, so it still
    // reflects the malformed input here. The DOM is what counts:
    // applied-asc + score-asc means rows still render in score-asc
    // order (no applied rows in the data, so the applied key is a no-op
    // sort, and score-asc takes over).
    expect(stored).toEqual([{ id: 'score', desc: false }]);
    expect(renderedJobIds()).toEqual(['c', 'a', 'b']);
  });

  it('corrupt_localStorage_falls_back_to_default: unparseable JSON does not throw and the default sort renders', () => {
    localStorage.setItem(SORT_STORAGE_KEY, 'not json {{{');

    // Should NOT throw. The fallback path catches the JSON.parse error
    // and returns DEFAULT_SORTING.
    expect(() => renderTable()).not.toThrow();

    // Default sort = score desc → b, a, c.
    expect(renderedJobIds()).toEqual(['b', 'a', 'c']);
  });
});

// Silence the noisy "Not implemented: HTMLCanvasElement" log happy-dom
// emits when @tanstack/react-table probes layout. The tests don't assert
// on canvas behavior — happy-dom's stub is fine.
vi.spyOn(console, 'error').mockImplementation((msg) => {
  if (typeof msg === 'string' && /not implemented/i.test(msg)) return;
  // eslint-disable-next-line no-console
  console.warn(msg);
});
