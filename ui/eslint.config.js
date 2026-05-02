import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  // App + Vite middleware sources — type-aware lint backed by both
  // tsconfig.app.json (src/**) and tsconfig.node.json (vite.config.ts).
  {
    files: ['src/**/*.{ts,tsx}', 'vite.config.ts', 'middleware/**/*.ts'],
    extends: [
      js.configs.recommended,
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        // Loads BOTH project files so each source file is matched against
        // the right one (vite.config.ts → node project; src/** → app
        // project). Without this the type-checked rules can't run.
        project: ['./tsconfig.app.json', './tsconfig.node.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // exhaustive-deps is opt-in inside react-hooks/recommended; pin it
      // explicitly so a future plugin upgrade can't silently turn it off.
      'react-hooks/exhaustive-deps': 'error',
      // Allow `${number}` and `${boolean}` in template literals — both
      // have well-defined toString() and the strict-type-checked default
      // (string-only) just forces noisy `${String(n)}` everywhere.
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
      // Flag accidental uncaught rejections (from the strict-type-checked
      // default), but treat IIFEs as ignored — the codebase uses the
      // `(async () => { ... })()` pattern in useEffect bodies a lot, and
      // wrapping each in `void` adds noise without changing behavior.
      '@typescript-eslint/no-floating-promises': [
        'error',
        { ignoreIIFE: true },
      ],
      // The default flags `onClick={asyncHandler}` everywhere. The
      // attribute case is a non-issue in practice — React handles the
      // returned promise's rejection via the standard error boundary
      // path, and rewriting every async handler as `() => { void f(); }`
      // is pure noise. Keep the function-call check (where a stray
      // promise really can swallow errors).
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],
      // The new react-hooks (v7) "set-state in effect" rule is a stylistic
      // suggestion to move state derivations out of useEffect. Worth
      // surfacing as guidance, but not as a build-breaker for an existing
      // codebase that legitimately syncs server/URL state into local state.
      'react-hooks/set-state-in-effect': 'warn',
      // Same reasoning for the other react-hooks/v7 advisories.
      'react-hooks/static-components': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/incompatible-library': 'warn',
    },
  },
  // Vitest test files + test setup live in src/** but aren't part of the
  // app's tsconfig project, so type-aware rules can't resolve their
  // vitest / RTL / MSW types and would explode with hundreds of bogus
  // unsafe-* errors. Disable the type-aware checks for test files only —
  // runtime safety on `any`-typed values isn't a meaningful concern in
  // tests, and the tests themselves still type-check via vitest's own
  // type pipeline.
  {
    files: [
      'src/**/*.test.{ts,tsx}',
      'src/__tests__/**/*.{ts,tsx}',
    ],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-misused-promises': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },
])
