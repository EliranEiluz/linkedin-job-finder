// Shared save-changes bar for the Crawler Config tab.
//
// Lifted out of ConfigPage.tsx so the bar's positioning, animation,
// and (in a follow-up commit) keyboard-shortcut concerns live in one
// place. The component owns NO save logic of its own — `onSave` /
// `onDiscard` / `onResetDefaults` are passed in and the parent decides
// what those mean.
//
// This first refactor commit is intentionally behavior-preserving:
//   - Same `sticky bottom-0` positioning as before (still buggy on
//     mobile — fixed in the next commit).
//   - Same disabled-state rules, same labels, same min-h-[44px] tap
//     targets.
//   - No animation, no Cmd-S, no safe-area-inset yet.
//
// Subsequent commits will:
//   - Pin the bar to the viewport bottom via `position: fixed` so it
//     stops drifting into mid-page on mobile.
//   - Add slide-up + fade animation, env(safe-area-inset-bottom), and
//     Cmd-S / Ctrl-S keyboard shortcut.

import clsx from 'clsx';

export interface SaveChangesBarProps {
  /** True when the draft differs from the saved config. Drives visibility / disabled state. */
  dirty: boolean;
  /** True while the parent's save POST is in flight. Disables buttons. */
  saving: boolean;
  /** Invoked on click of the Save button. */
  onSave: () => void;
  /** Invoked on click of Discard. Should restore the draft to the saved config. */
  onDiscard: () => void;
  /** Invoked on click of Reset to defaults. */
  onResetDefaults: () => void;
}

export const SaveChangesBar = ({
  dirty,
  saving,
  onSave,
  onDiscard,
  onResetDefaults,
}: SaveChangesBarProps) => {
  return (
    <div
      data-testid="save-changes-bar"
      className={clsx(
        // Pre-fix: still sticky-in-scroll-container. Will be replaced
        // with `position: fixed` in the next commit.
        'sticky bottom-0 -mx-4 flex items-center justify-between gap-2 border-t border-slate-200 bg-white px-4 py-3',
      )}
    >
      <button
        type="button"
        onClick={onResetDefaults}
        className="min-h-[44px] rounded border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:border-amber-400 hover:text-amber-700"
        title="Replace draft with the in-file defaults"
      >
        <span className="md:hidden">Reset</span>
        <span className="hidden md:inline">Reset to defaults</span>
      </button>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onDiscard}
          disabled={!dirty || saving}
          className="min-h-[44px] rounded border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Discard
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={!dirty || saving}
          data-testid="save-changes-bar-save"
          className="min-h-[44px] rounded bg-brand-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? (
            'Saving…'
          ) : (
            <>
              <span className="md:hidden">Save</span>
              <span className="hidden md:inline">Save changes</span>
            </>
          )}
        </button>
      </div>
    </div>
  );
};
