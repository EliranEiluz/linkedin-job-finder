// Build-time dumper: serialize ui/src/filterStateSchema.ts to
// shared/filterStateSchema.json so backend ctl scripts (Python) can
// consume the SAME schema without re-deriving it from Python types.
//
// Run via `npm run schema:dump` (added in package.json) — also wired
// into CI freshness check so a Zod edit without re-dumping fails the
// build (see backend/tests/test_filter_schema_dump_is_fresh.py).
//
// The output JSON has a metadata header so the Python freshness check
// can compare its embedded source-mtime against the live filterStateSchema.ts
// on disk; if the source is newer, CI fails with a clear "run npm run
// schema:dump" hint.

import { writeFileSync, statSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { FilterStateSchema } from '../src/filterStateSchema';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const SOURCE_PATH = resolve(HERE, '..', 'src', 'filterStateSchema.ts');
const OUT_PATH = resolve(REPO_ROOT, 'shared', 'filterStateSchema.json');

// `z.toJSONSchema` is Zod 4's built-in; emits Draft 2020-12. Setting
// $id makes the JSON Schema self-identifiable for tooling.
const jsonSchema = z.toJSONSchema(FilterStateSchema, {
  // `target: 'draft-2020-12'` is the Zod 4 default. Explicit so a
  // future change to the default doesn't quietly break the contract.
  target: 'draft-2020-12',
});

// Source-mtime is what the freshness check compares against. Use
// floor(seconds) to dodge sub-second drift between filesystems.
const sourceMtime = Math.floor(statSync(SOURCE_PATH).mtimeMs / 1000);

const payload = {
  // Metadata header — these underscored keys aren't part of the JSON
  // Schema spec but tooling that doesn't care about them ignores them.
  // Putting them in a sibling object would force the backend to read
  // two files; one file is simpler.
  _meta: {
    generated_by: 'ui/scripts/dumpFilterSchema.ts',
    source: 'ui/src/filterStateSchema.ts',
    source_mtime_unix: sourceMtime,
  },
  schema: jsonSchema,
};

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf-8');

console.log(`wrote ${OUT_PATH}`);
console.log(`  source: ui/src/filterStateSchema.ts (mtime=${String(sourceMtime)})`);
