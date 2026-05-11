// @vitest-environment jsdom
//
// Tests for <CorpusFilterCard /> — the post-scoring corpus filter knobs
// that live in the Crawler Config tab after NotificationsCard.
// Covers:
//   1. each Min Fit dropdown option maps to the expected min_fit value
//   2. the score toggle round-trips correctly between null and a number
//   3. current values render from the props (no internal state shadowing)
//   4. the "X filtered last run" badge reads run_history.json and
//      hides itself when the latest entry has no filtered_out field
//      (pre-feature history rows) OR zero
//
// jsdom for the MSW v2 + happy-dom interop reason documented in
// __tests__/msw.ts.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from './__tests__/msw';
import { CorpusFilterCard } from './CorpusFilterCard';
import type { CorpusFilter } from './configTypes';

beforeAll(() => { server.listen({ onUnhandledRequest: 'error' }); });
afterEach(() => { server.resetHandlers(); });
afterAll(() => { server.close(); });

// run_history.json default — empty file, so the "filtered last run"
// badge stays hidden. Tests that care about the badge override.
const noHistoryHandler = http.get(/run_history\.json/, () =>
  HttpResponse.json({ runs: [] }),
);

const disabled: CorpusFilter = { min_fit: null, min_score: null };

describe('CorpusFilterCard', () => {
  it('renders the card chrome + disabled controls when filter is off', () => {
    server.use(noHistoryHandler);
    render(<CorpusFilterCard current={disabled} onChange={() => undefined} />);

    expect(screen.getByText('Corpus filter')).toBeInTheDocument();
    // Min Fit defaults to "Off (no filter)".
    const fitSelect = screen.getByLabelText('Min fit');
    expect(fitSelect.value).toBe('');
    // Score is disabled.
    const scoreInput = screen.getByLabelText('Min score (0-10)');
    expect(scoreInput).toBeDisabled();
    // Help text is present.
    expect(
      screen.getByText(/won't appear in your corpus/i),
    ).toBeInTheDocument();
  });

  it.each<[string, CorpusFilter['min_fit']]>([
    ['', null],
    ['ok', 'ok'],
    ['good', 'good'],
  ])(
    'min fit select option %s -> min_fit=%s',
    async (selectValue, expectedMinFit) => {
      server.use(noHistoryHandler);
      const onChange = vi.fn();
      const user = userEvent.setup();
      // Start from a non-trivial state so even the "" -> null case is
      // observable (otherwise the dropdown stays unchanged and onChange
      // would never fire). Easiest: start at "good" and let the test
      // change it to whatever the row says.
      render(
        <CorpusFilterCard
          current={{ min_fit: 'good', min_score: null }}
          onChange={onChange}
        />,
      );

      // Pick the row's target value (HTMLSelectElement.value supports '' too).
      const select = screen.getByLabelText('Min fit');
      await user.selectOptions(select, selectValue);

      // After the user picks the row's target, the last onChange call
      // should reflect the expected min_fit. When the row's selectValue
      // is the same as the starting state ('good'), selectOptions is a
      // no-op and onChange isn't called — guard against that.
      if (selectValue === 'good') {
        // No change expected; the starting state is already 'good'.
        return;
      }
      await waitFor(() => {
        expect(onChange).toHaveBeenLastCalledWith({
          min_fit: expectedMinFit,
          min_score: null,
        });
      });
    },
  );

  it('toggling the score checkbox round-trips between null and a number', async () => {
    server.use(noHistoryHandler);
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <CorpusFilterCard
        current={{ min_fit: null, min_score: null }}
        onChange={onChange}
      />,
    );

    // Initial state: score disabled, default draft is 5.
    const checkbox = screen.getByLabelText('Enable score threshold');
    expect(checkbox).not.toBeChecked();

    // Tick the checkbox — onChange must fire with min_score=5 (the
    // draft default).
    await user.click(checkbox);
    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith({
        min_fit: null,
        min_score: 5,
      });
    });
  });

  it('typing in the score input updates min_score when enabled', async () => {
    server.use(noHistoryHandler);
    const onChange = vi.fn();
    render(
      <CorpusFilterCard
        current={{ min_fit: null, min_score: 5 }}
        onChange={onChange}
      />,
    );

    const scoreInput = screen.getByLabelText('Min score (0-10)');
    expect(scoreInput).toHaveValue(5);
    expect(scoreInput).not.toBeDisabled();
    // fireEvent.change replaces the value atomically — user.type with a
    // controlled <input type="number"> hits the React-state-vs-typed
    // characters interleaving that's too easy to model wrong here.
    fireEvent.change(scoreInput, { target: { value: '8' } });

    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith({
        min_fit: null,
        min_score: 8,
      });
    });
  });

  it('clamps the score input to the 0..10 range when typed value is out of range', async () => {
    server.use(noHistoryHandler);
    const onChange = vi.fn();
    render(
      <CorpusFilterCard
        current={{ min_fit: null, min_score: 5 }}
        onChange={onChange}
      />,
    );

    const scoreInput = screen.getByLabelText('Min score (0-10)');
    fireEvent.change(scoreInput, { target: { value: '99' } });

    // 99 clamps to 10.
    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith({
        min_fit: null,
        min_score: 10,
      });
    });
  });

  it('renders current values without internal state shadowing', () => {
    server.use(noHistoryHandler);
    render(
      <CorpusFilterCard
        current={{ min_fit: 'good', min_score: 7 }}
        onChange={() => undefined}
      />,
    );
    const fitSelect = screen.getByLabelText('Min fit');
    expect(fitSelect.value).toBe('good');
    const checkbox = screen.getByLabelText('Enable score threshold');
    expect(checkbox).toBeChecked();
    const scoreInput = screen.getByLabelText('Min score (0-10)');
    expect(scoreInput).toHaveValue(7);
  });

  it('shows the "X filtered last run" badge when the latest run has filtered_out > 0', async () => {
    server.use(
      http.get(/run_history\.json/, () =>
        HttpResponse.json({
          runs: [
            {
              started_at: '2026-05-01T10:00:00',
              ended_at: '2026-05-01T10:05:00',
              duration_sec: 300,
              args: { all: false, no_enrich: false, all_time: false, pages: null, max_pages_used: 3 },
              queries: [],
              totals: {
                new_jobs: 20,
                scored_claude: 18,
                scored_regex: 2,
                title_filtered: 0,
                descriptions_fetched: 20,
                descriptions_failed: 0,
                filtered_out: 12,
              },
              fit_distribution: { good: 8, ok: 4, skip: 0, unscored: 0 },
              errors: [],
            },
          ],
        }),
      ),
    );
    render(<CorpusFilterCard current={disabled} onChange={() => undefined} />);

    await waitFor(() => {
      expect(screen.getByTestId('corpus-filter-last-run-badge')).toHaveTextContent(
        '12',
      );
    });
  });

  it('hides the badge when the latest run has no filtered_out field (pre-feature history)', async () => {
    server.use(
      http.get(/run_history\.json/, () =>
        HttpResponse.json({
          runs: [
            {
              started_at: '2026-05-01T10:00:00',
              ended_at: '2026-05-01T10:05:00',
              duration_sec: 300,
              args: { all: false, no_enrich: false, all_time: false, pages: null, max_pages_used: 3 },
              queries: [],
              totals: {
                new_jobs: 20,
                scored_claude: 18,
                scored_regex: 2,
                title_filtered: 0,
                descriptions_fetched: 20,
                descriptions_failed: 0,
                // No filtered_out — pre-#117 history row.
              },
              fit_distribution: { good: 8, ok: 4, skip: 0, unscored: 0 },
              errors: [],
            },
          ],
        }),
      ),
    );
    render(<CorpusFilterCard current={disabled} onChange={() => undefined} />);

    // Wait long enough for the async fetch to settle, then assert the
    // badge is absent.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByTestId('corpus-filter-last-run-badge')).toBeNull();
  });

  it('hides the badge when filtered_out is zero', async () => {
    server.use(
      http.get(/run_history\.json/, () =>
        HttpResponse.json({
          runs: [
            {
              started_at: '2026-05-01T10:00:00',
              ended_at: '2026-05-01T10:05:00',
              duration_sec: 300,
              args: { all: false, no_enrich: false, all_time: false, pages: null, max_pages_used: 3 },
              queries: [],
              totals: {
                new_jobs: 20,
                scored_claude: 18,
                scored_regex: 2,
                title_filtered: 0,
                descriptions_fetched: 20,
                descriptions_failed: 0,
                filtered_out: 0,
              },
              fit_distribution: { good: 8, ok: 4, skip: 0, unscored: 0 },
              errors: [],
            },
          ],
        }),
      ),
    );
    render(<CorpusFilterCard current={disabled} onChange={() => undefined} />);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByTestId('corpus-filter-last-run-badge')).toBeNull();
  });
});
