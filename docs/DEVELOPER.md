# Developer guide

How to add things. Read [ARCHITECTURE.md](./ARCHITECTURE.md) first —
this guide assumes you know what a ctl script is, how the LLM
abstraction resolves, and where state lives on disk.

## Local dev setup

`CONTRIBUTING.md` has the canonical setup snippet. The short version:

```bash
python3 -m pip install -r backend/requirements.txt
python3 -m playwright install chromium    # only for --mode=loggedin
cd ui && npm install && cd ..
```

Then walk the wizard once at <http://localhost:5173> so you have a
populated profile and the corpus tabs unlock.

The full test commands you will run while iterating:

```bash
python3 -m pytest backend/tests/test_*.py --ignore=backend/tests/phase_d_test.py
cd ui && npx vitest run
cd ui && npm run build
```

`phase_d_test.py` is a script-style legacy harness that calls
`sys.exit` at module level — it is not pytest-collectable. CI excludes
it explicitly so a future glob-based discovery change cannot quietly
pull it in.

## The ctl JSON-CLI convention

Every script under `backend/ctl/` exposes the same contract to the
Vite middleware:

- Read JSON from stdin (or accept no stdin for read-only commands).
- Emit a single JSON envelope on stdout.
- Exit `0` on success, `1` on validation or IO error.

The shared helpers live in `backend/ctl/_common.py`:

- `read_stdin_json(allow_empty=False)` — parse the stdin payload, raise
  `ValueError` on empty input (or return `{}` if `allow_empty=True`),
  raise `TypeError` if the parsed payload is not a JSON object.
- `emit(obj, code=0)` — print `obj` as one indented JSON document then
  call `sys.exit(code)`. Always exactly one envelope, no logging
  before or after — the middleware does `JSON.parse(stdout)` and any
  stray print breaks it.
- `atomic_write_text` / `atomic_write_json` — temp-file + rename
  writes for crash safety.
- `atomic_write_env_var` — update or append a `KEY=value` line in a
  dotenv-style file, atomic, chmod 0o600. Used by both `llm_ctl` (LLM
  API keys) and `notifications_ctl` (SMTP creds, Telegram tokens) so
  the env-write logic lives in exactly one place.
- `load_env_file` — read `KEY=value` lines into `os.environ` (no
  override). Lets a save-credential + test pair in the same wizard
  step actually see the new key without a process restart.

Envelope shape:

- success — `{"ok": true, "...": "..."}` plus per-command fields.
- error — `{"ok": false, "error": "..."}`, exit 1. The middleware
  surfaces `error` verbatim to the UI, so write it as a one-line user-
  facing message ("ids must be a non-empty array of strings"), not a
  Python traceback.

`corpus_ctl.py` has an extra wrinkle: `search.py` prints status to
stdout when its scoring pipeline runs ("Scoring batch 1/3...",
"↳ guest classification: real=..."). Inside ctl scripts that's a
problem — the middleware reserves stdout for the JSON envelope. The
fix is the `_silence_stdout()` context manager in `corpus_ctl.py`:

```python
with _silence_stdout():
    search.score_jobs_in_batches(to_score, cv_text)
```

It redirects `sys.stdout` to `sys.stderr` for the duration of the
block. Anything search.py prints lands in the spawn log (still visible
to the user via the run-status panel) instead of corrupting the
envelope. Use it whenever a ctl command calls into a `search.*` heavy
pipeline.

## Adding a new LLM provider

Step by step. Pretend you are adding "FooLLM."

1. **Create `backend/llm/foo.py`.** Subclass `LLMProvider` from
   `backend/llm/base.py`. Implement `score_batch`, `complete`, `test`.
   Mirror `claude_sdk.py` for the simplest reference shape — it is
   roughly 100 lines, no inheritance tricks, uses
   `_shared.parse_json_response` to handle ` ```json ` fences.

   ```python
   class FooProvider(LLMProvider):
       name = "foo"

       def __init__(self, model: str | None = None) -> None:
           self.model = model or "foo-default"

       def score_batch(self, cv_text: str, batch: list[dict]) -> list | None:
           ...
       def complete(self, prompt: str, *, system=None, max_tokens=4096,
                    json_mode=False) -> str | None:
           ...
       def test(self) -> tuple[bool, str]:
           ...
   ```

2. **Register in `backend/llm/__init__.py`.** Add to the `PROVIDERS`
   dict and to `AUTO_ORDER` if it makes sense as an auto-resolve
   default. Add a quick-availability branch to `_quick_available()` —
   typically an env-var check or a binary on `PATH`.

3. **Add metadata in `backend/ctl/llm_ctl.py:PROVIDER_META`.** This
   drives the wizard's picker grid (label, env var name, free-tier
   flag, blurb, help URL). Order matters — it is the left-to-right
   card order in the UI. Provider name only in the blurb, no model
   versions.

4. **Add to the UI union.** `ui/src/configTypes.ts:LLMProviderName`
   and `ui/src/configMigrate.ts:VALID_PROVIDER_NAMES` both list every
   accepted provider — the wizard's picker rejects anything not in
   both. Same with `backend/search.py:_VALID_LLM_PROVIDER_NAMES` (the
   server-side validator inside `_normalize_llm_provider`).

5. **Tests.** `backend/tests/test_llm.py` has the existing happy-path
   plus malformed-response coverage; add equivalent cases for the new
   provider. At a minimum: one `score_batch` happy path, one
   malformed-JSON path that exercises `parse_json_response`, and one
   `test()` assertion that verifies the round-trip succeeds when the
   env var is set.

## Adding a new ctl command

Walking through "add a new subcommand `foo` to `corpus_ctl.py` that
takes `{job_id, value}` on stdin and returns `{ok, applied}`."

1. **Define the handler.** Inside `corpus_ctl.py`, add a
   `cmd_foo(args)` function. Use `_read_stdin_json()` and `_emit()`
   like every other handler. Validate types up front and `_emit({"ok":
   false, "error": "..."}, 1)` on bad input — the middleware maps
   exit 1 to a 4xx response.

2. **Wire up argparse.** In `main()`, add
   `sub.add_parser("foo").set_defaults(func=cmd_foo)`. The parser
   chooses the handler purely by subcommand name; no extra plumbing.

3. **Add a Vite middleware endpoint.** In `ui/vite.config.ts`, find
   the corpus block (other handlers all start with
   `if (url.startsWith('/api/corpus/...'))`) and add a sibling
   handler. Pattern:

   ```ts
   if (url.startsWith('/api/corpus/foo') && req.method === 'POST') {
     const raw = await readJsonBody(req);
     // validate body shape …
     const result = await runCtl(
       CORPUS_CTL, ['foo'], JSON.stringify(body), CORPUS_TIMEOUT_MS,
     );
     // map result → sendJson(res, statusCode, parsed)
     return;
   }
   ```

   The status-code shaping (200/400/409/500/504) lives in the
   handler — `runCtl` only runs the subprocess and surfaces
   `{exitCode, stdout, stderr, timedOut, spawnError}`. If the new
   route shape will be reused by multiple handlers, factor a helper
   into `ui/middleware/runCtl.ts` rather than copy-pasting.

4. **UI client.** Add a function to `ui/src/api.ts` that posts to the
   endpoint. The page component imports the function. Keep payload
   shapes in `ui/src/types.ts` if they are more than three fields.

5. **Tests.** `backend/tests/test_ctl_corpus.py` is the model for
   command-level coverage. The `run_ctl` fixture (from
   `backend/tests/conftest.py`) drives the script as a subprocess
   with a stdin payload and returns `(exit_code, stdout_dict,
   stderr_text)`. Assert on the parsed stdout JSON.

## Adding a Vite middleware endpoint

The shape is always the same:

```ts
if (url.startsWith('/api/<area>/<verb>') && req.method === 'POST') {
  const raw = await readJsonBody(req);
  let body: { ... };
  try { body = JSON.parse(raw) as typeof body; }
  catch { sendJson(res, 400, { ok: false, error: 'invalid JSON body' }); return; }
  // shape validation — keep it minimal; the python ctl is the source of truth
  const result = await runCtl(<CTL_PATH>, [<args>], JSON.stringify(body), <TIMEOUT>);
  if (result.spawnError) { sendJson(res, 500, { ok: false, error: result.spawnError }); return; }
  if (result.timedOut)   { sendJson(res, 504, { ok: false, error: '<ctl> timed out' }); return; }
  try {
    const parsed = JSON.parse(result.stdout) as { ok?: boolean };
    sendJson(res, parsed.ok ? 200 : 400, parsed); return;
  } catch {
    sendJson(res, 500, {
      ok: false, error: '<ctl> emitted non-JSON',
      raw_stderr: result.stderr.slice(0, 500),
    }); return;
  }
}
```

Centralized constants are in `ui/middleware/paths.ts` — one timeout
per ctl, one path per ctl. Edit there, not in the handler.

The non-negotiable rule for credential routes:

> SENSITIVE-body endpoints NEVER log the request body.

Comment them with `*** SENSITIVE ***` so a future code reader has zero
ambiguity. Concretely: `/api/llm/save-credential`,
`/api/notifications/save-smtp`, and `/api/notifications/save-telegram`
all carry secrets in the body. The Python ctl scripts share the same
discipline — error messages reference env-var names, not values.

## Adding a wizard step

The wizard is a step machine in `ui/src/OnboardingPage.tsx`. Steps are
discrete `Step0Preflight` … `Step7WhatsNext` components under
`ui/src/onboarding/steps/`.

1. **Define the step type.** In `ui/src/onboarding/types.ts`, extend
   the `Step` union if you are inserting a new step number. Existing
   layout is `0..8` (nine steps) because Step 6 (Notifications) was
   inserted between Intent (5) and Generate (was 6, now 7). The
   internal file names of Step6Generate and Step7WhatsNext were kept
   rather than renamed for diff hygiene.

2. **Add the component.** New file under
   `ui/src/onboarding/steps/StepN<Name>.tsx`. Take `onAdvance` and
   any draft-state props you need. Read draft fields off
   `WizardDraft` if your step writes to it.

3. **Wire it into `OnboardingPage.tsx`.** Add an import, then a
   `{step === N && <StepN ... />}` branch inside the page's render.

4. **Update the stepper.** `ui/src/onboarding/components.tsx` has the
   `Stepper` that renders the dot row at the top. Add the new step's
   label there.

5. **Tests.** Wizard steps are integration-tested via the
   OnboardingPage tests under `ui/src/__tests__/`. MSW v2 mocks the
   `/api/*` endpoints; React Testing Library + user-event drives the
   UI.

## Adding a corpus filter

`ui/src/filters.ts` is the single home for filter state and filter
logic. The contract: filter state is the URL — `fromSearchParams` and
`toSearchParams` round-trip it, and the page re-derives state from
the URL on every render.

1. **Extend `FilterState`.** Add the new field with a sensible empty
   value.

2. **Update `defaultFilters()`.** The empty/default state for the
   field. The convention is "empty Set = match all" for enum filters
   so new user-defined values surface automatically without reticking.

3. **Update `applyFilters()`.** Add the matching branch. Enum filters
   bail early on `f.<field>.size > 0 && !f.<field>.has(...)`; range
   filters check both ends. Unscored / null jobs need an explicit
   pass condition (see how `score` handles `null`).

4. **Update URL serialization.** `toSearchParams` writes the param
   only when the value differs from the default — keeps the URL clean
   when no filter is active. `fromSearchParams` parses the param back,
   defaulting if the param is absent. Use `parseCsv` for fixed
   allowlists (typed enums), `parseStringSet` for user-defined ids
   like category ids.

5. **Add to `FilterPanel.tsx`.** New checkbox section / range slider
   / etc. The panel reads from URL-derived state and writes through
   the page's setter, never a local copy — that is what keeps the
   round-trip clean.

6. **Update `isDefault()`.** Add the new field's equality check so the
   "filters active" badge clears correctly when the field is back to
   its default.

7. **Tests.** `ui/src/filters.test.ts` covers the matrix; add a case
   per branch (matching, non-matching, default, URL round-trip).

## Test conventions

- **Pytest.** `backend/tests/test_*.py` only — `phase_d_test.py` is
  excluded explicitly (legacy script-style harness). Use `parametrize`
  for input matrices, fixtures for shared state. Two fixtures from
  `backend/tests/conftest.py` are non-negotiable:
  - `tmp_repo` — patches `search.RESULTS_FILE`, `SEEN_FILE`,
    `RUN_HISTORY_FILE`, `CONFIG_FILE`, `CV_FILE`, etc. to live under
    a per-test `tmp_path`. Tests MUST use it instead of touching the
    real corpus.
  - `run_ctl` — drives a ctl script as a subprocess with a stdin
    payload, returns `(returncode, stdout_obj, stderr_text)`. The
    stdout is auto-`json.loads`-ed on success. The fixture
    materializes a fake repo layout under `tmp_path` so the ctl
    script's `ROOT = Path(__file__).resolve().parent.parent.parent`
    resolves to the sandbox.
- **Vitest.** UI tests live under `ui/src/__tests__/` (for component
  tests) and as `*.test.ts` siblings (for pure-logic modules like
  `filters.test.ts`). Stack: MSW v2 for HTTP mocking, React Testing
  Library for rendering, `@testing-library/user-event` for input.
  Use `vi.useFakeTimers()` / `vi.advanceTimersByTime` for any test
  asserting on debounce, polling intervals, or `setTimeout` paths —
  do not `await new Promise(setTimeout, ...)`.
- **No real network, no real corpus.** UI tests intercept fetches
  with MSW; backend tests redirect every state-file path through
  `tmp_repo`; ctl-level tests use the `run_ctl` fixture which spawns
  into a fake-repo `tmp_path`. A test that opens
  `/Users/.../results.json` is a bug.

## Pre-commit + CI gates

Local pre-commit (`.pre-commit-config.yaml`):

- `ruff check` — Python lint.
- `ruff format` — Python formatting.
- Trailing whitespace + EOF newlines.
- Commit-msg gate that rejects any `Co-Authored-By: Claude` trailer.

Install once with `pre-commit install` and `pre-commit install
--hook-type commit-msg`. Slower checks (`mypy`, `tsc`, `vitest`,
`build`) live in CI to keep commit feedback snappy.

CI (`.github/workflows/ci.yml`) runs on every push to `main` and on
every PR targeting `main`:

- **backend job** — `ruff check`, `ruff format --check`, `mypy
  backend/`, `pytest backend/tests/test_*.py
  --ignore=backend/tests/phase_d_test.py`.
- **ui job** — `tsc --noEmit`, `eslint .`, `vitest run`, `npm run
  build`.

ESLint is invoked without `--max-warnings`, so warnings stay visible
in the log but do not gate. The intent is documented in
`ui/eslint.config.js` per rule. Errors do gate.

A second push to the same ref cancels the previous in-flight run via
the `concurrency` block — saves minutes during rebase-and-force-push
PR iteration.

## Schema migrations (`configMigrate.ts` pattern)

The config schema has changed once (the 2026-04 categorisation
refactor: legacy `search_queries` / `security_researcher_queries` /
`company_queries` arrays became a single `categories[]` with per-
category `type: keyword|company`). Two normalizers live in the codebase
and run on every read:

- `ui/src/configMigrate.ts:normalizeConfig(raw)` is the single
  client-side normalizer. It accepts both shapes, prefers the new one
  if present and well-formed, otherwise synthesizes new-shape
  categories from the legacy fields. Defensive throughout — any input
  that is partially malformed is patched with sensible defaults
  rather than thrown. Returns a fully-typed `CrawlerConfig`.
- `backend/search.py:load_config()` does the same on the Python side
  via `_migrate_legacy_config` plus `_normalize_categories`. Same
  policy: new schema wins, legacy is migrated transparently, malformed
  fields fall back to hardcoded defaults. A malformed config NEVER
  stops the scraper from running.

`serializeConfig` (the inverse of `normalizeConfig`) only writes the
new shape — the Python side accepts new-only on write, with the
legacy migration path used only on read. New shape changes go through
both normalizers in lockstep:

1. Add the field to `CrawlerConfig` in `ui/src/configTypes.ts`.
2. Read + validate it in `normalizeConfig`. Default to a
   non-truthy value if missing.
3. Round-trip it in `serializeConfig` — only emit if the user set a
   non-default value, to keep on-disk configs clean.
4. Read + validate it in `search.load_config()` and update
   `_hardcoded_defaults()` so the matching key exists in
   `defaults.json`.
5. Add a `configMigrate.test.ts` case asserting the round-trip is
   lossless on legacy + new + partially-malformed inputs.

The same pattern would handle a future v3 schema. The principle is
that one writer (the new normalizer) emits canonical output and one
reader (the same normalizer) accepts every prior shape. No conditional
"v1-only" code paths anywhere downstream.
