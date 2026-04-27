import { useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';

// Server cap for the rating comment field. Mirrors corpus_ctl.py rate's
// 2000-char truncation — keep these in sync.
const COMMENT_MAX = 2000;
const COMMENT_AUTOSAVE_MS = 600;

export interface RatingCommentEditorProps {
  jobId: string;
  initialRating: number | null;
  initialComment: string | null;
  // Tri-state on the wire — undefined = don't touch the comment, null =
  // clear it, string = set it. Mirrors useCorpusActions().rateJob.
  onSave: (
    rating: number | null,
    comment?: string | null,
  ) => Promise<{ ok: boolean; error?: string }>;
  // Hide the rating row entirely (future-proofing — we don't currently
  // use this anywhere, but it lets a "comment-only" surface drop in).
  showRating?: boolean;
  // Override the textarea row count (default 3). The compact density
  // variant lowers this to 2.
  textareaRows?: number;
  // Visual density. `compact` shrinks the star size + textarea + collapses
  // the status indicator next to the label. Used by the JobsTable
  // expanded-row panel where vertical room is at a premium.
  density?: 'normal' | 'compact';
}

/**
 * Reusable 5-star rating + autosaved free-text comment editor.
 *
 * Extracted from JobActionsPopover.tsx so the same UX can live in:
 *   - the popover itself (Corpus → Open ↗)
 *   - ApplicationsPage's card-detail modal
 *   - JobsTable's expanded-row panel (compact variant)
 *
 * All three surfaces edit the SAME results.json fields (rating, comment,
 * rated_at) via useCorpusActions().rateJob — there is no per-surface
 * shadow copy. Same debounce + blur-flush + unmount-flush + status
 * indicator semantics in every surface.
 */
export const RatingCommentEditor = ({
  jobId,
  initialRating,
  initialComment,
  onSave,
  showRating = true,
  textareaRows,
  density = 'normal',
}: RatingCommentEditorProps) => {
  const compact = density === 'compact';
  const rows = textareaRows ?? (compact ? 2 : 3);

  // Optimistic rating — instant visual feedback; revert on error.
  const [rating, setRating] = useState<number | null>(initialRating);
  const [hoverRating, setHoverRating] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Comment editor state. `commentDraft` is what the user is typing;
  // `commentSaved` is the last value successfully persisted (used to
  // decide whether a blur/unmount flush actually has unsaved work).
  const [commentDraft, setCommentDraft] = useState<string>(initialComment ?? '');
  const [commentSaved, setCommentSaved] = useState<string>(initialComment ?? '');
  const [saveStatus, setSaveStatus] =
    useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const debounceRef = useRef<number | null>(null);
  const savedFadeRef = useRef<number | null>(null);

  // Stable refs so the unmount-flush effect always sees the latest
  // values without re-binding (which would otherwise re-fire the
  // cleanup on every keystroke).
  const draftRef = useRef(commentDraft);
  draftRef.current = commentDraft;
  const savedRef = useRef(commentSaved);
  savedRef.current = commentSaved;
  const ratingRef = useRef(rating);
  ratingRef.current = rating;

  const handleRate = async (n: number | null) => {
    const previous = rating;
    setRating(n);
    setErr(null);
    // Don't touch the comment field — it's saved separately on its own
    // debounce / blur cycle.
    const r = await onSave(n);
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
      // Empty (or whitespace-only) → null = clear server-side. Matches
      // the backend's tri-state contract.
      const payload: string | null = text.trim() === '' ? null : text;
      const r = await onSave(ratingRef.current, payload);
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
    [onSave],
  );

  // On unmount: flush any pending comment edit before the editor dies.
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

  const statusIndicator = (
    <span
      className={clsx(
        'text-[10px]',
        saveStatus === 'saving' && 'text-slate-400',
        saveStatus === 'saved' && 'text-emerald-600',
        saveStatus === 'error' && 'text-red-600',
        saveStatus === 'idle' && 'text-slate-300',
      )}
      aria-live="polite"
    >
      {saveStatus === 'saving' && 'saving…'}
      {saveStatus === 'saved' && 'saved'}
      {saveStatus === 'error' && 'save failed'}
      {saveStatus === 'idle' && commentDraft !== commentSaved && 'unsaved'}
      {saveStatus === 'idle' && commentDraft === commentSaved &&
        `${commentDraft.length}/${COMMENT_MAX}`}
    </span>
  );

  return (
    <div onClick={(e) => e.stopPropagation()}>
      {showRating && (
        <div className={compact ? 'mb-2' : 'mt-2'}>
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
                    'flex items-center justify-center rounded leading-none transition-colors',
                    compact ? 'h-5 w-5 text-base' : 'h-7 w-7 text-lg',
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
          {!compact && (
            <p className="mt-1 text-[10px] text-slate-400">
              Used to personalize future Claude scoring.
            </p>
          )}
        </div>
      )}

      <div className={compact ? '' : 'mt-3'}>
        <div className="mb-1 flex items-center justify-between">
          <label
            htmlFor={`rce-comment-${jobId}`}
            className="text-[11px] font-semibold uppercase tracking-wider text-slate-500"
          >
            Comment
          </label>
          {statusIndicator}
        </div>
        <textarea
          id={`rce-comment-${jobId}`}
          value={commentDraft}
          onChange={(e) => handleCommentChange(e.target.value.slice(0, COMMENT_MAX))}
          onBlur={handleCommentBlur}
          rows={rows}
          placeholder="Why this rating? Anything to remember about this role…"
          className={clsx(
            'w-full resize-y rounded border border-slate-200 px-2 py-1.5 text-slate-800 placeholder:text-slate-300 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500',
            compact ? 'text-[11px]' : 'text-xs',
          )}
        />
      </div>

      {err && (
        <div className="mt-2 rounded bg-red-50 px-2 py-1 text-[11px] text-red-700">
          {err}
        </div>
      )}
    </div>
  );
};

export default RatingCommentEditor;
