// Shared types for the onboarding wizard. Lifted out of the original
// monolithic OnboardingPage.tsx so each step file can import them
// without re-importing the whole page.

import type { LLMProviderName } from '../configTypes';

// 9 steps. Step 6 (Notifications) was inserted between Intent (5) and the
// LLM-driven Generate (was 6, now 7) so a fresh-clone user discovers the
// email-digest option without having to hand-edit ~/.linkedin-jobs.env.
export type Step = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

// Shape returned by GET /api/notifications/status. NEVER includes the
// password — only smtp_configured signals whether one is on disk.
export interface NotificationsStatusResponse {
  ok: boolean;
  smtp_configured: boolean;
  host: string;
  port: number | null;
  user: string;
  email_to: string;
  ssl: boolean;
  env_file?: string;
  error?: string;
}

// Shape of POST /api/notifications/save-smtp + /api/notifications/test-smtp.
// Both share the success/error envelope — `message` only appears for
// test-smtp success; save-smtp returns `vars_written`.
export interface NotificationsActionResponse {
  ok: boolean;
  message?: string;
  error?: string;
  vars_written?: string[];
  host?: string;
  port?: number;
  ssl?: boolean;
}

export interface GenerateResponse {
  ok: boolean;
  config?: unknown;
  raw?: string;
  error?: string;
}

export interface SaveResponse {
  ok: boolean;
  error?: string;
  profile?: string;
}

export interface PreflightCheck {
  name: string;
  ok: boolean;
  value?: string;
  fix?: string;
}

export interface PreflightResponse {
  ok: boolean;
  checks?: PreflightCheck[];
  error?: string;
}

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

export interface LinkedInSessionResponse {
  exists: boolean;
  mtime: string | null;
  error?: string;
}

// In-flight wizard draft — propagated to Step 6's save payload so the saved
// profile reflects the wizard picks (llm_provider / geo_id / default_mode).
export interface WizardDraft {
  llm_provider?: { name: LLMProviderName };
  geo_id?: string;
  default_mode?: 'guest' | 'loggedin';
}

export const CV_MIN_CHARS = 200;
export const INTENT_MIN_CHARS = 50;

// Mirrors onboarding_ctl._PROFILE_NAME_RE.
export const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

// Default profile name shown in Step 6 — "onboarded-YYYY-MM-DD". Pure local
// date (not UTC) so a user in Asia doesn't see a tomorrow-dated profile.
export const defaultProfileName = (): string => {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `onboarded-${yyyy.toString()}-${mm}-${dd}`;
};
