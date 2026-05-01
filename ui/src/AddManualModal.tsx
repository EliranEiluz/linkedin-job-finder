import { useEffect, useMemo, useRef, useState } from 'react';
import { useAddManual, type AddManualJob } from './hooks';

/** Client-side mirror of corpus_ctl.py:extract_job_id. Used for instant
 *  validation feedback in the modal — the Python side still runs the
 *  authoritative check on submit. Keep these regexes in lock-step with
 *  the Python ones. */
const BARE_ID_RE = /^\d{8,12}$/;
const JOBVIEW_RE = /\/jobs\/view\/(?:[^/?#]*-)?(\d{8,12})/;

export const extractJobIdTs = (input: string): string | null => {
  const s = (input || '').trim();
  if (!s) return null;
  if (BARE_ID_RE.test(s)) return s;
  let withScheme = s;
  if (!/^https?:\/\//i.test(withScheme)) {
    withScheme = 'https://' + withScheme.replace(/^\/+/, '');
  }
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    return null;
  }
  if (!/(^|\.)linkedin\.com$/i.test(u.hostname)) return null;
  const cur = u.searchParams.get('currentJobId');
  if (cur && /^\d{8,12}$/.test(cur)) return cur;
  const m = JOBVIEW_RE.exec(u.pathname);
  return m?.[1] ?? null;
};

type ModalState =
  | { kind: 'idle' }
  | { kind: 'fetching' }
  | { kind: 'success'; job: AddManualJob }
  | { kind: 'duplicate'; existingId?: string }
  | { kind: 'error'; message: string };

interface Props {
  open: boolean;
  onClose: () => void;
}

const FIT_PILL_CLASS: Record<string, string> = {
  good: 'bg-emerald-100 text-emerald-800',
  ok: 'bg-amber-100 text-amber-800',
  skip: 'bg-slate-200 text-slate-700',
};

export const AddManualModal = ({ open, onClose }: Props) => {
  const [input, setInput] = useState('');
  const [state, setState] = useState<ModalState>({ kind: 'idle' });
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const { addManual } = useAddManual();

  const extractedId = useMemo(() => extractJobIdTs(input), [input]);
  const canSubmit =
    state.kind !== 'fetching' && extractedId !== null && input.trim().length > 0;

  // Reset state when the modal is reopened — feels less surprising than
  // showing the previous attempt's success/error pill the next visit.
  useEffect(() => {
    if (open) {
      setInput('');
      setState({ kind: 'idle' });
      // Defer focus so the modal mount transition completes first.
      const id = window.setTimeout(() => inputRef.current?.focus(), 50);
      return () => window.clearTimeout(id);
    }
    return;
  }, [open]);

  // ESC closes — match the rest of the app's modal behaviour.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && state.kind !== 'fetching') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, state.kind]);

  if (!open) return null;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setState({ kind: 'fetching' });
    const r = await addManual(input);
    if (r.ok && r.job) {
      setState({ kind: 'success', job: r.job });
      return;
    }
    if (r.alreadyInCorpus) {
      setState({ kind: 'duplicate', existingId: r.existingId });
      return;
    }
    setState({ kind: 'error', message: r.error || 'unknown error' });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Cmd/Ctrl+Enter submits (textarea Enter inserts a newline).
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void handleSubmit();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      onClick={() => {
        if (state.kind !== 'fetching') onClose();
      }}
    >
      <div
        className="w-full max-w-md overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-manual-title"
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <h3
            id="add-manual-title"
            className="text-sm font-semibold text-slate-900"
          >
            Add a job manually
          </h3>
          <div className="flex items-center gap-2">
            <kbd className="hidden rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-[10px] text-slate-500 md:inline-block">
              Esc
            </kbd>
            <button
              type="button"
              onClick={onClose}
              disabled={state.kind === 'fetching'}
              aria-label="Close"
              className="rounded p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-40"
            >
              <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>
        </div>

        <div className="px-4 py-3">
          <label
            htmlFor="add-manual-input"
            className="block text-xs text-slate-600"
          >
            Paste a LinkedIn URL or job ID
          </label>
          <textarea
            id="add-manual-input"
            ref={inputRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              if (state.kind === 'error' || state.kind === 'duplicate') {
                setState({ kind: 'idle' });
              }
            }}
            onKeyDown={onKeyDown}
            disabled={state.kind === 'fetching' || state.kind === 'success'}
            rows={2}
            maxLength={500}
            placeholder="https://www.linkedin.com/jobs/view/4395123456/  —  or just 4395123456"
            className="mt-1.5 w-full resize-none rounded border border-slate-300 px-2.5 py-1.5 font-mono text-xs text-slate-800 focus:border-brand-700 focus:outline-none disabled:bg-slate-50 disabled:text-slate-500"
          />
          <div className="mt-1 flex h-4 items-center text-[11px]">
            {input.trim() && extractedId ? (
              <span className="text-slate-500">
                Extracted ID:{' '}
                <span className="font-mono text-slate-700">{extractedId}</span>
              </span>
            ) : input.trim() ? (
              <span className="text-amber-700">
                Couldn't recognise that as a LinkedIn job URL or 8-12 digit ID
              </span>
            ) : null}
          </div>

          {/* State surface — fetching / success / duplicate / error. */}
          <div className="mt-3 min-h-[3.5rem]">
            {state.kind === 'fetching' && (
              <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
                <div className="flex items-center gap-2">
                  <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-slate-300 border-t-brand-700" />
                  <span>Working… this can take 30-60 seconds</span>
                </div>
                <div className="mt-1 text-[11px] text-slate-500">
                  Fetching from LinkedIn, then scoring with Claude.
                </div>
              </div>
            )}
            {state.kind === 'success' && state.job && (
              <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-emerald-700">
                  Added
                </div>
                <div className="mt-1 truncate text-sm font-medium text-slate-900">
                  {state.job.title || `(no title) — ${state.job.id}`}
                </div>
                <div className="truncate text-xs text-slate-600">
                  {state.job.company || 'unknown company'}
                  {state.job.location ? ` · ${state.job.location}` : ''}
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  {state.job.fit && (
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${
                        FIT_PILL_CLASS[state.job.fit] ?? 'bg-slate-100 text-slate-700'
                      }`}
                    >
                      {state.job.fit}
                      {state.job.score != null ? ` · ${state.job.score}/10` : ''}
                    </span>
                  )}
                  {state.job.scored_by && (
                    <span className="text-[11px] text-slate-500">
                      via {state.job.scored_by}
                    </span>
                  )}
                  <a
                    href={`https://www.linkedin.com/jobs/view/${state.job.id}/`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-auto text-[11px] font-medium text-brand-700 hover:underline"
                  >
                    Open ↗
                  </a>
                </div>
              </div>
            )}
            {state.kind === 'duplicate' && (
              <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                Already in your corpus
                {state.existingId ? ` (id ${state.existingId})` : ''}.
              </div>
            )}
            {state.kind === 'error' && (
              <div className="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
                {state.message}
              </div>
            )}
          </div>
        </div>

        {/* Footer — both buttons share the SAME border-box height. The
            primary `Add` button keeps a `border-transparent` so its
            border-box matches the secondary `Cancel`'s 1px border (round-1
            mismatch was 26px vs 24px from missing-border on Add). */}
        <div className="flex items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-4 py-2.5">
          <button
            type="button"
            onClick={onClose}
            disabled={state.kind === 'fetching'}
            className="inline-flex items-center justify-center rounded border border-slate-300 bg-white px-3 py-1 text-xs font-medium leading-5 text-slate-700 transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700 focus-visible:ring-offset-1 disabled:opacity-40"
          >
            {state.kind === 'success' ? 'Done' : 'Cancel'}
          </button>
          {state.kind !== 'success' && (
            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={!canSubmit}
              className="inline-flex items-center justify-center rounded border border-transparent bg-brand-700 px-3 py-1 text-xs font-medium leading-5 text-white transition-colors hover:bg-brand-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {state.kind === 'fetching' ? 'Adding…' : 'Add'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
