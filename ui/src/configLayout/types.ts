// Shared types for the Crawler Config sub-section layout (#117).
// Pulled out so ConfigSubNav, ConfigSection, and ConfigPage all agree on
// the three buckets without re-declaring the string union.

export type ConfigSectionId = 'run' | 'pipeline' | 'search';

export interface ConfigSectionMeta {
  id: ConfigSectionId;
  label: string;
  /** Short label used by the desktop left rail when room is tight. */
  short: string;
  /** Inline help — one sentence shown under the section header. */
  subtitle: string;
}

// Tuple type (not just `[]`) so `CONFIG_SECTIONS[0]` is known to be a
// real ConfigSectionMeta rather than `ConfigSectionMeta | undefined`
// under `noUncheckedIndexedAccess`. The three slots are stable per
// the section layout and aren't expected to grow without a UI rework.
export const CONFIG_SECTIONS: readonly [
  ConfigSectionMeta,
  ConfigSectionMeta,
  ConfigSectionMeta,
] = [
  {
    id: 'run',
    label: 'Run & Infra',
    short: 'Run',
    subtitle:
      "Kick off scrapes, schedule them, expose the dashboard, decide where digests get delivered.",
  },
  {
    id: 'pipeline',
    label: 'AI Pipeline',
    short: 'Pipeline',
    subtitle:
      'Pick the LLM that scores jobs against your CV, filter low-fit results, tune the scoring prompt.',
  },
  {
    id: 'search',
    label: 'Search Shape',
    short: 'Search',
    subtitle:
      'What LinkedIn sees on every query: keywords, priority companies, region, recency window.',
  },
];

export const DEFAULT_SECTION: ConfigSectionId = 'run';

// LocalStorage key per-section for the mobile accordion's open/closed
// memory. Kept here so the keys live next to the type that derives them.
export const sectionAccordionLsKey = (id: ConfigSectionId): string =>
  `crawler_config_section_open_${id}`;

// First-visit accordion defaults (mobile only). Run & Infra opens; the
// other two stay closed so a phone user lands on the most relevant
// scroll-position immediately. Desktop ignores this — the left rail
// just renders the active section.
export const ACCORDION_DEFAULT_OPEN: Record<ConfigSectionId, boolean> = {
  run: true,
  pipeline: false,
  search: false,
};
