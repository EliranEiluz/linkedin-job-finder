// Constants and label maps shared across the Applications (tracker) page
// — kanban Column, table view, summary strip, and the AppDetailModal all
// pull from here. Lives in its own module so the modal file (extracted
// for size) doesn't have to import back from ApplicationsPage.tsx.

import { formatDistanceToNowStrict, parseISO } from 'date-fns';
import type { AppStatus, Job } from '../types';
import type { DotColor } from '../Dot';

// 7 visible columns. `'new'` is intentionally hidden — jobs with no
// `app_status` (or `'new'`) live in the Corpus tab, not here.
export const COLUMNS: readonly AppStatus[] = [
  'applied',
  'screening',
  'interview',
  'take-home',
  'offer',
  'rejected',
  'withdrew',
] as const;

export const STATUS_LABEL: Record<AppStatus, string> = {
  new: 'New',
  applied: 'Applied',
  screening: 'Screening',
  interview: 'Interview',
  'take-home': 'Take-home',
  offer: 'Offer',
  rejected: 'Rejected',
  withdrew: 'Withdrew',
};

// Hover blurbs surfaced as the column-header title=… on the kanban. One short
// sentence each — tells the user what counts as that stage. Mobile devices
// won't see these (no hover) but desktop scanning is the main use case.
export const STATUS_BLURB: Record<AppStatus, string> = {
  new: 'Default state — lives in the Corpus tab, not here.',
  applied: "You sent the application; waiting for a reply.",
  screening: 'Recruiter or hiring manager has reached out for a screen.',
  interview: 'In an interview round (technical, behavioural, on-site).',
  'take-home': 'Working on (or waiting on) a take-home assignment.',
  offer: 'You have an offer in hand.',
  rejected: 'Closed — they passed, or you got a clear no.',
  withdrew: 'Closed — you pulled out (no longer interested or accepted elsewhere).',
};

// Tailwind tints for the column accent bar. Kept inline (instead of dynamic
// class names) so Tailwind's JIT picks them up at build time.
export const STATUS_ACCENT: Record<AppStatus, string> = {
  new: 'bg-slate-300',
  applied: 'bg-slate-400',
  screening: 'bg-blue-500',
  interview: 'bg-indigo-500',
  'take-home': 'bg-amber-500',
  offer: 'bg-emerald-500',
  rejected: 'bg-red-500',
  withdrew: 'bg-slate-300',
};

// Per-stage summary + table-view status chips. Per §3.5 the chip
// background is uniform slate; semantic meaning is carried by the leading
// dot. The dot color collapses the original 7-tint palette into the
// new 4-token palette:
//   in-progress active stages → neutral (applied/screening/interview/take-home)
//   offer                     → good
//   rejected                  → bad
//   withdrew / new            → neutral (muted text)
// Note: the per-column accent BAR (STATUS_ACCENT above) keeps its 5
// distinct colors — the user explicitly called those out as "status-
// specific, not decorative" in the polish spec.
export const STATUS_CHIP: Record<AppStatus, string> = {
  new: 'bg-slate-100 text-slate-500',
  applied: 'bg-slate-100 text-slate-700',
  screening: 'bg-slate-100 text-slate-700',
  interview: 'bg-slate-100 text-slate-700',
  'take-home': 'bg-slate-100 text-slate-700',
  offer: 'bg-slate-100 text-slate-700',
  rejected: 'bg-slate-100 text-slate-600',
  withdrew: 'bg-slate-100 text-slate-500',
};
export const STATUS_DOT: Record<AppStatus, DotColor> = {
  new: 'neutral',
  applied: 'neutral',
  screening: 'neutral',
  interview: 'neutral',
  'take-home': 'warn',
  offer: 'good',
  rejected: 'bad',
  withdrew: 'neutral',
};

// "Active" stages where a follow-up makes sense — terminal states
// (offer / rejected / withdrew) are excluded. Threshold matches the
// design doc: 14 days since last move flags the row as stale.
export const STALE_DAYS = 14;
export const STALE_ACTIVE: ReadonlySet<AppStatus> = new Set<AppStatus>([
  'applied',
  'screening',
  'interview',
  'take-home',
]);

// Notes editor sizing + autosave cadence. Server caps at 4000 chars (see
// vite.config.ts → /api/corpus/app-status). 600ms debounce mirrors the
// rating-comment editor in JobActionsPopover.tsx so the two surfaces feel
// identical to the user.
export const NOTES_MAX = 4000;
export const NOTES_AUTOSAVE_MS = 600;

export const safeRel = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  try {
    return formatDistanceToNowStrict(parseISO(iso), { addSuffix: true });
  } catch {
    return '—';
  }
};

// "Stale" = active stage AND last status move was >STALE_DAYS ago. Pure
// derived overlay — never written to disk, never a column of its own.
export const isStaleJob = (j: Job): boolean => {
  if (!j.app_status || !STALE_ACTIVE.has(j.app_status)) return false;
  if (!j.app_status_at) return false;
  const t = Date.parse(j.app_status_at);
  if (Number.isNaN(t)) return false;
  const ageMs = Date.now() - t;
  return ageMs >= STALE_DAYS * 24 * 60 * 60 * 1000;
};
