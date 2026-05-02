// @vitest-environment jsdom
//
// Tests for ui/src/hooks.ts — uses jsdom because the corpus + app-status
// hooks call res.json() and happy-dom 15's stream-locking interop bug
// with MSW v2 breaks that path. See src/__tests__/msw.ts for refs.
//
// Coverage:
//   - useDebounced: timer math; cancellation on rapid input changes
//   - useUrlSync: window.history.replaceState round-trip; no-write when
//     query string is unchanged (prev-ref guard)
//   - useCorpusActions: deleteJobs / rateJob / rescoreJobs / pushToEndJobs
//     happy + error + early-return-on-empty-ids paths; rateJob does NOT
//     fire the corpus-stale event (intentional; comment in hooks.ts:65)
//   - useAppStatus: setAppStatus / bulkImportApplied; tri-state `note`
//     forwarding (undefined absent / null cleared / string set)
//   - useAddManual: 200 / 409-dup / error / empty-input paths

import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { act, renderHook, waitFor } from '@testing-library/react';
import { server } from './__tests__/msw';
import {
  useDebounced,
  useUrlSync,
  useCorpusActions,
  useAppStatus,
  useAddManual,
} from './hooks';

beforeAll(() => { server.listen({ onUnhandledRequest: 'error' }); });
afterEach(() => { server.resetHandlers(); });
afterAll(() => { server.close(); });

// ─────────────────────────────────────────────────────────────────────
// useDebounced
// ─────────────────────────────────────────────────────────────────────
describe('useDebounced', () => {
  it('returns the initial value synchronously', () => {
    const { result } = renderHook(() => useDebounced('abc', 200));
    expect(result.current).toBe('abc');
  });

  it('emits the new value after the delay elapses', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ v }: { v: string }) => useDebounced(v, 150),
      { initialProps: { v: 'first' } },
    );
    rerender({ v: 'second' });
    // Still showing previous value before the timer fires.
    expect(result.current).toBe('first');
    act(() => { vi.advanceTimersByTime(149); });
    expect(result.current).toBe('first');
    act(() => { vi.advanceTimersByTime(2); });
    expect(result.current).toBe('second');
    vi.useRealTimers();
  });

  it('coalesces rapid changes — only the last one lands', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ v }: { v: string }) => useDebounced(v, 100),
      { initialProps: { v: 'a' } },
    );
    rerender({ v: 'b' });
    act(() => { vi.advanceTimersByTime(50); });
    rerender({ v: 'c' });
    act(() => { vi.advanceTimersByTime(50); });
    // Still 'a' — the second rerender reset the timer.
    expect(result.current).toBe('a');
    act(() => { vi.advanceTimersByTime(50); });
    expect(result.current).toBe('c');
    vi.useRealTimers();
  });

  it('honours a custom delay (default is 150ms)', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ v }: { v: number }) => useDebounced(v),
      { initialProps: { v: 1 } },
    );
    rerender({ v: 2 });
    act(() => { vi.advanceTimersByTime(149); });
    expect(result.current).toBe(1);
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current).toBe(2);
    vi.useRealTimers();
  });
});

// ─────────────────────────────────────────────────────────────────────
// useUrlSync
// ─────────────────────────────────────────────────────────────────────
describe('useUrlSync', () => {
  // The hook calls window.history.replaceState — we spy on it instead of
  // asserting window.location, since happy-dom and jsdom both treat
  // location updates conservatively.
  it('writes the search params to the URL on first run', () => {
    const spy = vi.spyOn(window.history, 'replaceState');
    const params = new URLSearchParams('foo=bar&baz=qux');
    renderHook(() => { useUrlSync(params); });
    expect(spy).toHaveBeenCalled();
    const lastArgs = spy.mock.calls[spy.mock.calls.length - 1];
    expect(lastArgs[2]).toMatch(/foo=bar/);
    expect(lastArgs[2]).toMatch(/baz=qux/);
    spy.mockRestore();
  });

  it('drops the `?` when the params are emptied after a non-empty pass', () => {
    // The hook short-circuits when the serialized query string is unchanged
    // from prev.current (initialised to ''). So an empty initial render
    // never calls replaceState. We exercise the empty-qs branch by
    // rendering with a non-empty value first and then transitioning to
    // an empty one — the second call should land an unprefixed pathname.
    const spy = vi.spyOn(window.history, 'replaceState');
    const { rerender } = renderHook(
      ({ p }: { p: URLSearchParams }) => { useUrlSync(p); },
      { initialProps: { p: new URLSearchParams('a=1') } },
    );
    rerender({ p: new URLSearchParams('') });
    const lastArgs = spy.mock.calls[spy.mock.calls.length - 1];
    expect(lastArgs[2]).not.toContain('?');
    spy.mockRestore();
  });

  it('does NOT write when the query string is unchanged across rerenders', () => {
    const spy = vi.spyOn(window.history, 'replaceState');
    // Same query, fresh URLSearchParams instance — the hook compares the
    // serialized query, not the object identity.
    const { rerender } = renderHook(
      ({ p }: { p: URLSearchParams }) => { useUrlSync(p); },
      { initialProps: { p: new URLSearchParams('a=1') } },
    );
    const callsAfterFirst = spy.mock.calls.length;
    rerender({ p: new URLSearchParams('a=1') });
    expect(spy.mock.calls.length).toBe(callsAfterFirst);
    spy.mockRestore();
  });

  it('writes again when the query string changes', () => {
    const spy = vi.spyOn(window.history, 'replaceState');
    const { rerender } = renderHook(
      ({ p }: { p: URLSearchParams }) => { useUrlSync(p); },
      { initialProps: { p: new URLSearchParams('a=1') } },
    );
    const callsAfterFirst = spy.mock.calls.length;
    rerender({ p: new URLSearchParams('a=2') });
    expect(spy.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    spy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────
// useCorpusActions
// ─────────────────────────────────────────────────────────────────────
describe('useCorpusActions', () => {
  it('deleteJobs returns ok=true on success and fires corpus-stale', async () => {
    let captured: unknown = null;
    server.use(
      http.post('*/api/corpus/delete', async ({ request }) => {
        captured = await request.json();
        return HttpResponse.json({ ok: true });
      }),
    );
    const stale = vi.fn();
    window.addEventListener('linkedinjobs:corpus-stale', stale);
    const { result } = renderHook(() => useCorpusActions());
    const r = await result.current.deleteJobs(['a', 'b']);
    expect(r).toEqual({ ok: true });
    expect(captured).toEqual({ ids: ['a', 'b'] });
    expect(stale).toHaveBeenCalledTimes(1);
    window.removeEventListener('linkedinjobs:corpus-stale', stale);
  });

  it('deleteJobs short-circuits with ok=true on empty ids without hitting the network', async () => {
    // No handler registered — onUnhandledRequest:'error' would blow up if
    // a fetch actually fired. The early return is what we're verifying.
    const { result } = renderHook(() => useCorpusActions());
    const r = await result.current.deleteJobs([]);
    expect(r).toEqual({ ok: true });
  });

  it('deleteJobs surfaces server-side error messages', async () => {
    server.use(
      http.post('*/api/corpus/delete', () =>
        HttpResponse.json({ ok: false, error: 'disk full' }, { status: 500 }),
      ),
    );
    const { result } = renderHook(() => useCorpusActions());
    const r = await result.current.deleteJobs(['a']);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('disk full');
  });

  it('deleteJobs surfaces a network error via the catch block', async () => {
    server.use(
      http.post('*/api/corpus/delete', () =>
        HttpResponse.error(),
      ),
    );
    const { result } = renderHook(() => useCorpusActions());
    const r = await result.current.deleteJobs(['a']);
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe('string');
  });

  it('rateJob does NOT fire corpus-stale (per the comment in hooks.ts)', async () => {
    server.use(
      http.post('*/api/corpus/rate', () =>
        HttpResponse.json({ ok: true }),
      ),
    );
    const stale = vi.fn();
    window.addEventListener('linkedinjobs:corpus-stale', stale);
    const { result } = renderHook(() => useCorpusActions());
    const r = await result.current.rateJob('job-1', 5);
    expect(r.ok).toBe(true);
    expect(stale).not.toHaveBeenCalled();
    window.removeEventListener('linkedinjobs:corpus-stale', stale);
  });

  it('rateJob omits `comment` from the payload when undefined (tri-state contract)', async () => {
    let captured: Record<string, unknown> | null = null;
    server.use(
      http.post('*/api/corpus/rate', async ({ request }) => {
        captured = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ok: true });
      }),
    );
    const { result } = renderHook(() => useCorpusActions());
    await result.current.rateJob('job-1', 4);
    expect(captured).toEqual({ id: 'job-1', rating: 4 });
    expect(captured).not.toHaveProperty('comment');
  });

  it('rateJob forwards `comment: null` to clear the field server-side', async () => {
    let captured: Record<string, unknown> | null = null;
    server.use(
      http.post('*/api/corpus/rate', async ({ request }) => {
        captured = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ok: true });
      }),
    );
    const { result } = renderHook(() => useCorpusActions());
    await result.current.rateJob('job-1', 4, null);
    expect(captured).toEqual({ id: 'job-1', rating: 4, comment: null });
  });

  it('rateJob forwards a string comment verbatim', async () => {
    let captured: Record<string, unknown> | null = null;
    server.use(
      http.post('*/api/corpus/rate', async ({ request }) => {
        captured = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ok: true });
      }),
    );
    const { result } = renderHook(() => useCorpusActions());
    await result.current.rateJob('job-1', 4, 'looks promising');
    expect(captured).toEqual({
      id: 'job-1',
      rating: 4,
      comment: 'looks promising',
    });
  });

  it('rescoreJobs returns counts on success and fires corpus-stale', async () => {
    server.use(
      http.post('*/api/corpus/rescore', () =>
        HttpResponse.json({
          ok: true,
          rescored: 3,
          claude_rescored: 2,
          regex_fallback: 1,
          failed: 0,
          missing: [],
        }),
      ),
    );
    const stale = vi.fn();
    window.addEventListener('linkedinjobs:corpus-stale', stale);
    const { result } = renderHook(() => useCorpusActions());
    const r = await result.current.rescoreJobs(['a', 'b', 'c']);
    expect(r.ok).toBe(true);
    expect(r.rescored).toBe(3);
    expect(r.claude_rescored).toBe(2);
    expect(r.regex_fallback).toBe(1);
    expect(stale).toHaveBeenCalledTimes(1);
    window.removeEventListener('linkedinjobs:corpus-stale', stale);
  });

  it('rescoreJobs short-circuits on empty ids with rescored=0', async () => {
    const { result } = renderHook(() => useCorpusActions());
    const r = await result.current.rescoreJobs([]);
    expect(r).toEqual({ ok: true, rescored: 0 });
  });

  it('pushToEndJobs forwards the `pushed` flag', async () => {
    let captured: Record<string, unknown> | null = null;
    server.use(
      http.post('*/api/corpus/push-to-end', async ({ request }) => {
        captured = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ok: true });
      }),
    );
    const { result } = renderHook(() => useCorpusActions());
    await result.current.pushToEndJobs(['a'], true);
    expect(captured).toEqual({ ids: ['a'], pushed: true });

    await result.current.pushToEndJobs(['b'], false);
    expect(captured).toEqual({ ids: ['b'], pushed: false });
  });

  it('pushToEndJobs short-circuits on empty ids', async () => {
    const { result } = renderHook(() => useCorpusActions());
    const r = await result.current.pushToEndJobs([], true);
    expect(r).toEqual({ ok: true });
  });
});

// ─────────────────────────────────────────────────────────────────────
// useAppStatus
// ─────────────────────────────────────────────────────────────────────
describe('useAppStatus', () => {
  it('setAppStatus omits `note` when undefined', async () => {
    let captured: Record<string, unknown> | null = null;
    server.use(
      http.post('*/api/corpus/app-status', async ({ request }) => {
        captured = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ok: true });
      }),
    );
    const { result } = renderHook(() => useAppStatus());
    await result.current.setAppStatus('job-1', 'applied');
    expect(captured).toEqual({ id: 'job-1', status: 'applied' });
    expect(captured).not.toHaveProperty('note');
  });

  it('setAppStatus forwards `note: null` to clear the field', async () => {
    let captured: Record<string, unknown> | null = null;
    server.use(
      http.post('*/api/corpus/app-status', async ({ request }) => {
        captured = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ok: true });
      }),
    );
    const { result } = renderHook(() => useAppStatus());
    await result.current.setAppStatus('job-1', 'applied', null);
    expect(captured).toEqual({ id: 'job-1', status: 'applied', note: null });
  });

  it('setAppStatus forwards a string note verbatim and fires stale event', async () => {
    let captured: Record<string, unknown> | null = null;
    server.use(
      http.post('*/api/corpus/app-status', async ({ request }) => {
        captured = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ok: true });
      }),
    );
    const stale = vi.fn();
    window.addEventListener('linkedinjobs:corpus-stale', stale);
    const { result } = renderHook(() => useAppStatus());
    await result.current.setAppStatus('job-1', 'screening', 'recruiter call');
    expect(captured).toEqual({
      id: 'job-1',
      status: 'screening',
      note: 'recruiter call',
    });
    expect(stale).toHaveBeenCalledTimes(1);
    window.removeEventListener('linkedinjobs:corpus-stale', stale);
  });

  it('bulkImportApplied returns the imported count on success', async () => {
    server.use(
      http.post('*/api/corpus/applied-bulk-import', () =>
        HttpResponse.json({ ok: true, imported: 7 }),
      ),
    );
    const { result } = renderHook(() => useAppStatus());
    const r = await result.current.bulkImportApplied(['a', 'b', 'c']);
    expect(r.ok).toBe(true);
    expect(r.imported).toBe(7);
  });

  it('bulkImportApplied surfaces server errors', async () => {
    server.use(
      http.post('*/api/corpus/applied-bulk-import', () =>
        HttpResponse.json({ ok: false, error: 'bad ids' }, { status: 400 }),
      ),
    );
    const { result } = renderHook(() => useAppStatus());
    const r = await result.current.bulkImportApplied(['x']);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('bad ids');
  });
});

// ─────────────────────────────────────────────────────────────────────
// useAddManual
// ─────────────────────────────────────────────────────────────────────
describe('useAddManual', () => {
  it('rejects empty / whitespace input without hitting the network', async () => {
    const { result } = renderHook(() => useAddManual());
    const r = await result.current.addManual('   ');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/paste a LinkedIn URL or job id/i);
  });

  it('returns ok=true + the parsed job on success', async () => {
    server.use(
      http.post('*/api/corpus/add-manual', () =>
        HttpResponse.json({
          ok: true,
          id: '4395123456',
          title: 'Senior PM',
          company: 'Acme',
          location: 'Tel Aviv',
          fit: 'good',
          score: 8,
          scored_by: 'claude',
          fit_reasons: ['matches stack'],
          source: 'manual',
          manual_added_at: '2026-05-01T12:00:00Z',
        }),
      ),
    );
    const stale = vi.fn();
    window.addEventListener('linkedinjobs:corpus-stale', stale);
    const { result } = renderHook(() => useAddManual());
    const r = await result.current.addManual('https://linkedin.com/jobs/view/4395123456/');
    expect(r.ok).toBe(true);
    expect(r.job?.id).toBe('4395123456');
    expect(r.job?.title).toBe('Senior PM');
    expect(r.job?.fit).toBe('good');
    expect(stale).toHaveBeenCalledTimes(1);
    window.removeEventListener('linkedinjobs:corpus-stale', stale);
  });

  it('flags 409 dup with alreadyInCorpus + existingId', async () => {
    server.use(
      http.post('*/api/corpus/add-manual', () =>
        HttpResponse.json(
          { ok: false, error: 'already in corpus', existing_id: 'old-1' },
          { status: 409 },
        ),
      ),
    );
    const { result } = renderHook(() => useAddManual());
    const r = await result.current.addManual('4395123456');
    expect(r.ok).toBe(false);
    expect(r.alreadyInCorpus).toBe(true);
    expect(r.existingId).toBe('old-1');
  });

  it('returns ok=false + error string on backend failure', async () => {
    server.use(
      http.post('*/api/corpus/add-manual', () =>
        HttpResponse.json({ ok: false, error: 'fetch failed' }, { status: 500 }),
      ),
    );
    const { result } = renderHook(() => useAddManual());
    const r = await result.current.addManual('4395123456');
    expect(r.ok).toBe(false);
    expect(r.alreadyInCorpus).toBeUndefined();
    expect(r.error).toBe('fetch failed');
  });

  it('does NOT fire corpus-stale on dup or error', async () => {
    server.use(
      http.post('*/api/corpus/add-manual', () =>
        HttpResponse.json({ ok: false, error: 'oops' }, { status: 500 }),
      ),
    );
    const stale = vi.fn();
    window.addEventListener('linkedinjobs:corpus-stale', stale);
    const { result } = renderHook(() => useAddManual());
    await result.current.addManual('4395123456');
    expect(stale).not.toHaveBeenCalled();
    window.removeEventListener('linkedinjobs:corpus-stale', stale);
  });

  it('returns ok=false + error from the catch block on network failure', async () => {
    server.use(
      http.post('*/api/corpus/add-manual', () =>
        HttpResponse.error(),
      ),
    );
    const { result } = renderHook(() => useAddManual());
    const r = await result.current.addManual('4395123456');
    expect(r.ok).toBe(false);
    expect(typeof r.error).toBe('string');
  });
});

// Light end-to-end-ish: `waitFor` import keeps the type lib loaded so the
// CI never accidentally drops it. (Trivial, but guards against an unused-
// import shake.)
describe('waitFor import sanity', () => {
  it('is a function', () => {
    expect(typeof waitFor).toBe('function');
  });
});
