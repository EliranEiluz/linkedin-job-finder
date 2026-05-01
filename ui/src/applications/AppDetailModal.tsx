import { useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import type { AppStatus, Job } from '../types';
import { Dot } from '../Dot';
import { RatingCommentEditor } from '../RatingCommentEditor';
import {
  COLUMNS,
  NOTES_AUTOSAVE_MS,
  NOTES_MAX,
  STATUS_CHIP,
  STATUS_DOT,
  STATUS_LABEL,
  safeRel,
} from './constants';

const TITLE_TRUNC = 50;
const truncateTitle = (s: string, n = TITLE_TRUNC): string =>
  s.length <= n ? s : s.slice(0, n - 1) + '…';

interface AppDetailModalProps {
  job: Job;
  onClose: () => void;
  // Persists app_notes (tri-state on the wire — see hooks.ts setAppStatus).
  // The modal owns the autosave debounce + flush-on-blur + flush-on-unmount
  // pattern, so it just needs a simple promise-returning setter here.
  onSaveNotes: (
    id: string,
    status: AppStatus,
    note: string | null,
  ) => Promise<{ ok: boolean; error?: string }>;
  // Status changes via the quick-select dropdown. Same setAppStatus call,
  // but separated out so the page-level optimistic move logic can run
  // (mirror of the drag-end handler — no double-history-entry concerns
  // because the backend de-dupes same-status writes).
  onChangeStatus: (
    id: string,
    next: AppStatus,
  ) => Promise<{ ok: boolean; error?: string }>;
  // Rating + rating-comment writer. Distinct from app_notes — different
  // results.json fields (rating + comment) and different surface
  // (also editable from the Corpus popover and row-expanded panel). The
  // <RatingCommentEditor /> below owns its own autosave timers, so its
  // saves and the app_notes saves don't share state.
  onRate: (
    id: string,
    rating: number | null,
    comment?: string | null,
  ) => Promise<{ ok: boolean; error?: string }>;
}

// Centered overlay modal — picked over an anchored popover because it
// reads better on the iPhone width (the spec calls this out). Click on
// the backdrop or Escape closes; the autosave flush runs in the unmount
// effect so closing never drops a pending edit.
//
// Mirrors the rating-comment editor in JobActionsPopover.tsx exactly:
//   - 600ms debounced autosave on textarea change
//   - flush on blur (cancels the debounce, saves immediately)
//   - flush on unmount (best-effort fire-and-forget)
//   - status indicator: saving… / saved / save failed / unsaved / N/MAX
//   - empty / whitespace-only normalizes to null = clears app_notes
export const AppDetailModal = ({
  job, onClose, onSaveNotes, onChangeStatus, onRate,
}: AppDetailModalProps) => {
  const status = (job.app_status ?? 'new');

  // Notes editor state. `notesDraft` is what the user is typing;
  // `notesSaved` is the last value successfully persisted (used to decide
  // whether a blur/unmount flush actually has unsaved work).
  const initialNotes = job.app_notes ?? '';
  const [notesDraft, setNotesDraft] = useState<string>(initialNotes);
  const [notesSaved, setNotesSaved] = useState<string>(initialNotes);
  const [saveStatus, setSaveStatus] =
    useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveErr, setSaveErr] = useState<string | null>(null);

  // Debounce + saved-fade timers. Cleared in the unmount effect.
  const debounceRef = useRef<number | null>(null);
  const savedFadeRef = useRef<number | null>(null);

  // Refs used by the unmount-flush so it sees the latest values without
  // re-binding the cleanup effect (same pattern as JobActionsPopover).
  const draftRef = useRef(notesDraft);
  draftRef.current = notesDraft;
  const savedRef = useRef(notesSaved);
  savedRef.current = notesSaved;
  const statusRef = useRef(status);
  statusRef.current = status;

  // Status-change loading state for the quick-select dropdown.
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusErr, setStatusErr] = useState<string | null>(null);

  // ---- Backdrop click + Escape close ----
  // Backdrop click: only close when the click target IS the backdrop (so
  // clicks inside the modal panel don't bubble up and dismiss it). Escape
  // closes from anywhere — the unmount-flush picks up any pending notes.
  const backdropRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); };
  }, [onClose]);

  // Persist the current notes draft. Used by both the debounced autosave
  // and the blur/unmount flush. No-op when nothing is dirty.
  const saveNotes = useCallback(
    async (text: string) => {
      if (text === savedRef.current) return; // no change
      setSaveStatus('saving');
      // Empty (or whitespace-only) → null = clear server-side. Mirrors the
      // backend's tri-state contract (undefined = don't touch, null = clear,
      // string = set).
      const payload: string | null = text.trim() === '' ? null : text;
      const r = await onSaveNotes(job.id, statusRef.current, payload);
      if (r.ok) {
        setSaveStatus('saved');
        setSaveErr(null);
        setNotesSaved(text);
        if (savedFadeRef.current) window.clearTimeout(savedFadeRef.current);
        savedFadeRef.current = window.setTimeout(
          () => { setSaveStatus('idle'); }, 1500,
        );
      } else {
        setSaveStatus('error');
        setSaveErr(r.error ?? 'notes save failed');
      }
    },
    [job.id, onSaveNotes],
  );

  // On unmount: clear timers + flush any pending edit. Best-effort
  // (fire-and-forget — we can't await a React unmount). Same shape as
  // JobActionsPopover's comment unmount-flush.
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
        void saveNotes(draftRef.current);
      }
    };
  }, [saveNotes]);

  const handleNotesChange = (text: string) => {
    setNotesDraft(text);
    setSaveStatus('idle');
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      void saveNotes(text);
      debounceRef.current = null;
    }, NOTES_AUTOSAVE_MS);
  };

  const handleNotesBlur = () => {
    if (debounceRef.current) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    void saveNotes(notesDraft);
  };

  const handleStatusChange = async (next: AppStatus) => {
    if (next === status) return;
    setStatusBusy(true);
    setStatusErr(null);
    const r = await onChangeStatus(job.id, next);
    setStatusBusy(false);
    if (!r.ok) {
      setStatusErr(r.error ?? 'status change failed');
    } else {
      // Page-level reload (via the corpus-stale event fired by useAppStatus)
      // will re-render with the new status; we close so the user sees the
      // card jump to its new column rather than having a stale snapshot.
      onClose();
    }
  };

  // Status history list: most-recent first, distance from now. Server
  // appends on every transition, so the list reads as a timeline of moves.
  const history = (job.app_status_history ?? []).slice().reverse();

  return (
    <div
      ref={backdropRef}
      role="presentation"
      onClick={(e) => {
        if (e.target === backdropRef.current) onClose();
      }}
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 px-2 pb-2 sm:items-center sm:p-4"
    >
      <div
        role="dialog"
        aria-label="Application details"
        aria-modal="true"
        className="flex w-full max-w-lg flex-col overflow-hidden rounded-t-lg bg-white shadow-xl sm:rounded-lg"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-4 py-3">
          <div className="min-w-0">
            <div
              className="truncate text-sm font-semibold text-slate-900"
              title={job.title}
            >
              {truncateTitle(job.title || '(untitled)')}
            </div>
            <div className="mt-0.5 truncate text-xs text-slate-500" title={job.company}>
              {job.company || '—'}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
              <span
                className={clsx(
                  'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-medium',
                  STATUS_CHIP[status],
                )}
              >
                <Dot color={STATUS_DOT[status]} />
                {STATUS_LABEL[status]}
              </span>
              <span className="text-slate-400">
                moved {safeRel(job.app_status_at)}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="-mr-1 rounded px-2 py-1 text-lg leading-none text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {/* Body — scrollable on small viewports */}
        <div className="flex-1 overflow-y-auto px-4 py-3">
          {/* Rating + rating-comment — same component used by the Corpus
              popover and the JobsTable expanded row. Writes the SAME
              results.json fields (rating, comment, rated_at), distinct
              from app_notes below. Owns its own debounce/autosave timers
              so it doesn't collide with the notes editor's. */}
          <div className="mb-4 border-b border-slate-100 pb-4">
            <RatingCommentEditor
              jobId={job.id}
              initialRating={job.rating ?? null}
              initialComment={job.comment ?? null}
              onSave={(rating, comment) => onRate(job.id, rating, comment)}
            />
          </div>

          {/* Notes textarea */}
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label
                htmlFor={`app-notes-${job.id}`}
                className="text-[11px] font-semibold uppercase tracking-wider text-slate-500"
              >
                Notes
              </label>
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
                {saveStatus === 'idle' && notesDraft !== notesSaved && 'unsaved'}
                {saveStatus === 'idle' && notesDraft === notesSaved &&
                  `${notesDraft.length}/${NOTES_MAX}`}
              </span>
            </div>
            <textarea
              id={`app-notes-${job.id}`}
              value={notesDraft}
              onChange={(e) => { handleNotesChange(e.target.value.slice(0, NOTES_MAX)); }}
              onBlur={handleNotesBlur}
              rows={5}
              placeholder="Recruiter pinged me Friday, interview rescheduled, take-home due Tue…"
              className="w-full resize-y rounded border border-slate-200 px-2 py-1.5 text-sm text-slate-800 placeholder:text-slate-300 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
            {saveErr && (
              <div className="mt-1 rounded bg-red-50 px-2 py-1 text-[11px] text-red-700">
                {saveErr}
              </div>
            )}
          </div>

          {/* Status history */}
          {history.length > 0 && (
            <div className="mt-4">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                History
              </div>
              <ol className="space-y-1 text-xs text-slate-600">
                {history.map((h, i) => (
                  <li key={`${h.at}-${i}`} className="flex items-center gap-2">
                    <span
                      className={clsx(
                        'inline-flex items-center gap-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium',
                        STATUS_CHIP[h.status],
                      )}
                    >
                      <Dot color={STATUS_DOT[h.status]} />
                      {STATUS_LABEL[h.status]}
                    </span>
                    <span className="text-slate-400">{safeRel(h.at)}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>

        {/* Footer — quick actions */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 bg-slate-50 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <label
              htmlFor={`app-status-${job.id}`}
              className="text-[11px] font-medium text-slate-500"
            >
              Move to
            </label>
            <select
              id={`app-status-${job.id}`}
              value={status}
              disabled={statusBusy}
              onChange={(e) => void handleStatusChange(e.target.value as AppStatus)}
              className="rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-800 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:opacity-50"
            >
              {COLUMNS.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
              {/* `new` is the unset/default state hidden from the kanban —
                  selecting it removes the job from the tracker (status
                  history is preserved server-side). Same as un-checking
                  "Applied" in the Corpus tab. */}
              <option value="new">— Remove from tracker</option>
            </select>
            {statusErr && (
              <span className="text-[11px] text-red-600">{statusErr}</span>
            )}
          </div>
          {/* Order: destructive/secondary LEFT, primary action RIGHT
              (Apple HIG / standard form-button convention). The "Remove
              from tracker" sets app_status='new' which hides the job
              from the kanban; status history is preserved server-side. */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={statusBusy}
              onClick={() => void handleStatusChange('new')}
              className="inline-flex items-center gap-1 rounded border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-500 hover:border-red-200 hover:bg-red-50 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-50"
              title="Remove from tracker (status history preserved)"
            >
              Remove from tracker
            </button>
            {job.url ? (
              <a
                href={job.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded border border-brand-700 bg-brand-700 px-3 py-1 text-xs font-semibold text-white shadow-sm hover:bg-brand-800"
              >
                Open ↗
              </a>
            ) : (
              <span className="text-[11px] text-slate-400">no URL</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
