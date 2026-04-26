import { useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import type { Job } from './types';

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

const COMMENT_MAX = 2000;
const COMMENT_AUTOSAVE_MS = 600;

/**
 * Floating popover with three quick actions for one row:
 *   - applied toggle (mirrors the row's checkbox)
 *   - 1–5 star rating (persisted to results.json via /api/corpus/rate)
 *   - delete (with single-click confirm — second click commits)
 *
 * Click-outside or Escape dismisses. The actual "open in new tab" still
 * happens at the call site (JobsTable) — this popover is purely the
 * follow-up actions menu.
 */
export const JobActionsPopover = ({
  job, isApplied, onToggleApplied, onRate, onDelete, anchorRef, onClose,
}: Props) => {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  // Local optimistic rating — instant visual feedback; the network call
  // is fire-and-forget. If the call fails we revert + show an inline error.
  const [rating, setRating] = useState<number | null>(job.rating ?? null);
  const [hoverRating, setHoverRating] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Comment editor state. `commentDraft` is what the user is typing;
  // `commentSaved` is the last value successfully persisted (used to
  // decide whether a blur/unmount flush actually has unsaved work).
  const [commentDraft, setCommentDraft] = useState<string>(job.comment ?? '');
  const [commentSaved, setCommentSaved] = useState<string>(job.comment ?? '');
  const [saveStatus, setSaveStatus] =
    useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const debounceRef = useRef<number | null>(null);
  const savedFadeRef = useRef<number | null>(null);
  // Stable refs for the unmount-flush callback so it always sees the
  // latest values without re-binding the cleanup effect.
  const draftRef = useRef(commentDraft);
  draftRef.current = commentDraft;
  const savedRef = useRef(commentSaved);
  savedRef.current = commentSaved;
  const ratingRef = useRef(rating);
  ratingRef.current = rating;

  // —— positioning: place popover beneath the anchor button ——
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  useEffect(() => {
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
  }, [anchorRef]);

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

  const handleRate = async (n: number | null) => {
    const previous = rating;
    setRating(n);
    setErr(null);
    // Don't touch the comment field — it's saved separately on its own
    // debounce / blur cycle.
    const r = await onRate(job.id, n);
    if (!r.ok) {
      setRating(previous);
      setErr(r.error || 'rate failed');
    }
  };

  // Persist the current comment draft. Used by both the debounced
  // autosave and the blur/unmount flush. No-op when nothing is dirty.
  const saveComment = useCallback(
    async (text: string) => {
      if (text === savedRef.current) return; // no change
      setSaveStatus('saving');
      // Empty (or whitespace-only) → null = clear server-side
      const payload: string | null = text.trim() === '' ? null : text;
      const r = await onRate(job.id, ratingRef.current, payload);
      if (r.ok) {
        setCommentSaved(text);
        setSaveStatus('saved');
        if (savedFadeRef.current) window.clearTimeout(savedFadeRef.current);
        savedFadeRef.current = window.setTimeout(
          () => setSaveStatus('idle'), 1500,
        );
      } else {
        setSaveStatus('error');
        setErr(r.error || 'comment save failed');
      }
    },
    [job.id, onRate],
  );

  // On unmount: flush any pending comment edit before the popover dies.
  // Best-effort (fire-and-forget — we can't await unmount).
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        window.clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      if (savedFadeRef.current) {
        window.clearTimeout(savedFadeRef.current);
        savedFadeRef.current = null;
      }
      if (draftRef.current !== savedRef.current) {
        void saveComment(draftRef.current);
      }
    };
  }, [saveComment]);

  const handleCommentChange = (text: string) => {
    setCommentDraft(text);
    setSaveStatus('idle');
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      void saveComment(text);
      debounceRef.current = null;
    }, COMMENT_AUTOSAVE_MS);
  };

  const handleCommentBlur = () => {
    if (debounceRef.current) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    void saveComment(commentDraft);
  };

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

      {/* 1–5 rating */}
      <div className="mt-2">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            Rate this option
          </span>
          {rating !== null && (
            <button
              type="button"
              onClick={() => void handleRate(null)}
              className="text-[11px] text-slate-400 hover:text-slate-700"
              title="Clear rating"
            >
              clear
            </button>
          )}
        </div>
        <div
          className="flex items-center gap-1"
          onMouseLeave={() => setHoverRating(null)}
        >
          {[1, 2, 3, 4, 5].map((n) => {
            const filled = (hoverRating ?? rating ?? 0) >= n;
            return (
              <button
                key={n}
                type="button"
                onClick={() => void handleRate(n)}
                onMouseEnter={() => setHoverRating(n)}
                className={clsx(
                  'flex h-7 w-7 items-center justify-center rounded text-lg leading-none transition-colors',
                  filled
                    ? 'text-amber-400 hover:text-amber-500'
                    : 'text-slate-300 hover:text-slate-400',
                )}
                title={`${n} star${n > 1 ? 's' : ''}`}
                aria-label={`Rate ${n} of 5`}
              >
                ★
              </button>
            );
          })}
        </div>
        <p className="mt-1 text-[10px] text-slate-400">
          Used to personalize future Claude scoring.
        </p>
      </div>

      {/* Comment */}
      <div className="mt-3">
        <div className="mb-1 flex items-center justify-between">
          <label
            htmlFor={`comment-${job.id}`}
            className="text-[11px] font-semibold uppercase tracking-wider text-slate-500"
          >
            Comment
          </label>
          <span
            className={clsx(
              'text-[10px]',
              saveStatus === 'saving' && 'text-slate-400',
              saveStatus === 'saved' && 'text-emerald-600',
              saveStatus === 'error' && 'text-red-600',
              saveStatus === 'idle' && 'text-slate-300',
            )}
          >
            {saveStatus === 'saving' && 'saving…'}
            {saveStatus === 'saved' && 'saved'}
            {saveStatus === 'error' && 'save failed'}
            {saveStatus === 'idle' && commentDraft !== commentSaved && 'unsaved'}
            {saveStatus === 'idle' && commentDraft === commentSaved &&
              `${commentDraft.length}/${COMMENT_MAX}`}
          </span>
        </div>
        <textarea
          id={`comment-${job.id}`}
          value={commentDraft}
          onChange={(e) => handleCommentChange(e.target.value.slice(0, COMMENT_MAX))}
          onBlur={handleCommentBlur}
          rows={3}
          placeholder="Why this rating? Anything to remember about this role…"
          className="w-full resize-y rounded border border-slate-200 px-2 py-1.5 text-xs text-slate-800 placeholder:text-slate-300 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        />
      </div>

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
    </div>
  );
};
