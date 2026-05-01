import { useState } from 'react';
import { Banner } from '../components';

export const Step7WhatsNext = ({
  savedProfile,
  defaultMode,
  onSwitchTab,
  onDismiss,
}: {
  savedProfile: string | null;
  defaultMode: 'guest' | 'loggedin';
  onSwitchTab: (tab: 'corpus' | 'config' | 'history') => void;
  onDismiss: () => void;
}) => {
  const [scrapeMsg, setScrapeMsg] = useState<
    { kind: 'idle' } | { kind: 'ok'; text: string } | { kind: 'err'; text: string }
  >({ kind: 'idle' });
  const [scraping, setScraping] = useState(false);

  const startScrape = async () => {
    setScraping(true);
    setScrapeMsg({ kind: 'idle' });
    try {
      const res = await fetch('/api/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: defaultMode }),
      });
      const body = (await res.json()) as { error?: string };
      if (res.ok) {
        setScrapeMsg({
          kind: 'ok',
          text: 'Scrape started — see Run History tab. Takes 5-15 min.',
        });
      } else {
        setScrapeMsg({ kind: 'err', text: body.error ?? `HTTP ${res.status.toString()}` });
      }
    } catch (e) {
      setScrapeMsg({ kind: 'err', text: (e as Error).message });
    } finally {
      setScraping(false);
    }
  };

  return (
    <div>
      <h2 className="mb-1 text-lg font-semibold text-slate-900">You're all set.</h2>
      <p className="mb-5 text-sm text-slate-600">
        {savedProfile
          ? `Profile "${savedProfile}" saved. Pick what to do next:`
          : 'Profile saved. Pick what to do next:'}
      </p>

      {scrapeMsg.kind === 'ok' && <Banner kind="ok">{scrapeMsg.text}</Banner>}
      {scrapeMsg.kind === 'err' && (
        <Banner kind="err">Couldn't start scrape: {scrapeMsg.text}</Banner>
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <button
          type="button"
          onClick={startScrape}
          disabled={scraping}
          className="rounded border border-slate-200 bg-white p-4 text-left transition hover:border-indigo-400 hover:bg-indigo-50/40 focus:outline-none focus:ring-2 focus:ring-indigo-400 disabled:opacity-50"
        >
          <div className="font-semibold text-slate-800">Run my first scrape now</div>
          <p className="mt-2 text-xs text-slate-600">
            Kicks off a {defaultMode} scrape. Watch progress in Run History.
            Takes 5-15 minutes.
          </p>
        </button>
        <button
          type="button"
          onClick={() => { onSwitchTab('config'); }}
          className="rounded border border-slate-200 bg-white p-4 text-left transition hover:border-indigo-400 hover:bg-indigo-50/40 focus:outline-none focus:ring-2 focus:ring-indigo-400"
        >
          <div className="font-semibold text-slate-800">Schedule daily auto-scrape</div>
          <p className="mt-2 text-xs text-slate-600">
            Opens Crawler Config — find the Scheduler card and click Install
            to enable a daily run.
          </p>
        </button>
        <button
          type="button"
          onClick={() => { onSwitchTab('corpus'); }}
          className="rounded border border-slate-200 bg-white p-4 text-left transition hover:border-indigo-400 hover:bg-indigo-50/40 focus:outline-none focus:ring-2 focus:ring-indigo-400"
        >
          <div className="font-semibold text-slate-800">Skip — go to Corpus</div>
          <p className="mt-2 text-xs text-slate-600">
            Browse whatever jobs are already in the corpus.
          </p>
        </button>
      </div>

      <div className="mt-5">
        <button
          type="button"
          onClick={onDismiss}
          className="text-sm text-slate-500 underline hover:text-slate-700"
        >
          Done
        </button>
      </div>
    </div>
  );
};
