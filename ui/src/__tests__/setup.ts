// Vitest setup file — runs once per test process before any test file.
//
// Loads jest-dom matchers (`toBeInTheDocument`, `toHaveClass`, etc.) so
// tests can `expect(el).toBeInTheDocument()` without per-file import
// boilerplate. Also wires the MSW server lifecycle if any test imports
// `./msw` and registers handlers — we keep MSW *opt-in per file* rather
// than starting it globally so tests that don't use HTTP stay fast.

import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// React Testing Library v16+ no longer auto-cleans between tests. We do it
// here so individual test files don't repeat the boilerplate; missing this
// causes leaked containers and "found multiple elements with the role" errors.
afterEach(() => {
  cleanup();
});
