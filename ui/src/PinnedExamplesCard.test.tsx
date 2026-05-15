// @vitest-environment jsdom
//
// Tests for <PinnedExamplesCard /> (#124). Covers:
//   - count display in the header reflects `pinnedIds.length / cap`
//   - empty state copy when no pins are configured
//   - rendered list of pinned rows resolves title + company from
//     results.json (MSW-mocked)
//   - per-row unpin button calls /api/corpus/pin-example with the
//     correct body and forwards the post-mutation list to onPinnedChange
//   - ids that don't resolve against results.json render with the
//     "(not in current corpus)" placeholder

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { server } from './__tests__/msw';
import { PinnedExamplesCard } from './PinnedExamplesCard';
import type { Job } from './types';

beforeAll(() => { server.listen({ onUnhandledRequest: 'error' }); });
afterEach(() => { server.resetHandlers(); cleanup(); });
afterAll(() => { server.close(); });

const sampleCorpus: Job[] = [
  {
    id: 'a',
    title: 'Senior Engineer',
    company: 'Acme',
    location: 'Remote',
    url: 'https://example.com/a',
    query: 'engineer',
    category: 'keyword',
    found_at: '2026-05-01T00:00:00Z',
    priority: false,
    msc_required: null,
    fit: 'good',
    score: 9,
    fit_reasons: [],
    scored_by: 'claude',
    source: 'guest',
  },
  {
    id: 'b',
    title: 'Staff SWE',
    company: 'Globex',
    location: 'NYC',
    url: 'https://example.com/b',
    query: 'engineer',
    category: 'keyword',
    found_at: '2026-05-02T00:00:00Z',
    priority: false,
    msc_required: null,
    fit: 'ok',
    score: 7,
    fit_reasons: [],
    scored_by: 'claude',
    source: 'guest',
  },
];

const corpusHandler = http.get(/results\.json/, () =>
  HttpResponse.json(sampleCorpus),
);

describe('PinnedExamplesCard', () => {
  it('renders the count + empty state when no pins are configured', () => {
    server.use(corpusHandler);
    render(
      <PinnedExamplesCard
        pinnedIds={[]}
        cap={6}
        onPinnedChange={() => undefined}
      />,
    );
    expect(screen.getByText('Pinned few-shot examples')).toBeInTheDocument();
    expect(screen.getByText('0 / 6 slots used')).toBeInTheDocument();
    expect(
      screen.getByText(/No pinned examples yet/i),
    ).toBeInTheDocument();
  });

  it('renders the count + resolves pinned rows from results.json', async () => {
    server.use(corpusHandler);
    render(
      <PinnedExamplesCard
        pinnedIds={['a', 'b']}
        cap={5}
        onPinnedChange={() => undefined}
      />,
    );
    expect(screen.getByText('2 / 5 slots used')).toBeInTheDocument();
    // Wait for the corpus fetch to resolve and the rows to render.
    await waitFor(() => {
      expect(screen.getByText('Senior Engineer')).toBeInTheDocument();
    });
    expect(screen.getByText('Staff SWE')).toBeInTheDocument();
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.getByText('Globex')).toBeInTheDocument();
    // Both rows show their score chip.
    expect(screen.getByText('score 9')).toBeInTheDocument();
    expect(screen.getByText('score 7')).toBeInTheDocument();
  });

  it('renders a "(not in current corpus)" placeholder for ids missing from results.json', async () => {
    server.use(corpusHandler);
    render(
      <PinnedExamplesCard
        pinnedIds={['ghost', 'a']}
        cap={6}
        onPinnedChange={() => undefined}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText('Senior Engineer')).toBeInTheDocument();
    });
    // The unresolved id still appears in the list with a placeholder.
    expect(screen.getByText('ghost')).toBeInTheDocument();
    expect(
      screen.getByText(/not in current corpus/i),
    ).toBeInTheDocument();
  });

  it('per-row Unpin POSTs to /api/corpus/pin-example and forwards the new list', async () => {
    server.use(corpusHandler);
    let capturedBody: Record<string, unknown> | null = null;
    server.use(
      http.post('*/api/corpus/pin-example', async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          ok: true,
          id: capturedBody.id,
          pinned: capturedBody.pinned,
          pinned_examples: ['b'], // post-mutation list after unpinning 'a'
        });
      }),
    );
    const onPinnedChange = vi.fn();
    const user = userEvent.setup();
    render(
      <PinnedExamplesCard
        pinnedIds={['a', 'b']}
        cap={6}
        onPinnedChange={onPinnedChange}
      />,
    );
    // Wait for the corpus to resolve so the buttons render with labels.
    await waitFor(() => {
      expect(screen.getByText('Senior Engineer')).toBeInTheDocument();
    });
    // The "Unpin Senior Engineer" button targets row 'a'.
    const unpinA = screen.getByLabelText(/Unpin Senior Engineer/i);
    await user.click(unpinA);
    await waitFor(() => {
      expect(capturedBody).not.toBeNull();
    });
    expect(capturedBody).toEqual({ id: 'a', pinned: false });
    expect(onPinnedChange).toHaveBeenCalledTimes(1);
    expect(onPinnedChange).toHaveBeenCalledWith(['b']);
  });

  it('falls back to a default cap when `cap` prop is undefined', () => {
    server.use(corpusHandler);
    render(
      <PinnedExamplesCard
        pinnedIds={['a']}
        onPinnedChange={() => undefined}
      />,
    );
    // Default cap = 6 (mirrors backend FEEDBACK_EXAMPLES_MAX_DEFAULT).
    expect(screen.getByText('1 / 6 slots used')).toBeInTheDocument();
  });
});
