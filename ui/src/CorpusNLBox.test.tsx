// @vitest-environment jsdom
//
// Tests for <CorpusNLBox /> — the natural-language filter input on the
// Corpus tab. The component shells out to /api/corpus/nl, so we use
// MSW v2 to stand in for the dev middleware. jsdom (not happy-dom) is
// required because the component reads res.json() — see the comment
// in __tests__/msw.ts for the happy-dom interop bug we sidestep.
//
// Coverage matches the spec's UI test list:
//   1. Renders input + Filter button (initial state)
//   2. Empty/whitespace submit doesn't fire the request
//   3. Successful parse shows parse_summary + Apply/Cancel
//   4. Apply calls onApply with the validated FilterState
//   5. Cancel returns to the input state
//   6. Error response renders inline error + Retry
//
// Plus one extra worth pinning: the client-side validator silently
// drops invalid enum values from the server envelope, so a future ctl
// bug can't poison FilterState. We test that through the public
// onApply prop rather than the validator directly — same effect,
// closer to what the user sees.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from './__tests__/msw';
import { CorpusNLBox } from './CorpusNLBox';
import type { FilterState } from './filters';
import { defaultFilters } from './filters';

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

// Helper: register an /api/corpus/nl handler that returns the given
// envelope. Tests opt into specific server responses per-test.
//
// `body` is loosely typed (matches what the server actually emits —
// any JSON-serialisable object) rather than the stricter ServerEnvelope
// shape, because several tests intentionally include unknown fields the
// client validator should drop.
const mockNlEndpoint = (body: Record<string, unknown>, status = 200) => {
  server.use(
    http.post('/api/corpus/nl', () => HttpResponse.json(body, { status })),
  );
};

describe('CorpusNLBox', () => {
  it('renders the input and Filter button in the initial state', () => {
    render(<CorpusNLBox onApply={() => undefined} />);

    expect(
      screen.getByPlaceholderText(/Filter by typing/i),
    ).toBeInTheDocument();
    // Filter button visible, but disabled while the input is empty.
    const btn = screen.getByRole('button', { name: 'Filter' });
    expect(btn).toBeInTheDocument();
    expect(btn).toBeDisabled();
  });

  it("doesn't fire a request when the query is empty/whitespace", async () => {
    // Register a strict handler that would throw if hit. The fact that
    // the request never reaches MSW is what we're asserting.
    const onCall = vi.fn();
    server.use(
      http.post('/api/corpus/nl', () => {
        onCall();
        return HttpResponse.json({ ok: true, filters: {}, parse_summary: '' });
      }),
    );

    const user = userEvent.setup();
    render(<CorpusNLBox onApply={() => undefined} />);

    const input = screen.getByPlaceholderText(/Filter by typing/i);
    // Press Enter on an empty input.
    await user.click(input);
    await user.keyboard('{Enter}');
    // Type whitespace and Enter — also a no-op.
    await user.type(input, '   ');
    await user.keyboard('{Enter}');

    // Give the event loop a beat to register any erroneous fetch.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(onCall).not.toHaveBeenCalled();
    // Button is still disabled (only whitespace typed).
    expect(screen.getByRole('button', { name: 'Filter' })).toBeDisabled();
  });

  it('shows the parse_summary + Apply/Cancel on a successful parse', async () => {
    mockNlEndpoint({
      ok: true,
      filters: { categories: ['security'], dateQuick: '7d' },
      parse_summary: 'Categories: Security - Last 7 days',
    });

    const user = userEvent.setup();
    render(<CorpusNLBox onApply={() => undefined} />);

    await user.type(
      screen.getByPlaceholderText(/Filter by typing/i),
      'security jobs last week',
    );
    await user.click(screen.getByRole('button', { name: 'Filter' }));

    // Preview line renders the server-side summary verbatim.
    const summary = await screen.findByTestId('corpus-nl-preview-summary');
    expect(summary).toHaveTextContent('Categories: Security - Last 7 days');
    // Both Apply and Cancel buttons replace the Filter button.
    expect(screen.getByRole('button', { name: 'Apply' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Filter' }),
    ).not.toBeInTheDocument();
  });

  it('Apply calls onApply with the validated filters', async () => {
    mockNlEndpoint({
      ok: true,
      filters: {
        categories: ['security', 'sre'],
        // The ctl-side enum says these are valid; the client validator
        // accepts both.
        fits: ['good', 'ok'],
        priority: 'yes',
        dateQuick: '7d',
        scoreMin: 7,
      },
      parse_summary: 'Categories: Security, SRE - Priority - Last 7 days',
    });

    const onApply = vi.fn<(f: FilterState) => void>();
    const user = userEvent.setup();
    render(<CorpusNLBox onApply={onApply} />);

    await user.type(
      screen.getByPlaceholderText(/Filter by typing/i),
      'security sre priority last week score 7+',
    );
    await user.click(screen.getByRole('button', { name: 'Filter' }));
    await screen.findByRole('button', { name: 'Apply' });
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => {
      expect(onApply).toHaveBeenCalledTimes(1);
    });
    const filters = onApply.mock.calls[0]?.[0];
    expect(filters).toBeDefined();
    if (!filters) throw new Error('onApply not called with filters');

    // Validator wraps the arrays into Sets — assert by membership, not
    // by reference, so the test doesn't care about insertion order.
    expect([...filters.categories].sort()).toEqual(['security', 'sre']);
    expect([...filters.fits].sort()).toEqual(['good', 'ok']);
    expect(filters.priority).toBe('yes');
    expect(filters.dateQuick).toBe('7d');
    expect(filters.scoreMin).toBe(7);
    // Fields the ctl didn't emit fall back to the default state.
    const d = defaultFilters();
    expect(filters.scoreMax).toBe(d.scoreMax);
    expect(filters.applied).toBe(d.applied);
    expect(filters.search).toBe(d.search);
  });

  it('Cancel returns to the input state without firing onApply', async () => {
    mockNlEndpoint({
      ok: true,
      filters: { dateQuick: '24h' },
      parse_summary: 'Last 24 hours',
    });

    const onApply = vi.fn();
    const user = userEvent.setup();
    render(<CorpusNLBox onApply={onApply} />);

    await user.type(
      screen.getByPlaceholderText(/Filter by typing/i),
      'last day',
    );
    await user.click(screen.getByRole('button', { name: 'Filter' }));
    await screen.findByRole('button', { name: 'Cancel' });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    // Back to the input state — Filter button is back, Apply is gone.
    expect(screen.getByRole('button', { name: 'Filter' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
    // Query stays in the input so the user can tweak-and-resend.
    expect(screen.getByPlaceholderText(/Filter by typing/i)).toHaveValue(
      'last day',
    );
    expect(onApply).not.toHaveBeenCalled();
  });

  it('renders an inline error when the server returns ok=false', async () => {
    mockNlEndpoint(
      { ok: false, error: 'llm error: rate limit', raw: '' },
      400,
    );

    const user = userEvent.setup();
    render(<CorpusNLBox onApply={() => undefined} />);

    await user.type(
      screen.getByPlaceholderText(/Filter by typing/i),
      'whatever',
    );
    await user.click(screen.getByRole('button', { name: 'Filter' }));

    const errBox = await screen.findByTestId('corpus-nl-error');
    expect(errBox).toHaveTextContent(/llm error: rate limit/);
    // Retry affordance is part of the error block.
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    // And the input + Filter button are still visible so the user can edit.
    expect(screen.getByRole('button', { name: 'Filter' })).toBeInTheDocument();
  });

  it('drops invalid enum values from the server response before Apply', async () => {
    // The ctl is supposed to drop these, but we test the client-side
    // belt-and-suspenders validator here.
    mockNlEndpoint({
      ok: true,
      filters: {
        categories: ['security'],
        // 'great' isn't a valid Fit — should be dropped.
        fits: ['great', 'good'],
        // 'maybe' isn't a valid tri — should be ignored, default 'all' kept.
        priority: 'maybe',
        // '2w' isn't a valid bucket — should be ignored.
        dateQuick: '2w',
        // Score out of range — should be ignored.
        scoreMin: 99,
      },
      parse_summary: 'Categories: Security',
    });

    const onApply = vi.fn<(f: FilterState) => void>();
    const user = userEvent.setup();
    render(<CorpusNLBox onApply={onApply} />);

    await user.type(
      screen.getByPlaceholderText(/Filter by typing/i),
      'noisy query',
    );
    await user.click(screen.getByRole('button', { name: 'Filter' }));
    await screen.findByRole('button', { name: 'Apply' });
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => {
      expect(onApply).toHaveBeenCalledTimes(1);
    });
    const filters = onApply.mock.calls[0]?.[0];
    expect(filters).toBeDefined();
    if (!filters) throw new Error('onApply not called with filters');

    expect([...filters.categories]).toEqual(['security']);
    // Only the valid fit survived.
    expect([...filters.fits]).toEqual(['good']);
    // Invalid tri / bucket / score were silently dropped (defaults remain).
    const d = defaultFilters();
    expect(filters.priority).toBe(d.priority);
    expect(filters.dateQuick).toBe(d.dateQuick);
    expect(filters.scoreMin).toBe(d.scoreMin);
  });
});
