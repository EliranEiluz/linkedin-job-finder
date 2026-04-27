import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import type { Job } from './types';
import { RatingCommentEditor } from './RatingCommentEditor';
import { useViewport } from './useViewport';

interface Props {
  job: Job;
  isApplied: boolean;
  onToggleApplied: (id: string) => void;
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
 *   - applied toggle (mirrors the row's checkbox)
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
  job, isApplied, onToggleApplied, onRate, onDelete, anchorRef, onClose,
}: Props) => {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
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
            onToggleApplied={onToggleApplied}
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
        onToggleApplied={onToggleApplied}
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
// sheet render the exact same content — same checkbox, rating editor, and
// delete button. Only the wrapper (positioning + backdrop) differs.
const PopoverBody = ({
  job, isApplied, onToggleApplied, onRate, onClose,
  confirmDelete, deleting, err, handleDelete,
}: {
  job: Job;
  isApplied: boolean;
  onToggleApplied: (id: string) => void;
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

      {/* Applied toggle */}
      <label className="mt-2 flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-slate-50">
        <input
          type="checkbox"
          checked={isApplied}
          onChange={() => onToggleApplied(job.id)}
          className="h-3.5 w-3.5 cursor-pointer rounded border-slate-300 text-emerald-600 focus:ring-emerald-600"
        />
        <span className="text-slate-700">Mark as applied</span>
      </label>

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

      {err && (
        <div className="mt-2 rounded bg-red-50 px-2 py-1 text-[11px] text-red-700">
          {err}
        </div>
      )}
    </>
  );
};
