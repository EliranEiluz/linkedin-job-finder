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
  // the cv_present check pick — wizard for first-runs, corpus otherwise.
  const [tab, setTab] = useState<Tab>(() => readTabFromUrl() ?? 'corpus');
  // `null` until /api/profiles answers; then true (user finished onboarding,
  // show all tabs) or false (fresh install, show ONLY Setup + force-route).
  // Profile-count alone isn't enough — `_migrate_if_needed` auto-creates a
  // 'default' profile on first ctl call, so a fresh clone always reports
  // ≥1 profile. cv.txt is the real "user has uploaded their CV via the
  // wizard" signal.
  const [onboarded, setOnboarded] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/profiles');
        if (!res.ok || cancelled) return;
        const j = (await res.json()) as {
          profiles?: string[]; cv_present?: boolean;
        };
        const isOnboarded = j.cv_present === true;
        setOnboarded(isOnboarded);
        // Force-route to Setup ONLY if the URL didn't pin a tab AND the user
        // hasn't onboarded yet. Otherwise honor existing state.
        if (!isOnboarded && readTabFromUrl() === null) {
          setTab('setup');
        }
      } catch {
        // Network blip — assume onboarded so we don't trap the user in Setup.
        setOnboarded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);
  // Visible tabs: while not onboarded, hide everything except Setup so the
  // user can't bounce into broken Corpus / Tracker / History pages with no
  // data. After onboarding, show all 5.
  const visibleTabs =
    onboarded === false ? TABS.filter((t) => t.id === 'setup') : TABS;
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
          {visibleTabs.map((t) => (
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

      {/* Active page. While not onboarded we force-render the OnboardingPage
          regardless of the `tab` state, so a URL-pinned ?tab=corpus on a
          fresh install can't bypass the wizard. */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {onboarded === false ? (
          <OnboardingPage onSwitchTab={(t) => switchTab(t)} />
        ) : (
          <>
            {tab === 'corpus' && <CorpusPage />}
            {tab === 'tracker' && <ApplicationsPage />}
            {tab === 'config' && <ConfigPage />}
            {tab === 'history' && <RunHistoryPage />}
            {tab === 'setup' && (
              <OnboardingPage
                onSwitchTab={(t) => switchTab(t)}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default App;
