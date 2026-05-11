// Shared types + endpoint constants for /api/llm/* — used by both the
// onboarding wizard (Step1LLM) and the post-onboarding LLMProviderCard
// in the Crawler Config tab.
//
// The types were originally defined in `onboarding/types.ts`; they were
// lifted here when the provider-picker UI was extracted from the wizard
// step into a shared component (LLMProviderSelector). `onboarding/types.ts`
// re-exports them so the wizard's existing imports keep working.
//
// Task #114 added the model-catalog types (`ModelInfo`,
// `ReasoningCapability`, `LLMModelsResponse`) — they mirror the backend
// dataclasses 1:1.

import type { LLMProviderName } from './configTypes';

export interface LLMProvider {
  name: LLMProviderName;
  label: string;
  needs_key: boolean;
  free_tier: boolean;
  env_var: string | null;
  help_url: string;
  blurb: string;
}

export interface LLMListResponse {
  ok: boolean;
  providers?: LLMProvider[];
  error?: string;
}

export interface LLMTestResponse {
  ok: boolean;
  message?: string;
  name?: string;
  error?: string;
}

export interface LLMSaveCredResponse {
  ok: boolean;
  env_var?: string;
  env_path?: string;
  error?: string;
}

// --- task #114 — model catalog -------------------------------------------

// What shape the model declares for its reasoning-effort surface.
//   levels  — string ∈ {low, medium, high, max, xhigh} subset.
//   budget  — integer token budget within (min, max), or -1 for dynamic.
//   boolean — true/false (ollama "thinking" models).
//   none    — model has no reasoning surface (hide the control).
export type ReasoningShape = 'levels' | 'budget' | 'boolean' | 'none';

export interface ReasoningCapability {
  supported: boolean;
  shape: ReasoningShape;
  levels?: string[];                  // populated when shape === "levels"
  budget_range?: [number, number];    // populated when shape === "budget"
}

export interface ModelInfo {
  id: string;
  display_name: string;
  max_input_tokens: number | null;
  max_output_tokens: number | null;
  reasoning: ReasoningCapability;
}

export interface LLMModelsResponse {
  ok: boolean;
  provider?: string;
  models?: ModelInfo[];
  error?: string;
}

export const LLM_LIST_URL = '/api/llm/list';
export const LLM_TEST_URL = '/api/llm/test';
export const LLM_SAVE_CRED_URL = '/api/llm/save-credential';
// New in #114. Provider name lives on the query string so the GET
// route is cache-friendly.
export const LLM_MODELS_URL = '/api/llm/models';

// Threshold above which the picker shows a search input above the model
// dropdown. Tuned for OpenRouter (100+ models); other providers stay
// well under this.
export const MODEL_SEARCH_THRESHOLD = 20;
