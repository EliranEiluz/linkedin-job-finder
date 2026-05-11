// Desktop-only left-rail sub-nav for the Crawler Config tab (#117).
// Renders as a sticky vertical list at md+; on mobile (<md) the parent
// ConfigPage uses ConfigSection in accordion mode and this component is
// hidden entirely.
//
// State model: the ACTIVE section is a controlled prop driven by
// ConfigPage's hash router (#run / #pipeline / #search). The summary
// chip / dirty dot per row are owned by the parent — this component is
// purely presentational.

import clsx from 'clsx';
import { CONFIG_SECTIONS, type ConfigSectionId } from './types';

export interface ConfigSubNavProps {
  active: ConfigSectionId;
  onChange: (next: ConfigSectionId) => void;
  /**
   * Per-section right-of-label chip rendered inside each rail row. Used
   * for summary chips (e.g. "3 channels", "Auto") and dirty-section
   * dots. ConfigPage computes these from the draft config and threads
   * them through.
   */
  summaries?: Partial<Record<ConfigSectionId, React.ReactNode>>;
  dirty?: Partial<Record<ConfigSectionId, boolean>>;
}

export const ConfigSubNav = ({
  active,
  onChange,
  summaries,
  dirty,
}: ConfigSubNavProps) => {
  return (
    <nav
      aria-label="Configuration sections"
      className="hidden w-44 shrink-0 md:block"
    >
      <ul className="sticky top-2 flex flex-col gap-1">
        {CONFIG_SECTIONS.map((s) => {
          const isActive = s.id === active;
          const summary = summaries?.[s.id];
          const isDirty = dirty?.[s.id] ?? false;
          return (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => { onChange(s.id); }}
                aria-current={isActive ? 'page' : undefined}
                className={clsx(
                  'group flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors duration-150',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-300',
                  isActive
                    ? 'border-brand-200 bg-brand-50 font-medium text-brand-800'
                    : 'border-transparent bg-transparent text-slate-600 hover:bg-slate-100 hover:text-slate-900',
                )}
              >
                <span className="flex-1 truncate">{s.label}</span>
                {isDirty && (
                  <span
                    aria-label="Unsaved changes"
                    title="Unsaved changes in this section"
                    className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-brand-700"
                  />
                )}
                {summary && (
                  <span className="ml-1 inline-flex items-center text-[11px] text-slate-500">
                    {summary}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
};
