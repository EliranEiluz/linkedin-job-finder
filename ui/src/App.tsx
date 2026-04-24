import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import { CorpusPage } from './CorpusPage';
import { ConfigPage } from './ConfigPage';
import { RunHistoryPage } from './RunHistoryPage';
import { OnboardingPage } from './OnboardingPage';

type Tab = 'corpus' | 'config' | 'history' | 'setup';

const TABS: { id: Tab; label: string }[] = [
  { id: 'corpus', label: 'Corpus' },
  { id: 'config', label: 'Crawler Config' },
  { id: 'history', label: 'Run History' },
  { id: 'setup', label: 'Setup' },
];

const readTabFromUrl = (): Tab => {
  const t = new URLSearchParams(window.location.search).get('tab');
  if (
    t === 'config' ||
    t === 'history' ||
    t === 'corpus' ||
    t === 'setup'
  ) {
    return t;
  }
  return 'corpus';
};

export const App = () => {
  const [tab, setTab] = useState<Tab>(readTabFromUrl);

  const switchTab = useCallback((next: Tab) => {
    if (next === tab) return;
    // When leaving the corpus tab, drop its filter URL params so they don't
    // bleed into other tabs' URLs. The corpus page restores them from its
    // local state on the way back via fromSearchParams() defaults.
    const url = new URL(window.location.href);
    if (next === 'corpus') {
      url.searchParams.set('tab', 'corpus');
    } else {
      // Strip everything except the tab param.
      const sp = new URLSearchParams();
      sp.set('tab', next);
      url.search = '?' + sp.toString();
    }
    window.history.replaceState(null, '', url.pathname + url.search);
    setTab(next);
  }, [tab]);

  // Listen for back/forward.
  useEffect(() => {
    const onPop = () => setTab(readTabFromUrl());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  return (
    <div className="flex h-screen flex-col bg-slate-50">
      {/* Tab nav (above the page header) */}
      <nav className="flex items-center gap-0 border-b border-slate-200 bg-white px-4">
        <h1 className="mr-6 py-2.5 text-base font-semibold text-slate-900">
          <span className="text-brand-700">●</span> Jobs Browser
        </h1>
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => switchTab(t.id)}
            className={clsx(
              'relative -mb-px border-b-2 px-4 py-2.5 text-sm font-medium transition-colors',
              tab === t.id
                ? 'border-brand-700 text-brand-700'
                : 'border-transparent text-slate-600 hover:text-brand-700',
            )}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {/* Active page */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {tab === 'corpus' && <CorpusPage />}
        {tab === 'config' && <ConfigPage />}
        {tab === 'history' && <RunHistoryPage />}
        {tab === 'setup' && (
          <OnboardingPage
            onSwitchTab={(t) => switchTab(t)}
          />
        )}
      </div>
    </div>
  );
};

export default App;
