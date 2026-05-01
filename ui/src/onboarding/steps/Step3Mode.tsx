import { useCallback, useState } from 'react';
import clsx from 'clsx';
import { BackButton } from '../components';
import type { LinkedInSessionResponse, WizardDraft } from '../types';

const formatRelTime = (iso: string): string => {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.round(ms / 60_000).toString()}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000).toString()}h ago`;
  return `${Math.round(ms / 86_400_000).toString()}d ago`;
};

export const Step3Mode = ({
  draft,
  setDraft,
  onAdvance,
  onBack,
}: {
  draft: WizardDraft;
  setDraft: (d: WizardDraft) => void;
  onAdvance: () => void;
  onBack: () => void;
}) => {
  const [pickedLoggedIn, setPickedLoggedIn] = useState(false);
  const [session, setSession] = useState<LinkedInSessionResponse | null>(null);
  const [checking, setChecking] = useState(false);

  const checkSession = useCallback(async () => {
    setChecking(true);
    try {
      const res = await fetch('/api/linkedin-session/exists');
      const body = (await res.json()) as LinkedInSessionResponse;
      setSession(body);
    } catch (e) {
      setSession({ exists: false, mtime: null, error: (e as Error).message });
    } finally {
      setChecking(false);
    }
  }, []);

  const pickGuest = () => {
    setDraft({ ...draft, default_mode: 'guest' });
    onAdvance();
  };

  const pickLoggedIn = () => {
    setPickedLoggedIn(true);
    void checkSession();
  };

  const continueLoggedIn = () => {
    setDraft({ ...draft, default_mode: 'loggedin' });
    onAdvance();
  };

  return (
    <div>
      <h2 className="mb-2 text-base font-semibold text-slate-800">LinkedIn mode</h2>
      <p className="mb-4 text-sm text-slate-600">
        How should the scraper hit LinkedIn? You can switch later per-run.
      </p>
      <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-2">
        <button
          type="button"
          aria-pressed={draft.default_mode === 'guest'}
          onClick={pickGuest}
          className={clsx(
            'rounded border p-4 text-left transition focus:outline-none focus:ring-2 focus:ring-indigo-400',
            draft.default_mode === 'guest'
              ? 'border-indigo-500 bg-indigo-50 ring-1 ring-indigo-300'
              : 'border-slate-200 bg-white hover:border-indigo-300 hover:bg-indigo-50/40',
          )}
        >
          <div className="flex items-center gap-2">
            <span className="font-semibold text-slate-800">Guest mode</span>
            <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700">
              Recommended
            </span>
          </div>
          <p className="mt-2 text-xs text-slate-600">
            No setup, no LinkedIn account. Hits the public guest API. Smaller
            result pool but zero risk to your account.
          </p>
        </button>
        <button
          type="button"
          aria-pressed={pickedLoggedIn}
          onClick={pickLoggedIn}
          className={clsx(
            'rounded border p-4 text-left transition focus:outline-none focus:ring-2 focus:ring-indigo-400',
            pickedLoggedIn
              ? 'border-indigo-500 bg-indigo-50 ring-1 ring-indigo-300'
              : 'border-slate-200 bg-white hover:border-indigo-300 hover:bg-indigo-50/40',
          )}
        >
          <div className="font-semibold text-slate-800">Logged-in mode (advanced)</div>
          <p className="mt-2 text-xs text-slate-600">
            Saved LinkedIn session for personalized results. First-time setup
            needs the terminal.
          </p>
        </button>
      </div>

      {pickedLoggedIn && (
        <div className="mb-4 rounded border border-slate-200 bg-slate-50 p-3 text-sm">
          {checking && <div className="text-slate-600">Checking session…</div>}
          {!checking && session?.exists && session.mtime && (
            <>
              <div className="mb-2 text-emerald-700">
                ✓ Session found (last updated {formatRelTime(session.mtime)}).
              </div>
              <button
                type="button"
                onClick={continueLoggedIn}
                className="rounded bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700"
              >
                Continue →
              </button>
            </>
          )}
          {!checking && session && !session.exists && (
            <>
              <div className="mb-2 text-slate-700">
                No saved session yet. To create one:
              </div>
              <pre className="mb-3 overflow-x-auto rounded bg-slate-900 p-3 text-xs leading-relaxed text-slate-100">
                <code>{`Open a terminal in the project root and run:

    python3 backend/search.py --mode=loggedin

Chromium will open. Sign in to LinkedIn. The script saves your
session and exits. Then come back here and click "I've completed this".`}</code>
              </pre>
              <button
                type="button"
                onClick={checkSession}
                className="rounded bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700"
              >
                I've completed this — re-check
              </button>
            </>
          )}
        </div>
      )}

      <div>
        <BackButton onBack={onBack} />
      </div>
    </div>
  );
};
