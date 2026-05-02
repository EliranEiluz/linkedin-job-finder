// Shared MSW v2 server for tests that need HTTP mocking. Tests opt in by
// importing `server` from this module — the global setup file (setup.ts)
// stays free of MSW so test files that don't talk to /api/* keep their
// happy-dom startup snappy.
//
// IMPORTANT — environment caveat:
// happy-dom 15.x has a known interop bug with MSW v2 where any
// `Response#json()` call (and the underlying `Response#text()` call it
// delegates to) throws "Invalid state: ReadableStream is locked" once
// MSW has handed back the response. Bug threads:
//   https://github.com/capricorn86/happy-dom/issues/1180
//   https://github.com/vitest-dev/vitest/issues/4730
// jsdom is unaffected. Test files that drive code calling `res.json()`
// MUST opt-in to jsdom by adding `// @vitest-environment jsdom` to
// the very top of the file. Pure-DOM/component tests that don't talk
// HTTP can stay on the default happy-dom env (faster startup).
//
// Usage pattern:
//
//   // @vitest-environment jsdom
//   import { server } from './__tests__/msw';
//   import { http, HttpResponse } from 'msw';
//
//   beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
//   afterEach(() => server.resetHandlers());
//   afterAll(() => server.close());
//
// Per-test handler overrides go through `server.use(...)` and are reset
// between tests by `resetHandlers()`. Any request that misses every
// registered handler will fail loudly (`onUnhandledRequest: 'error'`),
// which keeps a test from accidentally hitting the live network.

import { setupServer } from 'msw/node';

export const server = setupServer();
