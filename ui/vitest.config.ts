// Vitest config kept separate from vite.config.ts because the latter
// instantiates a heavy dev-only Vite middleware that spawns Python ctl
// scripts on import — tests don't need that, and pulling it in would
// burn ~3 seconds per test-process startup. Vitest v3 picks this file up
// automatically (`vitest.config.{js,ts}` takes precedence over the named
// `test:` block in vite.config.ts when both are present).

import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    // happy-dom is ~3x faster than jsdom for the React Testing Library
    // workloads we have, and parity is good enough for our single-page
    // surface (no iframes, no heavy form APIs). Documented gotcha: a few
    // CSS-in-JS layouts can show different computed styles, but we don't
    // assert layout in tests — we assert behavior.
    environment: 'happy-dom',
    globals: false, // explicit `import { describe, it, expect } from 'vitest'`
    // Co-located *.test.ts(x) files. The `__tests__` style is also picked up
    // by the default include pattern; we keep both options open per file.
    include: ['src/**/*.test.{ts,tsx}', 'middleware/**/*.test.ts'],
    setupFiles: ['./src/__tests__/setup.ts'],
    // Coverage uses v8 (faster, no instrumentation pass).
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.{ts,tsx}', 'middleware/**/*.ts'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/__tests__/**',
        'src/main.tsx', // entry; mounts <App />, no logic to test
      ],
    },
  },
});
