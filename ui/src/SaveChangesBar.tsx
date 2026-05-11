// Shared save-changes bar for the Crawler Config tab.
//
// Lifted out of ConfigPage.tsx so the bar's positioning, animation,
// and (in a follow-up commit) keyboard-shortcut concerns live in one
// place. The component owns NO save logic of its own — `onSave` /
// `onDiscard` / `onResetDefaults` are passed in and the parent decides
// what those mean.
//
// Positioning (the bug fix in this commit):
//   The previous implementation used `position: sticky; bottom: 0`
//   INSIDE the page's scroll container. On mobile, when the scroll
//   container's content was short OR the user was scrolled mid-page,
//   the bar would render in content flow — visually "in the middle of
//   the page" — instead of pinned to the viewport bottom. The fix is
//   `position: fixed` to the VIEWPORT bottom on both mobile and
//   desktop.
//
//   We deliberately do NOT use `sticky` because (a) sticky misbehaves
//   under the iOS virtual keyboard — Mobile Safari treats sticky-bottom
//   as static when the keyboard is open — and (b) sticky is constrained
//   by its ancestor scroll container, which is exactly the bug we're
//   fixing. `position: fixed` anchors to the visual viewport on every
//   modern browser and is unaffected by ancestor overflow.
//
// Subsequent commits will:
//   - Add slide-up + fade animation.
//   - Respect env(safe-area-inset-bottom) on notched iOS.
//   - Wire Cmd-S / Ctrl-S keyboard shortcut.

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
  // Bar is now hidden when clean — previously the inline JSX always
  // rendered (just with disabled buttons), but with `position: fixed`
  // that would mean an always-visible empty action strip floating over
  // every page bottom. Hiding-when-clean is also what the brief asks
  // for so the dirty/clean distinction stays sharp.
  if (!dirty) return null;

  return (
    <div
      data-testid="save-changes-bar"
      className={clsx(
        // Anchored to the viewport bottom on every breakpoint — NOT
        // sticky-in-scroll-container. z-40 sits above page content but
        // below toast (z-50) and any modal.
        'fixed inset-x-0 bottom-0 z-40',
        'border-t border-slate-200 bg-white shadow-[0_-2px_8px_-2px_rgba(15,23,42,0.08)]',
      )}
    >
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-2 px-4 py-3">
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
            disabled={saving}
            className="min-h-[44px] rounded border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Discard
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={saving}
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
    </div>
  );
};
