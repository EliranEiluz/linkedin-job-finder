import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import type { Job } from './types';
import { RatingCommentEditor } from './RatingCommentEditor';
import { useViewport } from './useViewport';

interface Props {
  job: Job;
  isApplied: boolean;
  // Apply / unapply are now explicit buttons (not a checkbox). The Apply
  // path takes a `moveToEnd` choice — see "Apply behaviour" below.
  onApply: (id: string, moveToEnd: boolean) => void;
  onUnapply: (id: string) => void;
  // Push this row to the end of the sort WITHOUT marking it applied.
  // For "I don't want to deal with this now" — distinct from Apply.
  // Local-only override; clears on full page reload.
  onPushToEnd?: (id: string) => void;
  // Global preference for whether Apply moves the row to the end of the
  // corpus. `null` = unset (user has not made an explicit choice yet — we
  // show both buttons every time + a "Remember" checkbox). `true|false` =
  // remembered choice (we show one button + a "change" footer link).
  applyMovesToEnd: boolean | null;
  onSetApplyPref: (v: boolean | null) => void;
  // `comment` is optional: undefined leaves it untouched, null clears it,
  // string sets it (server caps at 2000 chars).
  onRate: (
    id: string,
    rating: number | null,
    comment?: string | null,
  ) => Promise<{ ok: boolean; error?: string }>;
  onDelete: (id: string) => Promise<{ ok: boolean; error?: string }>;
  // Anchor element the popover positions itself relative to. Required so
  // the popover floats next to the button that triggered it.
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
}

/**
 * Floating popover with three quick actions for one row:
 *   - Apply / Unapply (explicit buttons; first-time prompt for "move to end")
 *   - 1–5 star rating + free-text comment (via <RatingCommentEditor />)
 *   - delete (with single-click confirm — second click commits)
 *
 * Click-outside or Escape dismisses. The actual "open in new tab" still
 * happens at the call site (JobsTable) — this popover is purely the
 * follow-up actions menu.
 *
 * The rating + comment block is the shared <RatingCommentEditor /> — same
 * component used by ApplicationsPage's card-detail modal and JobsTable's
 * expanded-row panel. All three write to the same results.json fields.
 */
export const JobActionsPopover = ({
  job, isApplied, onApply, onUnapply, onPushToEnd, applyMovesToEnd, onSetApplyPref,
  onRate, onDelete, anchorRef, onClose,
}: Props) => {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Default-checked "Remember my choice" toggle. Only used the first time
  // (i.e. when `applyMovesToEnd === null`); once the user picks, we write
  // the pref iff this is still ticked.
  const [remember, setRemember] = useState(true);
  const { isMobile } = useViewport();

  // —— positioning: desktop pins beneath the anchor; mobile renders as a
  // centered bottom-sheet (no anchor math needed). On mobile we set a
  // sentinel `coords` value so the early-return below still works.
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  useEffect(() => {
    if (isMobile) {
      setCoords({ top: 0, left: 0 });
      return;
    }
    const compute = () => {
      const el = anchorRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      // Below the anchor by 6px, right-aligned to the anchor.
      const top = rect.bottom + 6;
      const right = window.innerWidth - rect.right;
      setCoords({ top, left: window.innerWidth - right - 256 /* popover width */ });
    };
    compute();
    window.addEventListener('resize', compute);
    window.addEventListener('scroll', compute, true);
    return () => {
      window.removeEventListener('resize', compute);
      window.removeEventListener('scroll', compute, true);
    };
  }, [anchorRef, isMobile]);

  // —— click-outside + Esc ——
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popoverRef.current?.contains(t)) return;
      if (anchorRef.current?.contains(t)) return; // re-clicking anchor handled there
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchorRef, onClose]);

  const handleDelete = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      // Auto-revert confirm state after 4s if not clicked again.
      window.setTimeout(() => setConfirmDelete(false), 4000);
      return;
    }
    setDeleting(true);
    setErr(null);
    const r = await onDelete(job.id);
    setDeleting(false);
    if (!r.ok) {
      setErr(r.error || 'delete failed');
      setConfirmDelete(false);
      return;
    }
    onClose();
  };

  // Resolves what to do when the user clicks an Apply button. Writes the
  // pref only when the user EXPLICITLY chose for the first time AND the
  // Remember box is still ticked.
  const handleApply = (moveToEnd: boolean) => {
    if (applyMovesToEnd === null && remember) {
      onSetApplyPref(moveToEnd);
    }
    onApply(job.id, moveToEnd);
  };

  if (!coords) return null;

  // Mobile: centered bottom-sheet with backdrop. The desktop floating popover
  // model breaks at narrow widths (the anchor math clamps to left:8 and the
  // 256px card overlays the next row). A bottom-sheet with a backdrop keeps
  // it modal, full-width minus 24px gutters, and tap-target friendly.
  if (isMobile) {
    return (
      <>
        <div
          className="fixed inset-0 z-40 bg-slate-900/40"
          onClick={onClose}
          aria-hidden="true"
        />
        <div
          ref={popoverRef}
          role="dialog"
          aria-label="Job actions"
          aria-modal="true"
          onClick={(e) => e.stopPropagation()}
          className="fixed inset-x-3 bottom-3 z-50 rounded-lg border border-slate-200 bg-white p-3 shadow-2xl"
        >
          <PopoverBody
            job={job}
            isApplied={isApplied}
            onApply={handleApply}
            onUnapply={onUnapply}
            onPushToEnd={onPushToEnd}
            applyMovesToEnd={applyMovesToEnd}
            onSetApplyPref={onSetApplyPref}
            remember={remember}
            setRemember={setRemember}
            onRate={onRate}
            onClose={onClose}
            confirmDelete={confirmDelete}
            deleting={deleting}
            err={err}
            handleDelete={handleDelete}
          />
        </div>
      </>
    );
  }

  return (
    <div
      ref={popoverRef}
      role="dialog"
      aria-label="Job actions"
      onClick={(e) => e.stopPropagation()}
      style={{
        position: 'fixed',
        top: coords.top,
        left: Math.max(8, coords.left),
        width: 256,
      }}
      className="z-50 rounded-lg border border-slate-200 bg-white p-3 shadow-xl"
    >
      <PopoverBody
        job={job}
        isApplied={isApplied}
        onApply={handleApply}
        onUnapply={onUnapply}
        applyMovesToEnd={applyMovesToEnd}
        onSetApplyPref={onSetApplyPref}
        remember={remember}
        setRemember={setRemember}
        onRate={onRate}
        onClose={onClose}
        confirmDelete={confirmDelete}
        deleting={deleting}
        err={err}
        handleDelete={handleDelete}
      />
    </div>
  );
};

// Shared body extracted so the desktop floating popover and mobile bottom
// sheet render the exact same content — same Apply buttons, rating editor,
// and delete button. Only the wrapper (positioning + backdrop) differs.
const PopoverBody = ({
  job, isApplied, onApply, onUnapply, onPushToEnd, applyMovesToEnd, onSetApplyPref,
  remember, setRemember, onRate, onClose,
  confirmDelete, deleting, err, handleDelete,
}: {
  job: Job;
  isApplied: boolean;
  onApply: (moveToEnd: boolean) => void;
  onUnapply: (id: string) => void;
  onPushToEnd?: (id: string) => void;
  applyMovesToEnd: boolean | null;
  onSetApplyPref: (v: boolean | null) => void;
  remember: boolean;
  setRemember: (v: boolean) => void;
  onRate: Props['onRate'];
  onClose: () => void;
  confirmDelete: boolean;
  deleting: boolean;
  err: string | null;
  handleDelete: () => Promise<void>;
}) => {
  return (
    <>
      <div className="mb-1 flex items-start justify-between">
        <div className="min-w-0 pr-2">
          <div className="truncate text-xs font-medium text-slate-800">
            {job.title}
          </div>
          <div className="truncate text-[11px] text-slate-500">{job.company}</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="-mr-1 rounded px-1 text-slate-400 hover:text-slate-700"
          aria-label="Close"
        >
          ×
        </button>
      </div>

      {/* Apply / Unapply block. Three render paths:
          - Already applied: single "Mark as not applied" button.
          - Not applied + pref unset: two buttons + "Remember" checkbox.
          - Not applied + pref set: single button (matches the pref) +
            footer "change" link to reset.
          Mark-unapplied never reorders, so it never prompts. */}
      <div className="mt-2 flex flex-col gap-1.5">
        {isApplied ? (
          <button
            type="button"
            onClick={() => onUnapply(job.id)}
            className="inline-flex w-full items-center justify-center rounded border border-slate-300 bg-white px-2 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            Mark as not applied
          </button>
        ) : applyMovesToEnd === null ? (
          <>
            <button
              type="button"
              onClick={() => onApply(true)}
              className="inline-flex w-full items-center justify-center rounded border border-emerald-600 bg-emerald-600 px-2 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
            >
              Apply and move to end
            </button>
            <button
              type="button"
              onClick={() => onApply(false)}
              className="inline-flex w-full items-center justify-center rounded border border-slate-300 bg-white px-2 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              Apply but keep in place
            </button>
            <label className="mt-0.5 inline-flex cursor-pointer items-center gap-1.5 self-start text-[11px] text-slate-600">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                className="h-3 w-3 cursor-pointer rounded border-slate-300 text-brand-700 focus:ring-brand-700"
              />
              Remember my choice
            </label>
          </>
        ) : (
          <button
            type="button"
            onClick={() => onApply(applyMovesToEnd)}
            className="inline-flex w-full items-center justify-center rounded border border-emerald-600 bg-emerald-600 px-2 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
          >
            {applyMovesToEnd ? 'Apply and move to end' : 'Apply but keep in place'}
          </button>
        )}
        {/* "Move to end without applying" — for rows the user wants to
            demote from view but isn't ready to mark applied. Local-only;
            survives until full-page reload. Only renders when not yet
            applied (an applied row's sort already handled by Apply
            choice). */}
        {!isApplied && onPushToEnd && (
          <button
            type="button"
            onClick={() => { onPushToEnd(job.id); onClose(); }}
            className="mt-1 self-start text-[11px] font-medium text-slate-500 hover:text-brand-700"
            title="Sort this row to the bottom without marking it applied"
          >
            ↓ Move to end without applying
          </button>
        )}
      </div>

      {/* Shared rating + comment editor — same component used by the
          tracker modal and the corpus row-expanded panel. */}
      <RatingCommentEditor
        jobId={job.id}
        initialRating={job.rating ?? null}
        initialComment={job.comment ?? null}
        onSave={(rating, comment) => onRate(job.id, rating, comment)}
      />

      {/* Delete */}
      <div className="mt-3 border-t border-slate-100 pt-2">
        <button
          type="button"
          disabled={deleting}
          onClick={() => void handleDelete()}
          className={clsx(
            'w-full rounded px-2 py-1.5 text-xs font-medium transition-colors',
            confirmDelete
              ? 'bg-red-600 text-white hover:bg-red-700'
              : 'border border-red-200 bg-white text-red-700 hover:bg-red-50',
            deleting && 'cursor-not-allowed opacity-50',
          )}
          title={
            confirmDelete
              ? 'Click again to confirm permanent delete'
              : 'Delete from the corpus (also pinned in seen so it won\'t re-appear)'
          }
        >
          {deleting
            ? 'Deleting…'
            : confirmDelete
            ? 'Click again to confirm'
            : 'Delete from corpus'}
        </button>
      </div>

      {/* Apply-behaviour footer link — only when a pref is set. Click
          clears the pref so the next Apply prompts again. */}
      {!isApplied && applyMovesToEnd !== null && (
        <div className="mt-2 text-[11px] text-slate-500">
          Apply behaviour: {applyMovesToEnd ? 'move to end' : 'keep in place'}
          {' · '}
          <button
            type="button"
            onClick={() => onSetApplyPref(null)}
            className="text-brand-700 hover:underline"
          >
            change
          </button>
        </div>
      )}

      {err && (
        <div className="mt-2 rounded bg-red-50 px-2 py-1 text-[11px] text-red-700">
          {err}
        </div>
      )}
    </>
  );
};
