// Shared save-changes bar for the Crawler Config tab.
//
// Lifted out of ConfigPage.tsx so the bar's positioning, animation,
// and keyboard-shortcut concerns live in one place. The component
// owns NO save logic of its own — `onSave` / `onDiscard` /
// `onResetDefaults` are passed in and the parent decides what those
// mean.
//
// Positioning:
//   The previous implementation used `position: sticky; bottom: 0`
//   INSIDE the page's scroll container. On mobile, when the scroll
//   container's content was short OR the user was scrolled mid-page,
//   the bar would render in content flow — visually "in the middle of
//   the page" — instead of pinned to the viewport bottom. We now use
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
// iOS safe area:
//   Anchored above the home indicator on notched iPhones via inline
//   `padding-bottom: max(env(safe-area-inset-bottom), 12px)`. Requires
//   `viewport-fit=cover` in index.html (already set). On non-notched
//   devices env() returns 0 so the 12px floor keeps the visual gap.
//   We also tag the outer element with a `save-changes-bar--safe-area`
//   class so unit tests can assert the safe-area treatment was applied
//   (jsdom / happy-dom can't compute env() at runtime, but they CAN
//   verify the class hook is on the node).
//
// Animation:
//   Slide-up + fade on enter (~150ms), slide-down + fade on exit.
//   The `mounted` / `visible` two-state dance lets the CSS exit
//   transition play out before we unmount the node. Honors the user's
//   prefers-reduced-motion via Tailwind's motion-reduce variant.
//
// Keyboard shortcut:
//   Cmd-S (mac) / Ctrl-S (Win/Linux) triggers save when the bar is
//   dirty and not currently saving. preventDefault on the browser's
//   "Save Page" handler. No-op when not dirty (we let the browser
//   default through so power-users who actually want "Save Page As"
//   can still get it on a clean form).
//
// "Saved ✓" flash:
//   After a successful save, the Save button shows "Saved ✓" for
//   1500ms before the bar animates out. Matches the polish in #117
//   (CollapsibleCard / NotificationsCard saved indicators) for
//   consistent confirmation UX across the config tab.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import clsx from 'clsx';

export interface SaveChangesBarProps {
  /** True when the draft differs from the saved config. Drives visibility. */
  dirty: boolean;
  /** True while the parent's save POST is in flight. Disables buttons. */
  saving: boolean;
  /**
   * Invoked on click of the Save button OR Cmd-S / Ctrl-S. Should
   * resolve when the write completes so we can flash "Saved ✓". If
   * onSave throws, we suppress the flash (the parent toasts the error)
   * and leave the bar visible so the user can retry.
   */
  onSave: () => Promise<void> | void;
  /** Invoked on click of Discard. Should restore the draft to the saved config. */
  onDiscard: () => void;
  /** Invoked on click of Reset to defaults. */
  onResetDefaults: () => void;
}

// How long the "Saved ✓" inline flash stays on the Save button after a
// successful save. Mirrors the saved-indicator timing used elsewhere
// in the config polish so the app feels consistent.
const SAVED_FLASH_MS = 1500;

// Slide / fade animation duration. ~150ms keeps it snappy and inside
// the duration band the rest of the config polish uses (CollapsibleCard
// chevron rotate = 150ms, grid-rows collapse = 150ms).
const ANIMATION_MS = 150;

export const SaveChangesBar = ({
  dirty,
  saving,
  onSave,
  onDiscard,
  onResetDefaults,
}: SaveChangesBarProps) => {
  // Two-state dance so the EXIT animation has time to play before the
  // node is removed from the DOM. `mounted` is the lifecycle flag;
  // `visible` is the animation-class flag.
  //
  //   dirty=true  -> mounted=true, visible=true   (slide in)
  //   dirty=false -> visible=false (slide out) then mounted=false (unmount)
  const [mounted, setMounted] = useState<boolean>(dirty);
  const [visible, setVisible] = useState<boolean>(dirty);
  const [showSavedFlash, setShowSavedFlash] = useState<boolean>(false);
  const exitTimerRef = useRef<number | null>(null);
  const flashTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (dirty) {
      // Cancel any in-flight unmount from a previous discard/save.
      if (exitTimerRef.current !== null) {
        window.clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
      }
      setMounted(true);
      // RequestAnimationFrame so the initial `visible=false` paint
      // lands before we flip to true — otherwise the browser collapses
      // the two state changes and the slide-in animation skips.
      const id = window.requestAnimationFrame(() => {
        setVisible(true);
      });
      return () => { window.cancelAnimationFrame(id); };
    }
    // Not dirty: play the exit animation, then unmount.
    setVisible(false);
    exitTimerRef.current = window.setTimeout(() => {
      setMounted(false);
      exitTimerRef.current = null;
    }, ANIMATION_MS);
    return () => {
      if (exitTimerRef.current !== null) {
        window.clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
      }
    };
  }, [dirty]);

  // Cleanup the saved-flash timer on unmount.
  useEffect(() => {
    return () => {
      if (flashTimerRef.current !== null) {
        window.clearTimeout(flashTimerRef.current);
        flashTimerRef.current = null;
      }
    };
  }, []);

  // Save wrapper — awaits the parent's onSave so we can flash the
  // confirmation. Swallows errors here so the rejection doesn't
  // surface as an unhandled promise — the parent already toasts.
  const handleSave = useCallback(async () => {
    try {
      await onSave();
      setShowSavedFlash(true);
      if (flashTimerRef.current !== null) {
        window.clearTimeout(flashTimerRef.current);
      }
      flashTimerRef.current = window.setTimeout(() => {
        setShowSavedFlash(false);
        flashTimerRef.current = null;
      }, SAVED_FLASH_MS);
    } catch {
      // Parent toasted; no flash on failure. Leave the bar visible so
      // the user can retry.
    }
  }, [onSave]);

  // Cmd-S / Ctrl-S global shortcut. Listens at the window level so it
  // fires regardless of which input is focused. Only acts when the bar
  // is dirty AND not currently saving — otherwise the browser default
  // ("Save page as…") is allowed through, which is the polite thing
  // to do on a clean form.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // metaKey covers Cmd on macOS; ctrlKey covers Ctrl on Win/Linux.
      // Reject combos with Shift / Alt — Cmd-Shift-S is conventionally
      // "Save As" / "Save All" and stealing it would be rude.
      const isSaveCombo =
        (e.metaKey || e.ctrlKey)
        && !e.shiftKey
        && !e.altKey
        && (e.key === 's' || e.key === 'S');
      if (!isSaveCombo) return;
      if (!dirty || saving) return;
      e.preventDefault();
      void handleSave();
    };
    window.addEventListener('keydown', handler);
    return () => { window.removeEventListener('keydown', handler); };
  }, [dirty, saving, handleSave]);

  if (!mounted) return null;

  return (
    <div
      role="region"
      aria-label="Unsaved changes"
      aria-keyshortcuts="Meta+S Control+S"
      data-testid="save-changes-bar"
      data-visible={visible ? 'true' : 'false'}
      className={clsx(
        // Anchored to the viewport bottom on every breakpoint — NOT
        // sticky-in-scroll-container. z-40 sits above page content
        // but below toast (z-50) and any modal.
        'fixed inset-x-0 bottom-0 z-40',
        'border-t border-slate-200 bg-white shadow-[0_-2px_8px_-2px_rgba(15,23,42,0.08)]',
        // Class hook for safe-area-inset, so tests can assert the
        // treatment is in place even though happy-dom can't compute
        // env(). The actual padding-bottom is set via inline style
        // below.
        'save-changes-bar--safe-area',
        // Slide-up + fade animation. transition is on transform +
        // opacity only (both GPU-accelerated). motion-reduce honors
        // the user's a11y preference.
        'transition-[transform,opacity] duration-150 ease-out motion-reduce:transition-none',
        visible
          ? 'translate-y-0 opacity-100'
          : 'pointer-events-none translate-y-full opacity-0',
      )}
      style={{
        // env(safe-area-inset-bottom) is 0 on non-notched devices; the
        // max() floor ensures the bar always has a comfortable
        // tap-margin above the screen edge. 12px matches the visual
        // padding we used pre-fix (py-3 = 12px) so the bar's apparent
        // height is unchanged on Android / desktop.
        paddingBottom: 'max(env(safe-area-inset-bottom), 12px)',
      }}
    >
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-2 px-4 pt-3">
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
            onClick={() => void handleSave()}
            disabled={saving}
            data-testid="save-changes-bar-save"
            className="min-h-[44px] rounded bg-brand-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? (
              'Saving…'
            ) : showSavedFlash ? (
              <span>Saved ✓</span>
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
