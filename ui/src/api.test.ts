// @vitest-environment jsdom
//
// Behaviour tests for ui/src/api.ts.
//
// Pinned to jsdom because happy-dom 15 has a known stream-locking bug with
// MSW v2 — see ui/src/__tests__/msw.ts for the references. The override
// applies to this file only; everything else stays on happy-dom.
//
// `api.ts` is a 25-line wrapper around `fetch`, but it's the single entry
// point every callsite uses, so any regression here ripples everywhere
// (cache-busting param missing -> stale results.json reads, content-type
// header missing -> backend rejects POSTs as non-JSON, etc.). The tests
// drive both helpers through MSW v2 across the response-shape matrix the
// callers actually branch on:
//
//   - 2xx with parseable JSON   (success path)
//   - 4xx with a JSON envelope  (server validation; e.g. add-manual 409)
//   - 5xx with a JSON envelope  (corpus_ctl crash; surfaced via .error)
//   - 2xx with non-JSON body    (caller's `await res.json()` should throw)
//   - network failure           (fetch rejects; caller wraps in try/catch)
//
// Plus: fetchJsonNoCache must append a `?t=<digits>` cache-buster so the
// dev middleware doesn't serve a stale results.json from the OS-level
// HTTP cache. We pin Date.now via vi.setSystemTime so the asserted query
// string is deterministic.

import { describe, it, expect, beforeAll, afterEach, afterAll, beforeEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './__tests__/msw';
import { fetchJsonNoCache, postJson } from './api';

beforeAll(() => { server.listen({ onUnhandledRequest: 'error' }); });
afterEach(() => { server.resetHandlers(); });
afterAll(() => { server.close(); });

describe('api.ts — fetchJsonNoCache', () => {
  beforeEach(() => {
    // Pin the clock so the cache-buster is reproducible. Restored after
    // each test by useFakeTimers' default lifecycle in vitest 3.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-01T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('appends a `?t=<ms>` cache-busting query string', async () => {
    let capturedUrl: string | null = null;
    server.use(
      http.get('http://localhost/results.json', ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json([]);
      }),
    );

    const res = await fetchJsonNoCache('http://localhost/results.json');

    expect(res.status).toBe(200);
    expect(capturedUrl).not.toBeNull();
    // The exact ms value is whatever Date.now() returns at the pinned
    // system time. We just assert the param exists and is a digit string —
    // the contract is "defeats the OS HTTP cache," not "is exactly N."
    expect(capturedUrl).toMatch(/\?t=\d+$/);
  });

  it('returns a 200 + parsed JSON body on success', async () => {
    server.use(
      http.get('http://localhost/results.json', () =>
        HttpResponse.json([{ id: 'abc', title: 'PM' }]),
      ),
    );
    const res = await fetchJsonNoCache('http://localhost/results.json');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; title: string }[];
    expect(body).toEqual([{ id: 'abc', title: 'PM' }]);
  });

  it('returns 404 verbatim — caller branches on res.status', async () => {
    server.use(
      http.get('http://localhost/missing.json', () =>
        HttpResponse.json({ error: 'not found' }, { status: 404 }),
      ),
    );
    const res = await fetchJsonNoCache('http://localhost/missing.json');
    expect(res.ok).toBe(false);
    expect(res.status).toBe(404);
  });

  it('returns 500 verbatim — caller decides retry/log policy', async () => {
    server.use(
      http.get('http://localhost/results.json', () =>
        HttpResponse.json({ error: 'boom' }, { status: 500 }),
      ),
    );
    const res = await fetchJsonNoCache('http://localhost/results.json');
    expect(res.status).toBe(500);
  });

  it('throws on json() when the body is not valid JSON', async () => {
    server.use(
      http.get('http://localhost/results.json', () =>
        HttpResponse.text('<html>oops</html>', { status: 200 }),
      ),
    );
    const res = await fetchJsonNoCache('http://localhost/results.json');
    expect(res.status).toBe(200);
    await expect(res.json()).rejects.toThrow();
  });

  it('rejects when the network errors out', async () => {
    server.use(
      http.get('http://localhost/results.json', () => HttpResponse.error()),
    );
    await expect(
      fetchJsonNoCache('http://localhost/results.json'),
    ).rejects.toThrow();
  });
});

describe('api.ts — postJson', () => {
  it('sends Content-Type: application/json and a stringified body', async () => {
    let captured: { contentType: string | null; body: unknown } | null = null;
    server.use(
      http.post('http://localhost/api/corpus/rate', async ({ request }) => {
        captured = {
          contentType: request.headers.get('content-type'),
          body: await request.json(),
        };
        return HttpResponse.json({ ok: true });
      }),
    );

    const res = await postJson('http://localhost/api/corpus/rate', {
      id: 'job-1',
      rating: 5,
    });

    expect(res.status).toBe(200);
    expect(captured).not.toBeNull();
    const c = captured as { contentType: string | null; body: unknown };
    expect(c.contentType).toMatch(/application\/json/);
    expect(c.body).toEqual({ id: 'job-1', rating: 5 });
  });

  it('returns 4xx (e.g. 409 dup) with body intact for callers to branch on', async () => {
    server.use(
      http.post('http://localhost/api/corpus/add-manual', () =>
        HttpResponse.json(
          { ok: false, error: 'already in corpus', existing_id: 'job-2' },
          { status: 409 },
        ),
      ),
    );
    const res = await postJson('http://localhost/api/corpus/add-manual', {
      url_or_id: '4395123456',
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      ok?: boolean; error?: string; existing_id?: string;
    };
    expect(body.ok).toBe(false);
    expect(body.existing_id).toBe('job-2');
  });

  it('returns 5xx with body intact (corpus_ctl spawn failure)', async () => {
    server.use(
      http.post('http://localhost/api/corpus/rescore', () =>
        HttpResponse.json({ ok: false, error: 'spawn failed' }, { status: 500 }),
      ),
    );
    const res = await postJson('http://localhost/api/corpus/rescore', {
      ids: ['job-1'],
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok?: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('spawn failed');
  });

  it('returns Response intact when body is not JSON — json() throws downstream', async () => {
    server.use(
      http.post('http://localhost/api/corpus/rate', () =>
        HttpResponse.text('not-json', { status: 200 }),
      ),
    );
    const res = await postJson('http://localhost/api/corpus/rate', { id: 'x' });
    expect(res.status).toBe(200);
    await expect(res.json()).rejects.toThrow();
  });

  it('rejects when the network errors out', async () => {
    server.use(
      http.post('http://localhost/api/corpus/rate', () => HttpResponse.error()),
    );
    await expect(
      postJson('http://localhost/api/corpus/rate', { id: 'job-1' }),
    ).rejects.toThrow();
  });

  it('serializes nested objects/arrays correctly', async () => {
    let captured: unknown = null;
    server.use(
      http.post('http://localhost/api/corpus/rescore', async ({ request }) => {
        captured = await request.json();
        return HttpResponse.json({ ok: true });
      }),
    );
    await postJson('http://localhost/api/corpus/rescore', {
      ids: ['a', 'b'],
      meta: { reason: 'manual', count: 2 },
    });
    expect(captured).toEqual({
      ids: ['a', 'b'],
      meta: { reason: 'manual', count: 2 },
    });
  });
});
