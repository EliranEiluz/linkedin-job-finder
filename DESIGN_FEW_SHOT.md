# Few-shot feedback loop in the Claude scoring prompt

Design rationale for `_build_user_feedback_examples()` in `backend/search.py`.

Status: shipped 2026-04-24. See accompanying commit.

---

## 1. Signals chosen (and rejected)

The user's rating popover, kanban board, notes editor, and delete actions
all surface preference data. Not all of it is useful as a few-shot example.

### Included

**`rating` (1-5 stars) + `comment`** — explicit, atomic preference data. The
user opened a popover and answered "how good was this match for me?".
Comments are the highest-density signal in the corpus: when present, they
literally describe the user's reasoning ("interesting but small team",
"crypto-adjacent, not core"). Always included when present.

**`app_status` in {`interview`, `take-home`, `screening`, `offer`}** —
implicit positive signal. Reaching one of these states means a real
human–human exchange happened beyond a one-click LinkedIn Easy Apply, so
the user was meaningfully invested. Included as a positive example with
a synthetic rating-equivalent of 4.

**`app_status` in {`rejected`, `withdrew`}** — implicit negative signal,
treated as rating-equivalent 2. Currently zero rows have this status, so
the code path is forward-compat: as the corpus ages, withdrawals will
become a useful "not actually a fit, I bailed" example.

### Rejected

**`app_status: applied` alone** (no rating, no advanced status) — too noisy.
The user applies broadly and most rows in the corpus today are
`applied`-only (13 of 17). Treating "applied" as a strong positive signal
would amplify the natural funnel-top bias and effectively re-weight the
existing scoring upward across the board, which is the opposite of what
few-shot personalization should do.

**`app_notes`** — only one row in the live corpus has notes today
(`audit: recruiter pinged me Friday`). The content is operational
(scheduling, recruiter status) rather than preference-revealing. Even
when fully populated it would mostly tell Claude about the recruiting
process, not about whether the *posting* was a good match. Skipped.

**Deletes** (jobs in `seen_jobs.json` but absent from `results.json`) —
flagged in the task brief as a candidate. Two hard limitations: (a)
`seen_jobs.json` is just a flat list of IDs with **no timestamps**, so
there is no way to recency-weight or even tell when a job was deleted;
(b) once deleted, the job's `title` / `company` / `category` are gone
from `results.json`, so we cannot reconstruct the example. Counted: 4
deletes in the current corpus. Skipped, with a TODO in §6.

**Manual-add marker** (`source: "manual"`) — the manual-add UI does not
exist yet (only `source: "guest"` and `source: "loggedin"` are emitted
today). The helper already inspects `source` and would treat
`source == "manual"` as an implicit positive signal once the feature ships.
No code change needed at that point.

---

## 2. Threshold and ordering

### Cap: `feedback_examples_max = 6` (overridable in config.json)

Rationale from the research:

- **Anthropic's own docs** recommend 3–5 well-crafted examples for
  multishot prompting. Six is one above that range to leave headroom for
  positive/negative balancing.
- **Over-prompting** (Truong et al., arXiv 2509.13196, 2025) shows
  excessive examples *degrade* LLM performance — the assumption that "more
  is better" doesn't hold for in-context few-shot.
- **Majority-label bias** (Anthropic prompting guide; PromptHub 2024) —
  the model favors whichever class dominates the examples. Capping low
  and stratifying (see below) reduces this risk.
- The current realistic corpus has ~3 ratings + ~4 advanced-status jobs
  ≈ 7 candidates; cap of 6 covers the live data without forcing us to
  drop high-signal ratings to make room for lower-signal status promotions.

User can tune via `config.json`:

```json
{ "feedback_examples_max": 8 }
```

Hard floor 1, hard ceiling 20 enforced in `_build_user_feedback_examples`.

### Ordering: stratified positive/negative, recency-secondary, interleaved

1. **Stratify.** Up to `cap // 2` positives and `cap // 2` negatives. Fill
   any leftover slots from the larger pool. This prevents the single
   strongest signal class from dominating (majority-label bias).
2. **Recency-sort within each bucket.** Use `rated_at` if present, else
   the latest `app_status_history[*].at`, else `found_at`. Newest first.
   Research consensus (Liu et al. 2024 survey on LLM personalization;
   PromptHub guide): when forced to pick K from N, recency beats random
   for tasks where user preferences drift. Eliran's preferences are
   evolving (he's actively interviewing, refining what he wants).
3. **Interleave** positives and negatives in the final list (P, N, P, N…)
   instead of all positives then all negatives. This counters the
   well-documented **recency bias** in LLMs (Anthropic; OpenAI
   prompting guide): the model over-weights whichever examples appear
   last. An interleaved tail signals "both classes matter equally".

---

## 3. Prompt position

The block is injected **after the CV** and **before the scoring rules**:

```
<cv> ... </cv>
<user_feedback_examples>  ← NEW
  ... examples ...
</user_feedback_examples>
You will receive a JSON array of jobs ...
Scoring: ...
Rules: ...
<jobs> ... </jobs>
```

Reasoning:

- **Anthropic docs**: long reference documents go at the top; structured
  examples go in dedicated XML tags; instructions and the actual task
  follow.
- The CV is the *identity*. The feedback examples are *empirical
  calibration evidence* — "given who I am (CV), here's how I actually
  judged jobs that fit that profile". Rules then synthesize both.
- Putting examples between CV and rules means the model reads the rules
  *with the examples already in working memory*, instead of as an
  afterthought before the JSON payload.
- Critically, the `<jobs>` payload stays **last** — Anthropic and OpenAI
  both note that the most recent input gets the heaviest attention, so
  the to-be-scored jobs must be in that position.

---

## 4. Sanitization rules

Each example is one short line of the form:

```
- "<title>" @ <company> [<category>] → user marked: <signal>
```

What is **stripped** before injection:

- Job descriptions (`_desc`, never present in the persisted corpus
  anyway, but stripped defensively).
- URLs (`url`).
- Job IDs (numeric LinkedIn IDs are noise to the scorer).
- Location (city / country — not preference-revealing for this user).
- `app_notes` (operational, see §1).
- `app_status_history` array (only the *current* status is summarized).
- Free-text fields > 120 chars (truncated with `…`).

Each example is hard-capped at **250 chars** total. With 6 examples that
is ~1.5KB on top of a ~2KB CV — trivially under any model's context
window.

If the user has manually rated a job 4-5 stars *and* added a comment, the
comment is the most valuable part. The single-line format allocates ~120
chars of the 250-char budget to the comment when present.

---

## 5. Config knobs

Added to `config.json` (and `_hardcoded_defaults()`):

| Key | Default | Range | Effect |
|---|---|---|---|
| `feedback_examples_max` | `6` | `1..20` | Hard cap on examples injected per Claude call. Set to `0` to disable the feature entirely. |

Reading the key uses the same defensive pattern as the rest of
`load_config()` — invalid types fall back to default; out-of-range values
are clamped.

---

## 6. Limitations and future work

**Manual-add (when shipped).** The helper already treats `source ==
"manual"` as an implicit positive signal (the user went out of their way
to add this job — strong intent). No code change required when the
feature lands; it just starts contributing rows to the candidate pool.

**Deletes-with-timestamps.** If `seen_jobs.json` evolves from a flat list
into `[{id, deleted_at, snapshot: {title, company}}, ...]`, deletes
become recoverable as negative examples. Until then we can't include
them.

**Comment-on-status-change.** Today the kanban transitions don't capture
*why* the user moved a card. Adding a "why" textarea on the
`screening`/`take-home`/`rejected` transition would unlock semantic
negative signals ("rejected — they wanted 7 yrs", etc.) without the user
having to also explicitly rate.

**Per-category calibration.** With more data the helper could stratify
not just by sentiment but by category (1 crypto positive, 1 security
positive, 1 negative each), giving Claude better cross-category
calibration. Today the corpus is too small for stratification beyond
positive/negative.

**Cache invalidation.** The helper is called once per `claude_batch_score`
and rebuilds from disk every time. With Anthropic's prompt-caching
already in use on the system prompt (`cache_control: ephemeral`), if we
ever move the feedback block into the cached system prompt we will need
to bust the cache when the user rates a new job. For now the block lives
in the user message and is rebuilt fresh — no caching surprises.

---

## 7. Sources

Anthropic / Claude documentation:

- [Use examples (multishot prompting) to guide Claude's behavior — Claude Docs](https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/multishot-prompting)
- [Prompting best practices — Claude API Docs](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)

Few-shot personalization & ranking:

- [Few-shot Personalization of LLMs with Mis-aligned Responses (NAACL 2025)](https://aclanthology.org/2025.naacl-long.598.pdf)
- [Personalization of Large Language Models: A Survey (arXiv 2411.00027v3)](https://arxiv.org/html/2411.00027v3)
- [Aligning Prompts with Ranking Goals: A Technical Review (Preprints 2025)](https://www.preprints.org/manuscript/202509.1959)
- [Reinforced Prompt Personalization for Recommendation with Large Language Models (TOIS 2025)](https://dl.acm.org/doi/10.1145/3716320)

Over-prompting / overfitting / bias amplification:

- [The Few-shot Dilemma: Over-prompting Large Language Models (arXiv 2509.13196)](https://arxiv.org/abs/2509.13196)
- [PromptHub — The Few-Shot Prompting Guide](https://www.prompthub.us/blog/the-few-shot-prompting-guide)
- [Fairness-guided Few-shot Prompting for Large Language Models (Tencent AI Lab)](https://ailab.tencent.com/ailab/media/publications/Fairness-guided_Few-shot_Prompting_for_Large_Language_Models.pdf)
- [On the Difficulty of Selecting Few-Shot Examples for Effective LLM-based Vulnerability Detection (arXiv 2510.27675)](https://arxiv.org/html/2510.27675)
