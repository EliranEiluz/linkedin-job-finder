import { useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { CorpusPage } from './CorpusPage';
import { ApplicationsPage } from './ApplicationsPage';
import { ConfigPage } from './ConfigPage';
import { RunHistoryPage } from './RunHistoryPage';
import { OnboardingPage } from './OnboardingPage';

type Tab = 'corpus' | 'tracker' | 'config' | 'history' | 'setup';

// Two label fields: `label` is the desktop wordmark, `short` is what we render
// below md so the tab strip can fit. Same width-shrinking trick we use in
// other places (responsive truncation via clsx + responsive utility classes
// would be wordier than just picking one of two strings).
const TABS: { id: Tab; label: string; short: string }[] = [
  { id: 'corpus', label: 'Corpus', short: 'Corpus' },
  { id: 'tracker', label: 'Tracker', short: 'Tracker' },
  { id: 'config', label: 'Crawler Config', short: 'Config' },
  { id: 'history', label: 'Run History', short: 'History' },
  { id: 'setup', label: 'Setup', short: 'Setup' },
];

const readTabFromUrl = (): Tab | null => {
  const t = new URLSearchParams(window.location.search).get('tab');
  if (
    t === 'config' ||
    t === 'history' ||
    t === 'corpus' ||
    t === 'tracker' ||
    t === 'setup'
  ) {
    return t;
  }
  return null;
};

export const App = () => {
  // First paint: if URL pinned a tab, honor it. Otherwise leave null and let
  // the profile-presence check pick — wizard for first-runs, corpus otherwise.
  const [tab, setTab] = useState<Tab>(() => readTabFromUrl() ?? 'corpus');
  // One-shot landing gate: if /api/profiles returns zero profiles AND the URL
  // didn't already pin a tab, force the wizard. Skips after the first run so
  // the user can navigate freely. Failures (network down, etc) are silent —
  // we don't want to block the UI behind a flaky check.
  useEffect(() => {
    if (readTabFromUrl() !== null) return; // URL wins
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/profiles');
        if (!res.ok || cancelled) return;
        const j = (await res.json()) as { profiles?: string[] };
        const profiles = Array.isArray(j.profiles) ? j.profiles : [];
        if (profiles.length === 0) {
          setTab('setup');
        }
      } catch {
        /* fall through to corpus default */
      }
    })();
    return () => { cancelled = true; };
  }, []);
  // Per-tab refs so we can scroll the active tab into view on mobile when
  // the user navigates via URL change / popstate / first paint. Keeps the
  // active tab visible inside the horizontal-scroll strip.
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});

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
    const onPop = () => {
      const t = readTabFromUrl();
      if (t !== null) setTab(t);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Scroll the active tab button into view inside the horizontal nav strip
  // whenever the active tab changes. Only meaningful on mobile (where the
  // strip overflows horizontally); on desktop the parent doesn't scroll so
  // this is a no-op visually.
  useEffect(() => {
    const el = tabRefs.current[tab];
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
  }, [tab]);

  return (
    <div className="flex h-screen flex-col bg-slate-50">
      {/* Tab nav (above the page header)
          Mobile: horizontal scroll strip, wordmark collapses to a dot.
          Desktop (md+): unchanged — full wordmark + inline tabs. */}
      <nav className="flex items-stretch border-b border-slate-200 bg-white">
        <h1 className="flex shrink-0 items-center px-4 py-2.5 text-base font-semibold text-slate-900 md:mr-2">
          <span className="text-brand-700">●</span>
          {/* Hide wordmark below md so the tab strip gets the room. */}
          <span className="ml-1.5 hidden md:inline">Jobs Browser</span>
        </h1>
        <div className="no-scrollbar flex flex-1 items-stretch overflow-x-auto">
          {TABS.map((t) => (
            <button
              key={t.id}
              ref={(el) => {
                tabRefs.current[t.id] = el;
              }}
              type="button"
              onClick={() => switchTab(t.id)}
              className={clsx(
                'relative -mb-px shrink-0 whitespace-nowrap border-b-2 px-4 py-3 text-sm font-medium transition-colors md:py-2.5',
                tab === t.id
                  ? 'border-brand-700 text-brand-700'
                  : 'border-transparent text-slate-600 hover:text-brand-700',
              )}
            >
              {/* Short label below md, full label at md+. Picks one or the
                  other so screen readers don't announce both. */}
              <span className="md:hidden">{t.short}</span>
              <span className="hidden md:inline">{t.label}</span>
            </button>
          ))}
        </div>
      </nav>

      {/* Active page */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {tab === 'corpus' && <CorpusPage />}
        {tab === 'tracker' && <ApplicationsPage />}
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
