// Shared types + endpoint constants for /api/llm/* — used by both the
// onboarding wizard (Step1LLM) and the post-onboarding LLMProviderCard
// in the Crawler Config tab.
//
// The types were originally defined in `onboarding/types.ts`; they were
// lifted here when the provider-picker UI was extracted from the wizard
// step into a shared component (LLMProviderSelector). `onboarding/types.ts`
// re-exports them so the wizard's existing imports keep working.

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

export const LLM_LIST_URL = '/api/llm/list';
export const LLM_TEST_URL = '/api/llm/test';
export const LLM_SAVE_CRED_URL = '/api/llm/save-credential';
