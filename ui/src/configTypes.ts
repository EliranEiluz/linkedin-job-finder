// Shape mirrors search.py:_hardcoded_defaults() and load_config() merge keys.
// Phase A: domain-generic categories replace the hardcoded crypto/security/company
// query buckets. Legacy fields are kept optional so the migration helper compiles
// against both shapes; see configMigrate.ts.

export type CategoryType = 'keyword' | 'company';

// Stage 2: LLM provider abstraction. UI control lands in Stage 3 (welcome
// wizard); for now the field round-trips through save/load so a hand-edited
// config.json or a future wizard write doesn't get clobbered.
export type LLMProviderName =
  | 'auto'
  | 'claude_cli'
  | 'claude_sdk'
  | 'gemini'
  | 'openai'
  | 'openrouter'
  | 'ollama';

export interface LLMProviderConfig {
  name: LLMProviderName;
  model?: string; // optional — provider has a sensible default if omitted
}

export interface Category {
  id: string;            // stable client-side id; preserved across saves when possible
  name: string;          // user-facing label, e.g. "Keywords", "Companies", "ML researcher"
  type: CategoryType;    // "keyword" => LinkedIn keyword search w/ token-relevance filter
                         // "company" => LinkedIn company-name search; result company name
                         //              must contain the query
  queries: string[];     // search terms / company names
}

export interface CrawlerConfig {
  // --- new (Phase A) -----------------------------------------------------
  categories: Category[];
  claude_scoring_prompt?: string;     // optional override; "" or undefined => python falls back to its hardcoded default
  fit_positive_patterns?: string[];   // regex strings — fallback when Claude scoring is unavailable
  fit_negative_patterns?: string[];   // regex strings — fallback when Claude scoring is unavailable
  offtopic_title_patterns?: string[]; // regex strings — applied to job titles to drop obvious off-topic hits

  // --- shared ------------------------------------------------------------
  location: string;
  date_filter: string;                // "" | "r86400" | "r604800" | "r2592000"
  geo_id: string;                     // "" | "101620260" | "103644278" | "92000000" | custom
  max_pages: number;                  // 1..20
  priority_companies: string[];       // lowercased on save; substring-in-company-name match
  // How many of the user's most recent rated/applied/manual-add jobs the
  // few-shot loop injects into Claude's scoring prompt as calibration
  // examples. Backend clamps to [0, 20]; default 6. Larger = Claude has
  // more of your taste, smaller = leaner prompt (faster + cheaper).
  feedback_examples_max?: number;
  // Stage 2 — backend LLM provider selector. Omit to keep "auto" behavior.
  llm_provider?: LLMProviderConfig;
  // Stage 3 — picked in the welcome wizard (Step 3). Used as the default
  // scrape mode and pre-fill for the scheduler card. "guest" if missing
  // (matches the legacy implicit default).
  default_mode?: 'guest' | 'loggedin';

  // --- legacy (one-time migrate via normalizeConfig) ---------------------
  // Kept optional so older config.json files load without a type error.
  // These fields will NOT be written back on save.
  search_queries?: string[];
  security_researcher_queries?: string[];
  company_queries?: string[];
}

export const DATE_FILTER_OPTIONS: { value: string; label: string }[] = [
  { value: 'r86400', label: '1 day' },
  { value: 'r604800', label: '7 days' },
  { value: 'r2592000', label: '30 days' },
  { value: '', label: 'Any' },
];

// (session default) is the empty string — LinkedIn's logged-in geo home filter.
export const GEO_PRESETS: { value: string; label: string }[] = [
  { value: '', label: '(session default)' },
  { value: '101620260', label: 'Israel (101620260)' },
  { value: '103644278', label: 'United States (103644278)' },
  { value: '92000000', label: 'Worldwide (92000000)' },
];

export const isPresetGeoId = (v: string): boolean =>
  GEO_PRESETS.some((p) => p.value === v);

const eqStrArr = (x: string[], y: string[]): boolean =>
  x.length === y.length && x.every((v, i) => v === y[i]);

const eqOptStrArr = (x: string[] | undefined, y: string[] | undefined): boolean => {
  const xa = x ?? [];
  const ya = y ?? [];
  return eqStrArr(xa, ya);
};

const eqCategories = (a: Category[], b: Category[]): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ca = a[i];
    const cb = b[i];
    // Compare structural equality, not id-on-id — a freshly-rebuilt list (e.g. after
    // discard) will get the same content but new ids.
    if (ca.name !== cb.name) return false;
    if (ca.type !== cb.type) return false;
    if (!eqStrArr(ca.queries, cb.queries)) return false;
  }
  return true;
};

export const configsEqual = (a: CrawlerConfig, b: CrawlerConfig): boolean => {
  if (a.location !== b.location) return false;
  if (a.date_filter !== b.date_filter) return false;
  if (a.geo_id !== b.geo_id) return false;
  if (a.max_pages !== b.max_pages) return false;
  if ((a.claude_scoring_prompt ?? '') !== (b.claude_scoring_prompt ?? '')) return false;
  if (!eqCategories(a.categories, b.categories)) return false;
  if (!eqStrArr(a.priority_companies, b.priority_companies)) return false;
  if (!eqOptStrArr(a.fit_positive_patterns, b.fit_positive_patterns)) return false;
  if (!eqOptStrArr(a.fit_negative_patterns, b.fit_negative_patterns)) return false;
  if (!eqOptStrArr(a.offtopic_title_patterns, b.offtopic_title_patterns)) return false;
  if ((a.feedback_examples_max ?? null) !== (b.feedback_examples_max ?? null)) return false;
  const ap = a.llm_provider;
  const bp = b.llm_provider;
  if ((ap?.name ?? null) !== (bp?.name ?? null)) return false;
  if ((ap?.model ?? null) !== (bp?.model ?? null)) return false;
  if ((a.default_mode ?? null) !== (b.default_mode ?? null)) return false;
  return true;
};
