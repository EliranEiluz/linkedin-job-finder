// One-time migration from the legacy hardcoded-bucket schema to the new
// domain-generic categories[] schema. Designed to be defensive: any input that
// is partially malformed is patched with sensible defaults rather than thrown.
//
// New schema (target):
//   categories: [{ id, name, type: "keyword"|"company", queries: string[] }]
//   priority_companies: string[]
//   claude_scoring_prompt?: string
//   fit_{positive,negative}_patterns?: string[]
//   offtopic_title_patterns?: string[]
//
// Legacy schema (one-time read):
//   search_queries: string[]              -> Category { name: "Keywords",  type: "keyword" }
//   security_researcher_queries: string[] -> Category { name: "Security",  type: "keyword" }
//   company_queries: string[]             -> Category { name: "Companies", type: "company" }
//
// `priority_companies` was historically allowed as a CSV string in some hand-edited
// configs — split on comma if so.

import type { Category, CategoryType, CrawlerConfig } from './configTypes';

let _idCounter = 0;
export const newCategoryId = (): string => {
  _idCounter += 1;
  return `cat-${Date.now().toString(36)}-${_idCounter.toString(36)}`;
};

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

const cleanStrArr = (v: unknown): string[] => {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === 'string' ? x : ''))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
};

const isCategoryType = (v: unknown): v is CategoryType =>
  v === 'keyword' || v === 'company';

const normalizeCategory = (raw: unknown): Category | null => {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const queries = cleanStrArr(r.queries);
  const type: CategoryType = isCategoryType(r.type) ? r.type : 'keyword';
  const name = typeof r.name === 'string' && r.name.trim() ? r.name : 'Untitled';
  const id = typeof r.id === 'string' && r.id ? r.id : newCategoryId();
  return { id, name, type, queries };
};

const normalizeCategoriesArray = (v: unknown): Category[] | null => {
  if (!Array.isArray(v)) return null;
  const out: Category[] = [];
  for (const item of v) {
    const c = normalizeCategory(item);
    if (c) out.push(c);
  }
  return out;
};

const buildLegacyCategories = (
  searchQueries: string[],
  secQueries: string[],
  companyQueries: string[],
): Category[] => {
  const cats: Category[] = [];
  // Always emit at least an empty Keywords bucket so the user has somewhere
  // obvious to add their first query, even if every legacy field was blank.
  cats.push({
    id: newCategoryId(),
    name: 'Keywords',
    type: 'keyword',
    queries: searchQueries,
  });
  if (secQueries.length > 0) {
    cats.push({
      id: newCategoryId(),
      name: 'Security',
      type: 'keyword',
      queries: secQueries,
    });
  }
  cats.push({
    id: newCategoryId(),
    name: 'Companies',
    type: 'company',
    queries: companyQueries,
  });
  return cats;
};

const normalizePriorityCompanies = (v: unknown): string[] => {
  if (typeof v === 'string') {
    return v
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return cleanStrArr(v);
};

// Mirror of onboarding_ctl._KNOWN_GEO_IDS — used for the warning channel only,
// non-known but all-digit values are accepted (might be a legitimate custom URN).
const KNOWN_GEO_IDS = new Set([
  '92000000',     // Worldwide
  '101620260',    // Israel
  '103644278',    // United States
  '101165590',    // United Kingdom
  '91000000',     // Europe
]);

// LinkedIn silently falls back to worldwide on bogus geoIds (no HTTP 400) — a
// typo would flood the funnel. Accept empty or all-digit strings; warn-but-
// accept unknown digit URNs; drop non-digit garbage so it can't be saved.
export const validateGeoId = (raw: unknown): string => {
  if (typeof raw !== 'string') return '';
  const s = raw.trim();
  if (!s) return '';
  if (!/^\d+$/.test(s)) {
    // eslint-disable-next-line no-console
    console.warn(`geo_id ${JSON.stringify(raw)} is not a digit string — dropping`);
    return '';
  }
  if (!KNOWN_GEO_IDS.has(s)) {
    // eslint-disable-next-line no-console
    console.warn(
      `geo_id ${s} is not a known LinkedIn URN — accepting but verify before scraping`,
    );
  }
  return s;
};

export const normalizeConfig = (raw: unknown): CrawlerConfig => {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  // Categories: prefer the new shape if present and well-formed; otherwise
  // fall back to legacy field synthesis.
  let categories: Category[] | null = null;
  if (Array.isArray(r.categories)) {
    categories = normalizeCategoriesArray(r.categories);
  }
  if (!categories || categories.length === 0) {
    // Even if `categories` was present-but-empty, synthesize from legacy if any
    // legacy fields look populated. If both are empty, fall through to a single
    // default Keywords bucket (so the UI never shows a blank list with no
    // affordance to add).
    const sq = isStringArray(r.search_queries) ? r.search_queries : [];
    const ss = isStringArray(r.security_researcher_queries)
      ? r.security_researcher_queries
      : [];
    const cq = isStringArray(r.company_queries) ? r.company_queries : [];
    if (Array.isArray(r.categories) && (categories?.length ?? 0) === 0 && sq.length === 0 && ss.length === 0 && cq.length === 0) {
      categories = []; // user explicitly wiped categories — respect it
    } else {
      categories = buildLegacyCategories(sq, ss, cq);
    }
  }

  const claudePrompt =
    typeof r.claude_scoring_prompt === 'string' && r.claude_scoring_prompt.length > 0
      ? r.claude_scoring_prompt
      : undefined;

  const fitPositive = isStringArray(r.fit_positive_patterns)
    ? r.fit_positive_patterns
    : undefined;
  const fitNegative = isStringArray(r.fit_negative_patterns)
    ? r.fit_negative_patterns
    : undefined;
  const offtopic = isStringArray(r.offtopic_title_patterns)
    ? r.offtopic_title_patterns
    : undefined;

  const feedbackMax =
    typeof r.feedback_examples_max === 'number'
    && Number.isFinite(r.feedback_examples_max)
      ? Math.min(20, Math.max(0, Math.round(r.feedback_examples_max)))
      : undefined;

  return {
    categories,
    location: typeof r.location === 'string' ? r.location : '',
    date_filter: typeof r.date_filter === 'string' ? r.date_filter : '',
    geo_id: validateGeoId(r.geo_id),
    max_pages:
      typeof r.max_pages === 'number' && Number.isFinite(r.max_pages)
        ? Math.min(20, Math.max(1, Math.round(r.max_pages)))
        : 3,
    priority_companies: normalizePriorityCompanies(r.priority_companies),
    claude_scoring_prompt: claudePrompt,
    fit_positive_patterns: fitPositive,
    fit_negative_patterns: fitNegative,
    offtopic_title_patterns: offtopic,
    feedback_examples_max: feedbackMax,
  };
};

// Strip transient client-side fields (none today, but keeps the save path
// future-proof) and drop any legacy keys that may have lingered. We never
// write the legacy fields back — the python side accepts the new shape only,
// with a one-time migration path of its own.
export const serializeConfig = (cfg: CrawlerConfig): Record<string, unknown> => {
  const out: Record<string, unknown> = {
    categories: cfg.categories.map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      queries: c.queries,
    })),
    location: cfg.location,
    date_filter: cfg.date_filter,
    geo_id: validateGeoId(cfg.geo_id),
    max_pages: cfg.max_pages,
    priority_companies: cfg.priority_companies,
  };
  if (cfg.claude_scoring_prompt && cfg.claude_scoring_prompt.length > 0) {
    out.claude_scoring_prompt = cfg.claude_scoring_prompt;
  }
  if (cfg.fit_positive_patterns !== undefined) {
    out.fit_positive_patterns = cfg.fit_positive_patterns;
  }
  if (cfg.fit_negative_patterns !== undefined) {
    out.fit_negative_patterns = cfg.fit_negative_patterns;
  }
  if (cfg.offtopic_title_patterns !== undefined) {
    out.offtopic_title_patterns = cfg.offtopic_title_patterns;
  }
  if (cfg.feedback_examples_max !== undefined) {
    out.feedback_examples_max = cfg.feedback_examples_max;
  }
  return out;
};
