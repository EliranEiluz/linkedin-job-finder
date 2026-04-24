# Code Review — 2026-04-23

## TL;DR (5 sentences max)

Pipeline is healthy: guest API and JYMBII/banner classifier both still work as
designed in April 2026, and pagination genuinely advances (start=0/25/50/75 → 7/8/10/8 unique IDs
on `cryptography engineer`/Israel). `geo_id` is a **strict** filter — Israel
returned 0 of 9 jobs that no-geo returned, and a bogus geoId silently falls
back to worldwide (no 400). `priority_companies` is mostly **cosmetic**:
nothing in the Claude scoring prompt, regex fallback, or off-topic title filter
weights it — only the email digest section header, the UI red border, the
result printer, and a *negative* effect (priority companies are exempted from
the title pre-filter). The three highest-ROI fixes: (1) feed `priority` into
Claude scoring so the field actually pulls weight; (2) fix the URL→category
parser in `filters.ts` (it silently drops user-defined category ids on every
refresh); (3) virtualize `JobsTable` rows with the already-installed TanStack
Virtual since the corpus is set to keep growing.

## 1. Scraping Pipeline Audit

### Live evidence — guest search endpoint

`/jobs-guest/jobs/api/seeMoreJobPostings/search` is alive and paginating
correctly. Probe: `python3 probe_guest_api.py "cryptography engineer" --pages 4`

| Page | start | HTTP | Cards parsed | New |
|------|-------|------|--------------|-----|
| 1 | 0 | 200 | 7 | 7 |
| 2 | 25 | 200 | 8 | 8 |
| 3 | 50 | 200 | 10 | 10 |
| 4 | 75 | 200 | 8 | 8 |

33 unique IDs across 4 pages — no window-repeat regression. Card markup still
matches the BeautifulSoup selectors (`.base-search-card__title`, `.base-search-card__subtitle`,
`.job-search-card__location`). No shape drift.

### Live evidence — guest description endpoint

`probe_guest_detail.py 4345904922` (Dream / Senior Threat Intel Researcher):
strategy 1 (`jobposting_endpoint`) returned HTTP 200, 63,736 bytes, desc_len=3,298.
Strategy 2 (`public_view_html`) returned identical 3,298 chars. Strategy 3
(JSON-LD) returned **"no JSON-LD JobPosting block found"** — LinkedIn has dropped
the JSON-LD embed from the public job page. `search.py:1764 _try_jsonld_description`
is the loggedin path's last-resort fallback when CSS selectors fail and will
now silently return "". Not urgent (CSS selectors still work) but flag it.

### URL params honored?

`probe_geo_compare.py "cryptography engineer"` exercises each:

| Variant | Cards | Top locations |
|---------|-------|---------------|
| no geoId, no f_TPR | 9 | NY:3, US:2, CO/MN/CA/SF/etc |
| `geoId=92000000` (Worldwide) | 10 | Munich, Luxembourg, NY, Bengaluru… |
| `geoId=101620260` (Israel) | 7 | Tel Aviv:5, Ramat Gan:1, Netanya:1 |
| Israel + `location=Tel Aviv` | 8 | identical Tel Aviv set + Herzliya |
| Israel + `f_TPR=r604800` | 10 | Tel Aviv:4, Israel:2, Netanya, Yokneam… |
| Israel + `f_TPR=r86400` | 10 | Tel Aviv:3, Raanana:2, Israel:1, Ashdod… |

All three URL params (`f_TPR`, `geoId`, `keywords`) are still honored. Bogus
geoId test (`geoId=999999999`) returned **HTTP 200 with worldwide-style results**
— LinkedIn does NOT 400 on invalid geo, it silently falls back to a global
pool. This means a typo in config would silently widen the funnel.

### Loggedin path

Run-history shows 2-9 new jobs per run from 22 queries this week. Most
multi-word keyword queries (`cryptography engineer`, `applied cryptography`,
`zero knowledge engineer`, `MPC engineer`, `confidential computing`,
`vulnerability researcher`, `detection engineer`) hit the JYMBII banner with
`jymbii=7, real=0`. Expected for a tightly-scoped ZK/MPC-Israel corpus —
hits come from the company queries, not keywords. First run on 04-22 has
`descriptions_failed=11`; later runs are clean (the new 429-retry logic at
search.py:1066 was added 04-23).

### Rate-limiting & JYMBII detection

`fetch_description_guest` (search.py:1066) handles 429 well: reads `Retry-After`,
exponential backoff 30s/60s (capped 120s), distinguishes `rate-limited` from
`error`. JYMBII classifier (`EBP_JYMBII`, `EBP_REAL` at search.py:1216-1217)
still matches LinkedIn's current eBP values; per-query stats consistently show
`jymbii=7` for the no-result queries. Guest mode adds `_card_matches_tokens`
token relevance as a second-line check — sound belt-and-suspenders.

### Regressions / concerns

- `_try_jsonld_description` (search.py:1764) — JSON-LD block gone from public
  job pages; silent empty-string return path.
- Bogus geoId silently widens funnel (see §2) — no validation on save.
- `_card_matches_tokens` "drop trailing y/er" stem (search.py:1292) is cute
  but brittle (`security`→`securit` could over-match). Worth a unit test.

## 2. geoId Effect Study

`probe_geo_compare.py "cryptography engineer"` ran each variant for the same
query, page 1. Page-1 ID overlap matrix:

| | NoGeo | World | Israel |
|---|---|---|---|
| **NoGeo (9 cards)** | — | 2/9 | **0/9** |
| **Worldwide 92000000 (10 cards)** | 2/9 | — | 0/10 |
| **Israel 101620260 (7 cards)** | 0/9 | 0/10 | — |

| Pair | Overlap | Interpretation |
|------|---------|----------------|
| Israel vs Israel + `location=Tel Aviv` | 7/7 | redundant — `location` adds nothing when `geoId` is set |
| Israel vs Israel + `f_TPR=r604800` (7d) | 2/7 | strong filter effect — most "any time" hits are stale |
| Israel + 7d vs Israel + 1d | 3/10 | 1d strict subset (mostly) |

### Findings

1. **`geoId` is strict, not boost-style.** Israel (101620260) returned 0 of 9
   no-geoId results — the cards are entirely disjoint sets, not "boosted but
   includes" overlap. The personalized search hides everything outside the
   geo. This is what we want for an Israel-based scraper, but it means
   "Worldwide" mode is a real switch, not a wider cone.

2. **Bogus geoId → silent worldwide fallback.** No HTTP 400. A user typing
   "10620260" instead of "101620260" would get a flood of irrelevant US/EU
   jobs and never know why the corpus exploded. **Recommendation:** add a
   numeric-ish-and-known-prefix sanity check on save in
   `onboarding_ctl._validate_and_shape` and `configMigrate.parseConfig`.

3. **`location=` is mostly redundant when `geoId` is set.** Israel + `location=Tel
   Aviv` gave 7 of 7 same IDs as Israel alone (8 cards vs 7 — one extra
   Herzliya hit). It's not strictly additive; in practice it's noise. The UI
   already labels it "rarely used" (ConfigPage.tsx:343) — accurate.

4. **Worldwide (92000000) ≠ omitting geoId.** Only 2/9 overlap. Worldwide
   geoId returns a different set than no-geoId. Best guess: no-geoId means
   "use session/IP geo" (US for the unauth session running this probe), and
   92000000 is the explicit "worldwide pool" facet. If you want truly
   maximum reach, **leave geoId empty** in guest mode — but then you're
   tied to whatever IP you're running from. The scraper hardcodes
   `GUEST_GEO_DEFAULT = "101620260"` which is the right call for the user.

5. **Same behavior in guest vs loggedin.** Both URL surfaces accept the same
   `geoId` param. The loggedin SPA additionally home-filters to the account's
   registered location even when `geoId` is empty (the `GEO_ID = ""` comment
   at search.py:140 documents this). Verified by inspecting the code path.

## 3. priority_companies Utility

### Touch-point map

| File:line | Effect |
|-----------|--------|
| `search.py:163-224` | hardcoded default set |
| `search.py:752` | `PRIORITY_COMPANIES = {p.lower() for p in merged["priority_companies"]}` after config load |
| `search.py:945`, `1516` | sets `job["priority"] = any(p in company.lower() for p in PRIORITY_COMPANIES)` on guest + loggedin scrape |
| `search.py:1903` | **exempts priority jobs from `is_obviously_offtopic` title pre-filter** — ONLY hard scraping effect |
| `search.py:1856`, `2231`, `2251-2260` | sort priority first in CLI output |
| `send_email.py:148-149` | red "🔥 PRIORITY" chip on each card |
| `send_email.py:178-179` | red 2px border on priority cards (1px otherwise) |
| `send_email.py:239-263` | dedicated "🔥 Priority companies" section ABOVE good/ok |
| `send_email.py:348-353` | priority count goes into the email subject line |
| `ui/JobsTable.tsx:113-118` | `!` column with 🔥 icon, sortable |
| `ui/JobsTable.tsx:91-96, 358, 373` | initial sort key (after applied), red left border on priority rows |
| `ui/StatsBar.tsx:60, 84-88` | priority count chip |
| `ui/FilterPanel.tsx:225-226` | tri-toggle filter (all/yes/no) |
| `ui/ConfigPage.tsx:441-460` | giant comma-separated textarea editor |

### Does Claude actually weight `priority`?

**No.** `_build_batch_prompt` (search.py:387-401) constructs the JSON payload
from id/title/company/location/description only. The `priority` field is NOT
included. The prompt template (search.py:278-317) makes no mention of priority
or pre-flagged companies. So `priority_companies` does NOT influence the model's
fit/score output at all.

### Auto-generated during onboarding?

Yes — `onboarding_ctl.py:117, 137-139` (META_PROMPT_TEMPLATE) explicitly
asks Claude for "priority_companies: 15-30 lowercased names. Derive from CV +
intent paragraph". The validator at `onboarding_ctl.py:299-306` lowercases,
dedupes, preserves order. Live evidence: the active config has 105 priority
companies, all lowercased — clearly a Claude-generated + hand-edited set.

(Did not run a fresh onboarding round-trip — the `PHASE_D_FULL_CLAUDE` test
flag in phase_d_test.py:226 confirms it works when enabled, and the file
contents are consistent with a Claude-generated start.)

### Net verdict

**Mostly cosmetic with one real effect (a *negative* one): priority companies
bypass the title pre-filter.** That means a "Senior Sales Engineer at Wiz"
gets sent to Claude scoring instead of being skipped. This is the inverse of
what the field name suggests — "priority" should boost relevance, not
weaken filtering.

**To make it actually pull weight on scraping quality:**
1. **Easiest, biggest win**: include `"priority": true|false` in the per-job
   payload sent to Claude. Add 2 lines to the prompt: *"If `priority` is true,
   the company is on the user's high-interest list — bump fit one notch UNLESS
   it hits a hard red flag."* This makes it directly affect the score column.
2. Stronger version: split companies into a small `must_apply` (5-10) set and
   the broader `priority` set, treat `must_apply` as auto-good unless the
   title is hopeless.

### UX improvements (keep aesthetic)

105-entry comma-separated textarea (ConfigPage.tsx:445-456) is brittle —
`"perplexity, ai"` would split into two entries.

1. **Swap textarea for `<ChipInput>`** (already in `ui/src/ChipInput.tsx`, used
   at ConfigPage.tsx:399 for fit_positive/negative patterns). Drop-in: same
   `string[]` shape, same Tailwind aesthetic, gives visual separation +
   per-chip delete + tab-to-add.
2. **Add a top-of-card text filter to grep through the chips** plus a
   "first 30 / show all" toggle. Two more lines of state.

## 4. UI Polish Suggestions

Ranked by value/effort (S = <1h, M = a few hours, L = day+).

| # | Suggestion | Effort | Value | Notes |
|---|------------|--------|-------|-------|
| 1 | **Fix `filters.ts:fromSearchParams` category parser bug.** It uses the legacy `ALL_CATEGORIES` constant (`['crypto','security_researcher','company']`) for `parseCsv` validation, so user-defined category ids (`cat-mobyb81c-4` etc.) get silently dropped on every URL refresh — the active config has none of the legacy ids. | S | H | One-line fix: pass `availableCategories` from the corpus or accept any non-empty string. Bug, not polish. |
| 2 | **Virtualize `JobsTable` rows with `@tanstack/react-virtual`.** Already in `package.json`, currently unused. Corpus is set to grow via daily scrapes. Pagination at 50/page hides the issue today but rows-per-page=200 already feels heavy. | M | H | Wraps the existing `<tbody>` map. Keeps sticky header. Pure perf win at zero UX cost. |
| 3 | **Bulk-action row checkboxes**: select-many → "Mark applied" / "Open all" / "Copy IDs". The single-row checkbox already exists; add a header checkbox and selection state. | M | H | Eliran asks-and-acts patterns make this high-value. |
| 4 | **Keyboard row navigation: `j/k` move cursor, `Enter` to expand, `a` to toggle applied, `o` to open.** Currently only `/` for search and `Esc` to blur exist (CorpusPage.tsx:140-156). | M | H | Single `useEffect` that reads `document.activeElement` and walks the visible row list. |
| 5 | **Tooltip on `eBP`/source/scored_by chips** explaining what they mean. Loggedin/guest is opaque to anyone but the author. | S | M | Native `title=""` for v1; Radix Tooltip later. |
| 6 | **Empty filtered-state with "Clear filters" CTA.** Today it just says "No jobs match". Show the active filter chips inline. | S | M | Small text + button in the table fallback at JobsTable.tsx:427-433. |
| 7 | **Loading skeleton instead of "Loading results.json…" text.** A 4-row gray skeleton in `<JobsTable>` shape. | S | M | Pure cosmetic but reduces perceived latency. |
| 8 | **Surface `descriptions_failed` count in the StatsBar / ScrapeRunPanel.** Right now you'd have to open `run_history.json` to see that 11/29 desc fetches failed on 04-22. | S | M | One chip; reads `run_history.json[-1].totals.descriptions_failed`. |
| 9 | **Sticky / pinned column for "Applied" + "Company" on horizontal scroll.** At 11 columns the rightmost ones are clipped on narrow viewports. | M | M | TanStack supports `meta.pinned` natively. |
| 10 | **Mobile breakpoint for FilterPanel.** Currently a fixed left sidebar; drawer pattern below `md`. | L | L | Eliran almost certainly uses this on a desktop, so deprioritized. |
| 11 | **Better focus rings.** Current `focus:ring-1 focus:ring-brand-700` is fine but inconsistent across `<button>` vs `<input>`. Audit + standardize. | S | L | Polish-of-polish. |
| 12 | **Micro-animation on Refresh + on row applied-toggle.** Tailwind `transition-all` + `duration-200`. | S | L | Cheap pro-feel. |
| 13 | **Replace `<>` row-and-expand fragment in JobsTable.tsx:348-424 with explicit keys.** React 19 will complain about the `<>...</>` pair lacking a key when both rows render. | S | M | Subtle React warning fix. |
| 14 | **Add `aria-sort="ascending|descending"` to sortable `<th>`.** Currently no a11y signal; matters for screen readers. | S | L | Three lines in the `<th>` map at JobsTable.tsx:319-340. |

**Top three I'd ship first**: #1 (genuine bug), #2 (virtualization, growing corpus), #3 (bulk actions, real productivity).

## 5. Test Strategy Gaps

`phase_d_test.py` is good for what it tests (imports, schema, dry helpers,
launchd round-trips, UI build, endpoints, data integrity). But the actual
failure modes the project has shipped recently aren't covered.

### Concrete missing coverage

| # | Gap | Where | Priority |
|---|-----|-------|----------|
| 1 | **`_extract_jobs_from_cards` with mixed-banner data.** Test asserts that a fixture with banner=True drops everything; banner=False with `eBP=NOT_ELIGIBLE_FOR_CHARGING` drops only filler; mixed real+offtarget for company query culls the right ones. | search.py:1411 | H |
| 2 | **`fetch_description_guest` 429 burst-and-recovery against a mock.** Mock `requests.Session` to return 429 with `Retry-After: 5`, then 200, assert backoff path. Use `unittest.mock` or a tiny `requests_mock`. Would catch a regression in the new 429 retry code. | search.py:1066 | H |
| 3 | **`_parse_retry_after` with HTTP-date AND int forms.** Trivial unit tests, none exist. | search.py:1043 | M |
| 4 | **Pagination past page 1 for guest API.** A live integration test (skipped by default with env flag) that runs the actual probe and asserts `>= 25` unique IDs across 4 pages for a known broad query. Catches "LinkedIn changed the API" before users notice. | probe_guest_api.py | M |
| 5 | **`filters.ts` URL-roundtrip with user-defined categories** — would catch the bug I flagged in §4. | filters.ts | H |
| 6 | **`JobsTable` applied-sort and accessor invalidation.** RTL test that mounts the table, toggles applied on a row, asserts it sinks. Would have caught the "display column sortingFn ignored" bug (the inline comment at JobsTable.tsx:120-125 references this). | JobsTable.tsx | H |
| 7 | **Score-sort with null at top.** Mount table with a mix of null/numeric scores, click Score header, assert nulls go to bottom (`sortUndefined: 'last'`). | JobsTable.tsx:189-202 | H |
| 8 | **CV length validator.** `onboarding_ctl.cmd_generate` rejects <100 chars CV — covered. But the UI form (`OnboardingPage`) probably has a parallel client-side check; assert they match. | OnboardingPage.tsx | M |
| 9 | **Onboarding → save-as-profile → scrape end-to-end (dry).** Symlink swap + `active_profile.txt` write + load_config reads the new profile. Currently no test asserts that `save-as-profile` actually rebinds. | onboarding_ctl.cmd_save_as_profile | M |
| 10 | **Email digest section ordering: priority before good before ok.** Trivial fixture; would catch a regression in send_email.py:260-272. | send_email.py | L |
| 11 | **`is_obviously_offtopic` exempts priority companies** — the negative behavior I flagged in §3. Whether intentional or not, document it with a test so it can't change silently. | search.py:1903 | M |
| 12 | **`_card_matches_tokens` "drop trailing y/er" stem behavior** — explicit assertion for `cryptography→cryptograph`, `security→securit`. Avoid drift. | search.py:1273 | L |

### Vitest + RTL recommendation

**Yes, for gaps 5-7.** They're React state/sort logic bugs unobservable from
phase_d's "did the build pass" check. Cost: one `npm i -D vitest
@testing-library/react @testing-library/jest-dom` + ~10-line `vitest.config.ts`,
run from phase_d step 7 alongside `npm run build`. Don't bother with
ConfigPage/RunHistoryPage component-tree tests — value is in the table and
URL parser.

## Prioritized Action List (top 10)

1. Send `priority` flag to Claude scoring payload + add 2-line prompt rule. — **S**
2. Fix `filters.ts:fromSearchParams` category parser dropping user-defined ids. — **S**
3. Replace `priority_companies` textarea with existing `<ChipInput>` + filter input. — **S**
4. Add Vitest + RTL tests for table sort, URL roundtrip, score-null-last (gaps 5-7). — **M**
5. Virtualize `JobsTable` rows with `@tanstack/react-virtual` (already installed). — **M**
6. Add unit tests for `_classify_card`, `fetch_description_guest` 429 path, `_parse_retry_after`, `_extract_jobs_from_cards` mixed-banner. — **M**
7. Add bulk-action checkboxes (select many → mark applied / copy IDs). — **M**
8. Add `j/k/Enter/a/o` keyboard row navigation. — **M**
9. Validate geoId on save in onboarding_ctl + configMigrate (warn on unknown). — **S**
10. Drop the now-broken `_try_jsonld_description` fallback (or update selectors); JSON-LD is no longer in public job pages. — **S**
