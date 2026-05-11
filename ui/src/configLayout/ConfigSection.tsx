// Responsive wrapper for one Crawler Config sub-section (#117).
//
// Two render modes:
//   - Desktop (>=md): ALWAYS open; the parent's sub-nav rail decides
//     which single section is visible. We render a section header
//     (label + subtitle) and the children stacked underneath.
//   - Mobile (<md): collapsible accordion. Uses the shared
//     CollapsibleCard for the header affordance and persists its
//     open/closed state to localStorage under
//     `crawler_config_section_open_<id>`.
//
// The desktop mode does NOT use CollapsibleCard because the left-rail
// already serves as the sub-section selector — wrapping each section in
// a second collapsible would conflict with that.

import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { CollapsibleCard } from './CollapsibleCard';
import {
  ACCORDION_DEFAULT_OPEN,
  sectionAccordionLsKey,
  type ConfigSectionId,
  type ConfigSectionMeta,
} from './types';

export interface ConfigSectionProps {
  meta: ConfigSectionMeta;
  /** True on mobile (<md). Driven by the parent's useViewport. */
  mobile: boolean;
  /** True for the section currently selected by the desktop sub-nav. */
  active: boolean;
  /** Summary chip shown next to the title (e.g. "3 channels"). */
  summary?: React.ReactNode;
  /** Right-of-title slot (always visible). Used for status badges etc. */
  right?: React.ReactNode;
  /** Renders a tiny brand-700 dot next to the title (unsaved input). */
  dirty?: boolean;
  children: React.ReactNode;
}

const readPersisted = (id: ConfigSectionId): boolean | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(sectionAccordionLsKey(id));
    if (raw === 'true') return true;
    if (raw === 'false') return false;
  } catch {
    /* private mode / quota — fall back */
  }
  return null;
};

export const ConfigSection = ({
  meta,
  mobile,
  active,
  summary,
  right,
  dirty,
  children,
}: ConfigSectionProps) => {
  // Mobile accordion: own its open state with localStorage persistence.
  // Initial paint reads localStorage first (returning user), then falls
  // back to ACCORDION_DEFAULT_OPEN (first paint).
  const [mobileOpen, setMobileOpen] = useState<boolean>(() => {
    const persisted = readPersisted(meta.id);
    return persisted ?? ACCORDION_DEFAULT_OPEN[meta.id];
  });

  // Persist the mobile open state. Desktop mode doesn't write — it
  // doesn't drive the state, so we'd be persisting stale defaults.
  useEffect(() => {
    if (!mobile) return;
    try {
      window.localStorage.setItem(
        sectionAccordionLsKey(meta.id),
        mobileOpen ? 'true' : 'false',
      );
    } catch {
      /* silent */
    }
  }, [mobile, meta.id, mobileOpen]);

  if (mobile) {
    // The summary chip is rendered ONLY while collapsed — once open the
    // cards inside surface the same info. dirty dot is always visible.
    return (
      <CollapsibleCard
        title={meta.label}
        subtitle={meta.subtitle}
        open={mobileOpen}
        onOpenChange={setMobileOpen}
        summary={summary}
        right={right}
        dirty={dirty}
        // Anchor for scrollIntoView from the sub-nav row click and for
        // browser back/forward hash navigation.
        className={clsx('scroll-mt-16')}
      >
        <div id={`config-section-${meta.id}`} className="space-y-4">
          {children}
        </div>
      </CollapsibleCard>
    );
  }

  // Desktop: only the active section renders. ConfigPage gates this
  // via `active` to avoid mounting all three sections at once (would
  // double the API fetches in cards that pre-fetch on mount).
  if (!active) return null;
  return (
    <section
      id={`config-section-${meta.id}`}
      aria-label={meta.label}
      className="scroll-mt-16"
    >
      <header className="mb-3 flex items-baseline gap-3">
        <h1 className="text-base font-semibold text-slate-800">
          {meta.label}
        </h1>
        {dirty && (
          <span
            aria-label="Unsaved changes"
            title="Unsaved changes in this section"
            className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-brand-700"
          />
        )}
        {right && <span className="ml-auto">{right}</span>}
      </header>
      <p className="mb-4 text-xs text-slate-500">{meta.subtitle}</p>
      <div className="space-y-4">{children}</div>
    </section>
  );
};
