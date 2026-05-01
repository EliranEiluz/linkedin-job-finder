// 8-step onboarding wizard:
//   0. Pre-flight system check
//   1. Pick LLM provider
//   2. Pick geo scope
//   3. Pick LinkedIn mode (guest / loggedin)
//   4. Upload CV
//   5. Write intent
//   6. Generate + review + save
//   7. What's next (run / schedule / skip)
// POSTs to /api/onboarding/generate and /api/onboarding/save in the Vite dev
// middleware. No routing — just in-component step state.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import type { CrawlerConfig, LLMProviderName } from './configTypes';
import { normalizeConfig } from './configMigrate';
import { useViewport } from './useViewport';

type Step = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

interface GenerateResponse {
  ok: boolean;
  config?: unknown;
  raw?: string;
  error?: string;
}

interface SaveResponse {
  ok: boolean;
  error?: string;
  profile?: string;
}

interface PreflightCheck {
  name: string;
  ok: boolean;
  value?: string;
  fix?: string;
}

interface PreflightResponse {
  ok: boolean;
  checks?: PreflightCheck[];
  error?: string;
}

interface LLMProvider {
  name: LLMProviderName;
  label: string;
  needs_key: boolean;
  free_tier: boolean;
  env_var: string | null;
  help_url: string;
  blurb: string;
}

interface LLMListResponse {
  ok: boolean;
  providers?: LLMProvider[];
  error?: string;
}

interface LLMTestResponse {
  ok: boolean;
  message?: string;
  name?: string;
  error?: string;
}

interface LLMSaveCredResponse {
  ok: boolean;
  env_var?: string;
  env_path?: string;
  error?: string;
}

interface LinkedInSessionResponse {
  exists: boolean;
  mtime: string | null;
  error?: string;
}

const CV_MIN_CHARS = 200;
const INTENT_MIN_CHARS = 50;

// Mirrors onboarding_ctl._PROFILE_NAME_RE.
const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

// Default profile name shown in Step 6 — "onboarded-YYYY-MM-DD". Pure local
// date (not UTC) so a user in Asia doesn't see a tomorrow-dated profile.
const defaultProfileName = (): string => {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `onboarded-${yyyy}-${mm}-${dd}`;
};

// In-flight wizard draft — propagated to Step 6's save payload so the saved
// profile reflects the wizard picks (llm_provider / geo_id / default_mode).
interface WizardDraft {
  llm_provider?: { name: LLMProviderName };
  geo_id?: string;
  default_mode?: 'guest' | 'loggedin';
}

const Stepper = ({ step }: { step: Step }) => {
  // Labels: short for mobile, full at md+. [shortLabel, fullLabel].
  const labels: readonly (readonly [string, string])[] = [
    ['Sys', 'Pre-flight'],
    ['LLM', 'LLM provider'],
    ['Geo', 'Geo scope'],
    ['Mode', 'LinkedIn mode'],
    ['CV', 'Upload CV'],
    ['Intent', 'Write intent'],
    ['Review', 'Generate & review'],
    ['Done', "What's next"],
  ];
  return (
    <ol className="mb-6 flex flex-wrap items-center gap-2 text-sm">
      {labels.map(([short, full], i) => {
        const n = i as Step;
        const active = n === step;
        const done = n < step;
        return (
          <li key={full} className="flex items-center gap-2">
            <span
              className={clsx(
                'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                active && 'bg-indigo-600 text-white',
                done && 'bg-indigo-200 text-indigo-800',
                !active && !done && 'bg-slate-200 text-slate-500',
              )}
            >
              {done ? '✓' : i + 1}
            </span>
            <span
              className={clsx(
                'whitespace-nowrap font-medium',
                active ? 'text-indigo-700' : 'text-slate-600',
              )}
            >
              <span className="md:hidden">{short}</span>
              <span className="hidden md:inline">{full}</span>
            </span>
            {i < labels.length - 1 && <span className="mx-1 text-slate-300">→</span>}
          </li>
        );
      })}
    </ol>
  );
};

const Banner = ({
  kind,
  children,
}: {
  kind: 'info' | 'warn' | 'ok' | 'err';
  children: React.ReactNode;
}) => {
  const cls = {
    info: 'border-indigo-200 bg-indigo-50 text-indigo-800',
    warn: 'border-amber-200 bg-amber-50 text-amber-800',
    ok: 'border-emerald-200 bg-emerald-50 text-emerald-800',
    err: 'border-rose-200 bg-rose-50 text-rose-800',
  }[kind];
  return (
    <div className={clsx('mb-4 rounded border px-3 py-2 text-sm', cls)}>{children}</div>
  );
};

const BackButton = ({ onBack }: { onBack: () => void }) => (
  <button
    type="button"
    onClick={onBack}
    className="rounded border border-slate-300 bg-white px-4 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
  >
    ← Back
  </button>
);

// --- Step 0: Pre-flight --------------------------------------------------

const Step0Preflight = ({ onAdvance }: { onAdvance: () => void }) => {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'ok'; checks: PreflightCheck[] }
    | { kind: 'fail'; checks: PreflightCheck[] }
    | { kind: 'error'; error: string }
  >({ kind: 'loading' });

  const check = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const res = await fetch('/api/preflight/check');
      const body = (await res.json()) as PreflightResponse;
      const checks = body.checks ?? [];
      if (body.ok && checks.every((c) => c.ok)) {
        setState({ kind: 'ok', checks });
      } else {
        setState({ kind: 'fail', checks });
      }
    } catch (e) {
      setState({ kind: 'error', error: (e as Error).message });
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  // Auto-advance on success after a brief flash.
  useEffect(() => {
    if (state.kind === 'ok') {
      const t = setTimeout(onAdvance, 600);
      return () => { clearTimeout(t); };
    }
  }, [state, onAdvance]);

  return (
    <div>
      <h2 className="mb-2 text-base font-semibold text-slate-800">Pre-flight check</h2>
      <p className="mb-4 text-sm text-slate-600">
        Verifying your machine has the runtimes the scraper needs (Python,
        Node, Playwright Chromium, writable config dir).
      </p>
      {state.kind === 'loading' && (
        <Banner kind="info">
          <span className="inline-flex items-center gap-2">
            <span className="h-2 w-2 animate-pulse rounded-full bg-indigo-500" />
            Checking…
          </span>
        </Banner>
      )}
      {state.kind === 'ok' && (
        <Banner kind="ok">✓ Pre-flight passed — continuing…</Banner>
      )}
      {state.kind === 'error' && (
        <>
          <Banner kind="err">Pre-flight request failed: {state.error}</Banner>
          <button
            type="button"
            onClick={check}
            className="rounded bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700"
          >
            Re-check
          </button>
        </>
      )}
      {state.kind === 'fail' && (
        <>
          <Banner kind="err">Some checks failed — fix the items below and re-check.</Banner>
          <ul className="mb-4 space-y-3">
            {state.checks.map((c) => (
              <li key={c.name} className="rounded border border-slate-200 bg-white p-3">
                <div className="flex items-center gap-2">
                  <span
                    className={clsx(
                      'inline-flex h-5 w-5 items-center justify-center rounded-full text-xs font-bold',
                      c.ok ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700',
                    )}
                  >
                    {c.ok ? '✓' : '✗'}
                  </span>
                  <span className="font-medium text-slate-800">{c.name}</span>
                  {c.value && (
                    <code className="ml-2 truncate rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700">
                      {c.value}
                    </code>
                  )}
                </div>
                {!c.ok && c.fix && (
                  <pre className="mt-2 overflow-x-auto rounded bg-slate-900 p-2 text-xs text-slate-100">
                    <code>{c.fix}</code>
                  </pre>
                )}
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={check}
            className="rounded bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700"
          >
            Re-check
          </button>
        </>
      )}
    </div>
  );
};

// --- Step 1: LLM provider ------------------------------------------------

const Step1LLM = ({
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
  type AutoState =
    | { kind: 'loading' }
    | { kind: 'ok'; message: string }
    | { kind: 'fail' };
  const [autoState, setAutoState] = useState<AutoState>({ kind: 'loading' });
  const [showPicker, setShowPicker] = useState(false);
  const [providers, setProviders] = useState<LLMProvider[]>([]);
  const [selected, setSelected] = useState<LLMProvider | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [testState, setTestState] = useState<
    { kind: 'idle' } | { kind: 'loading' } | { kind: 'ok'; msg: string } | { kind: 'err'; msg: string }
  >({ kind: 'idle' });

  // Auto-detect on mount.
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/llm/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'auto' }),
        });
        const body = (await res.json()) as LLMTestResponse;
        if (body.ok) {
          setAutoState({ kind: 'ok', message: body.message ?? 'auto ok' });
        } else {
          setAutoState({ kind: 'fail' });
          setShowPicker(true);
        }
      } catch {
        setAutoState({ kind: 'fail' });
        setShowPicker(true);
      }
    })();
  }, []);

  // Lazy-load the provider list when the picker shows.
  useEffect(() => {
    if (!showPicker || providers.length > 0) return;
    (async () => {
      try {
        const res = await fetch('/api/llm/list');
        const body = (await res.json()) as LLMListResponse;
        if (body.ok && body.providers) setProviders(body.providers);
      } catch {
        /* leave empty — UI will say "no providers available" */
      }
    })();
  }, [showPicker, providers.length]);

  const advanceWith = useCallback(
    (name: LLMProviderName) => {
      setDraft({ ...draft, llm_provider: { name } });
      setTimeout(onAdvance, 600);
    },
    [draft, setDraft, onAdvance],
  );

  const onTestNoKey = useCallback(async () => {
    if (!selected) return;
    setTestState({ kind: 'loading' });
    try {
      const res = await fetch('/api/llm/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: selected.name }),
      });
      const body = (await res.json()) as LLMTestResponse;
      if (body.ok) {
        setTestState({ kind: 'ok', msg: body.message ?? 'ok' });
        advanceWith(selected.name);
      } else {
        setTestState({ kind: 'err', msg: body.message ?? body.error ?? 'failed' });
      }
    } catch (e) {
      setTestState({ kind: 'err', msg: (e as Error).message });
    }
  }, [selected, advanceWith]);

  const onSaveAndTest = useCallback(async () => {
    if (!selected) return;
    if (!apiKey.trim()) {
      setTestState({ kind: 'err', msg: 'API key required' });
      return;
    }
    setTestState({ kind: 'loading' });
    try {
      // 1) Save credential — DO NOT log/echo the key.
      const saveRes = await fetch('/api/llm/save-credential', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: selected.name, key: apiKey }),
      });
      const saveBody = (await saveRes.json()) as LLMSaveCredResponse;
      if (!saveBody.ok) {
        setTestState({ kind: 'err', msg: saveBody.error ?? 'save failed' });
        return;
      }
      // 2) Test connection.
      const testRes = await fetch('/api/llm/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: selected.name }),
      });
      const testBody = (await testRes.json()) as LLMTestResponse;
      if (testBody.ok) {
        setTestState({ kind: 'ok', msg: testBody.message ?? 'ok' });
        // Drop the in-memory key — it's safely on disk now.
        setApiKey('');
        advanceWith(selected.name);
      } else {
        setTestState({ kind: 'err', msg: testBody.message ?? testBody.error ?? 'test failed' });
      }
    } catch (e) {
      setTestState({ kind: 'err', msg: (e as Error).message });
    }
  }, [selected, apiKey, advanceWith]);

  return (
    <div>
      <h2 className="mb-2 text-base font-semibold text-slate-800">Pick an LLM provider</h2>
      <p className="mb-4 text-sm text-slate-600">
        The scraper uses an LLM to score jobs against your CV. Most users can
        keep auto-detect.
      </p>

      {autoState.kind === 'loading' && (
        <Banner kind="info">Detecting available providers…</Banner>
      )}

      {autoState.kind === 'ok' && !showPicker && (
        <>
          <Banner kind="ok">✓ LLM ready: {autoState.message}</Banner>
          <div className="flex gap-2">
            <BackButton onBack={onBack} />
            <button
              type="button"
              onClick={() => {
                setDraft({ ...draft, llm_provider: { name: 'auto' } });
                onAdvance();
              }}
              className="rounded bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700"
            >
              Continue →
            </button>
            <button
              type="button"
              onClick={() => { setShowPicker(true); }}
              className="rounded border border-slate-300 bg-white px-4 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
            >
              Change
            </button>
          </div>
        </>
      )}

      {showPicker && (
        <>
          {autoState.kind === 'fail' && (
            <Banner kind="warn">
              No provider auto-detected. Pick one below and (if needed) add an API key.
            </Banner>
          )}
          <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-2">
            {providers.map((p) => {
              const isSel = selected?.name === p.name;
              return (
                <button
                  key={p.name}
                  type="button"
                  aria-pressed={isSel}
                  onClick={() => {
                    setSelected(p);
                    setTestState({ kind: 'idle' });
                    setApiKey('');
                  }}
                  className={clsx(
                    'rounded border p-3 text-left transition focus:outline-none focus:ring-2 focus:ring-indigo-400',
                    isSel
                      ? 'border-indigo-500 bg-indigo-50 ring-1 ring-indigo-300'
                      : 'border-slate-200 bg-white hover:border-indigo-300 hover:bg-indigo-50/40',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-slate-800">{p.label}</span>
                    {p.free_tier && (
                      <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700">
                        Free tier
                      </span>
                    )}
                  </div>
                  <div className="mt-1 text-xs leading-snug text-slate-600">{p.blurb}</div>
                </button>
              );
            })}
          </div>

          {selected && (
            <div className="mb-4 rounded border border-slate-200 bg-slate-50 p-3">
              <div className="mb-2 text-sm font-semibold text-slate-800">{selected.label}</div>
              {selected.needs_key ? (
                <div className="space-y-2">
                  <label className="block text-xs font-medium text-slate-600">
                    API key ({selected.env_var ?? 'env var'})
                  </label>
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(e) => { setApiKey(e.target.value); }}
                    placeholder="paste key…"
                    autoComplete="off"
                    className="w-full rounded border border-slate-300 bg-white px-2 py-1 font-mono text-sm shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
                  />
                  <a
                    href={selected.help_url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-block text-xs text-indigo-700 underline hover:text-indigo-900"
                  >
                    Get a key →
                  </a>
                  <div>
                    <button
                      type="button"
                      onClick={onSaveAndTest}
                      disabled={testState.kind === 'loading' || !apiKey.trim()}
                      className="rounded bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                    >
                      {testState.kind === 'loading' ? 'Saving…' : 'Save & test'}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <p className="text-xs text-slate-600">No key needed — runs locally.</p>
                  <button
                    type="button"
                    onClick={onTestNoKey}
                    disabled={testState.kind === 'loading'}
                    className="rounded bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                  >
                    {testState.kind === 'loading' ? 'Testing…' : 'Test connection'}
                  </button>
                </div>
              )}
              {testState.kind === 'ok' && (
                <div className="mt-3 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                  ✓ {testState.msg}
                </div>
              )}
              {testState.kind === 'err' && (
                <div className="mt-3 rounded border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
                  ✗ {testState.msg}
                </div>
              )}
            </div>
          )}

          <div className="flex gap-2">
            <BackButton onBack={onBack} />
          </div>
        </>
      )}
    </div>
  );
};

// --- Step 2: Geo scope ---------------------------------------------------

const GEO_CARDS: { value: string; label: string; sub: string }[] = [
  { value: '', label: '(session default)', sub: "Uses LinkedIn's home filter" },
  { value: '103644278', label: 'United States', sub: '103644278' },
  { value: '101620260', label: 'Israel', sub: '101620260' },
  { value: '92000000', label: 'Worldwide', sub: '92000000' },
];

const Step2Geo = ({
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
  const [customOpen, setCustomOpen] = useState(false);
  const [custom, setCustom] = useState('');

  const pick = (value: string) => {
    setDraft({ ...draft, geo_id: value });
    onAdvance();
  };

  return (
    <div>
      <h2 className="mb-2 text-base font-semibold text-slate-800">Pick a geo scope</h2>
      <p className="mb-4 text-sm text-slate-600">
        Where should the scraper look? You can change this later in Crawler Config.
      </p>
      <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-2">
        {GEO_CARDS.map((g) => {
          const isSel = (draft.geo_id ?? '') === g.value;
          return (
            <button
              key={g.value}
              type="button"
              aria-pressed={isSel}
              onClick={() => { pick(g.value); }}
              className={clsx(
                'rounded border p-4 text-left transition focus:outline-none focus:ring-2 focus:ring-indigo-400',
                isSel
                  ? 'border-indigo-500 bg-indigo-50 ring-1 ring-indigo-300'
                  : 'border-slate-200 bg-white hover:border-indigo-300 hover:bg-indigo-50/40',
              )}
            >
              <div className="font-semibold text-slate-800">{g.label}</div>
              <div className="mt-1 text-xs text-slate-500">{g.sub}</div>
            </button>
          );
        })}
      </div>

      <div className="mb-4 rounded border border-slate-200 bg-white">
        <button
          type="button"
          onClick={() => { setCustomOpen((v) => !v); }}
          className="flex w-full items-center justify-between rounded-t px-3 py-2 text-left text-sm hover:bg-slate-50"
        >
          <span className="font-medium text-slate-700">Custom URN</span>
          <span className="text-xs text-slate-400">{customOpen ? '▼' : '▶'}</span>
        </button>
        {customOpen && (
          <div className="border-t border-slate-100 p-3">
            <p className="mb-2 text-xs text-slate-500">
              Numeric LinkedIn geo URN (e.g. 101165590 for the UK).
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                inputMode="numeric"
                value={custom}
                onChange={(e) => { setCustom(e.target.value.replace(/[^\d]/g, '')); }}
                placeholder="e.g. 101165590"
                className="flex-1 rounded border border-slate-300 bg-white px-2 py-1 font-mono text-sm shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
              />
              <button
                type="button"
                disabled={!custom}
                onClick={() => { pick(custom); }}
                className="rounded bg-indigo-600 px-3 py-1 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                Use
              </button>
            </div>
          </div>
        )}
      </div>

      <div>
        <BackButton onBack={onBack} />
      </div>
    </div>
  );
};

// --- Step 3: LinkedIn mode -----------------------------------------------

const formatRelTime = (iso: string): string => {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
};

const Step3Mode = ({
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

// Read an uploaded file as UTF-8 text. PDFs go through the server-side
// pypdf extractor at /api/cv/extract-pdf — FileReader.readAsText() on
// PDF binary returns gibberish. Plain-text files (.txt / .md) round-trip
// through the browser as before.
const readFileAsText = async (file: File): Promise<string> => {
  const isPdf = file.type === 'application/pdf' ||
    file.name.toLowerCase().endsWith('.pdf');
  if (isPdf) {
    const buf = await file.arrayBuffer();
    const res = await fetch('/api/cv/extract-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf' },
      body: buf,
    });
    const j = (await res.json().catch(() => ({}))) as
      { ok?: boolean; text?: string; error?: string };
    if (!res.ok || !j.ok || typeof j.text !== 'string') {
      throw new Error(j.error ?? `extract-pdf failed (HTTP ${res.status.toString()})`);
    }
    return j.text;
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // FileReader.result is `string | ArrayBuffer | null` after readAsText;
      // for the text reader it's always string-or-null but we coerce
      // explicitly so the `string()` path can't surface "[object …]".
      const r = reader.result;
      resolve(typeof r === 'string' ? r : '');
    };
    reader.onerror = () => { reject(reader.error ?? new Error('read failed')); };
    reader.readAsText(file);
  });
};

// --- Step 4: CV upload (existing) ----------------------------------------

const Step4CV = ({
  cv,
  setCv,
  onNext,
  onBack,
  haveExistingConfig,
}: {
  cv: string;
  setCv: (v: string) => void;
  onNext: () => void;
  onBack: () => void;
  haveExistingConfig: boolean;
}) => {
  const [pdfErr, setPdfErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const onFile = useCallback(async (file: File) => {
    setPdfErr(null);
    try {
      const text = await readFileAsText(file);
      setCv(text);
    } catch (e) {
      // Surface the real reason (image-only PDF, encrypted, too big, …)
      // so the user knows whether to paste instead or re-export the PDF.
      setPdfErr((e as Error).message || 'failed to read file');
    }
  }, [setCv]);

  // On mobile we collapse the "you already have a config" callout by default
  // so the CV upload stays above the fold (the callout's full prose pushes
  // the textarea + Choose-File button off-screen on a 390px viewport).
  const { isMobile } = useViewport();
  const [calloutOpen, setCalloutOpen] = useState(!isMobile);
  return (
    <div>
      {haveExistingConfig && (
        <>
          {/* Mobile: collapsed by default — one-line summary + a "?" toggle.
              Desktop: full callout body inline (the original Banner). */}
          <div className="mb-4 md:hidden">
            <button
              type="button"
              onClick={() => { setCalloutOpen((v) => !v); }}
              aria-expanded={calloutOpen}
              className="flex w-full items-center justify-between rounded border border-indigo-200 bg-indigo-50 px-3 py-2 text-left text-sm text-indigo-800"
            >
              <span>You already have a config — saved as a new profile by default.</span>
              <span className="ml-2 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-indigo-300 text-xs font-semibold">
                {calloutOpen ? '−' : '?'}
              </span>
            </button>
            {calloutOpen && (
              <div className="mt-1 rounded border border-indigo-100 bg-indigo-50/60 px-3 py-2 text-xs text-indigo-800">
                At the end of setup you can either save the generated config
                as a <span className="font-semibold">new profile</span>{' '}
                (recommended — keeps your current one untouched) or{' '}
                <span className="font-semibold">overwrite the active profile</span>.
              </div>
            )}
          </div>
          <div className="hidden md:block">
            <Banner kind="info">
              You already have a config. At the end of setup you can either save
              the generated one as a <span className="font-semibold">new profile</span>{' '}
              (recommended — keeps your current one untouched) or{' '}
              <span className="font-semibold">overwrite the active profile</span>.
            </Banner>
          </div>
        </>
      )}
      <h2 className="mb-2 text-base font-semibold text-slate-800">Your CV</h2>
      <p className="mb-3 text-sm text-slate-600">
        Upload a plain-text or PDF file, or paste below. The scraper will score
        jobs against this CV on every run.
      </p>
      <div className="mb-3 flex items-center gap-3">
        <input
          ref={fileRef}
          type="file"
          accept=".txt,.md,.pdf,text/plain"
          className="block text-sm text-slate-600 file:mr-3 file:rounded file:border-0 file:bg-indigo-50 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-indigo-700 hover:file:bg-indigo-100"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) await onFile(f);
          }}
        />
        {cv && (
          <button
            type="button"
            onClick={() => {
              setCv('');
              setPdfErr(null);
              if (fileRef.current) fileRef.current.value = '';
            }}
            className="text-xs text-slate-500 hover:text-rose-600"
          >
            Clear
          </button>
        )}
      </div>
      {pdfErr && (
        <Banner kind="warn">
          {pdfErr} — paste the plain text below instead.
        </Banner>
      )}
      <textarea
        value={cv}
        onChange={(e) => { setCv(e.target.value); }}
        placeholder="Paste your CV here…"
        className="h-72 w-full rounded border border-slate-300 bg-white p-3 text-sm font-mono leading-5 shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
      />
      <div className="mt-2 flex items-center justify-between">
        <span className="text-xs text-slate-500">
          {cv.length.toLocaleString()} chars
          {cv.length < CV_MIN_CHARS && ` (need ≥ ${CV_MIN_CHARS})`}
        </span>
        <div className="flex gap-2">
          <BackButton onBack={onBack} />
          <button
            type="button"
            onClick={onNext}
            disabled={cv.length < CV_MIN_CHARS}
            className="rounded bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Next →
          </button>
        </div>
      </div>
    </div>
  );
};

// --- Step 5: Intent (existing) -------------------------------------------

const Step5Intent = ({
  intent,
  setIntent,
  onBack,
  onNext,
}: {
  intent: string;
  setIntent: (v: string) => void;
  onBack: () => void;
  onNext: () => void;
}) => (
  <div>
    <h2 className="mb-2 text-base font-semibold text-slate-800">What do you want?</h2>
    <p className="mb-3 text-sm text-slate-600">
      One paragraph, as specific as you can. Seniority, stack, remote/on-site,
      industries, company size, hard no-gos. This drives both the search
      queries and the per-job scoring prompt.
    </p>
    <textarea
      value={intent}
      onChange={(e) => { setIntent(e.target.value); }}
      placeholder="e.g. Staff/principal backend or platform engineer, Go or Rust preferred, remote-friendly, mid-size infra companies, no sales / no smart-contract dev / no interviews that require LeetCode live coding…"
      className="h-56 w-full rounded border border-slate-300 bg-white p-3 text-sm leading-6 shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
    />
    <div className="mt-2 flex items-center justify-between">
      <span className="text-xs text-slate-500">
        {intent.length} chars
        {intent.length < INTENT_MIN_CHARS && ` (need ≥ ${INTENT_MIN_CHARS})`}
      </span>
      <div className="flex gap-2">
        <BackButton onBack={onBack} />
        <button
          type="button"
          onClick={onNext}
          disabled={intent.length < INTENT_MIN_CHARS}
          className="rounded bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Next →
        </button>
      </div>
    </div>
  </div>
);

// --- Step 6 helpers (existing) -------------------------------------------

const Expandable = ({
  label,
  count,
  children,
  defaultOpen = false,
}: {
  label: string;
  count: number;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded border border-slate-200 bg-white">
      <button
        type="button"
        onClick={() => { setOpen((v) => !v); }}
        className="flex w-full items-center justify-between rounded-t px-3 py-2 text-left text-sm hover:bg-slate-50"
      >
        <span>
          <span className="font-medium text-slate-800">{label}</span>{' '}
          <span className="text-slate-500">({count})</span>
        </span>
        <span className="text-xs text-slate-400">{open ? '▼' : '▶'}</span>
      </button>
      {open && <div className="border-t border-slate-100 px-3 py-2 text-sm">{children}</div>}
    </div>
  );
};

const ConfigInspector = ({ cfg }: { cfg: CrawlerConfig }) => {
  const promptPreview = (cfg.claude_scoring_prompt ?? '').slice(0, 600);
  const promptRest = (cfg.claude_scoring_prompt ?? '').length - promptPreview.length;
  return (
    <div className="space-y-2">
      <div className="text-xs text-slate-500">
        geo_id: <code>{cfg.geo_id || '(session default)'}</code> · location:{' '}
        <code>{cfg.location || '(empty)'}</code> · max_pages: {cfg.max_pages}
      </div>
      <Expandable
        label="Categories"
        count={cfg.categories.length}
        defaultOpen
      >
        <ul className="space-y-2">
          {cfg.categories.map((c) => (
            <li key={c.id}>
              <div className="text-xs font-semibold text-slate-700">
                {c.name}{' '}
                <span className="font-normal text-slate-500">
                  [{c.type}, {c.queries.length}]
                </span>
              </div>
              <ul className="ml-4 list-disc text-xs text-slate-600">
                {c.queries.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </Expandable>
      <Expandable
        label="Priority companies"
        count={cfg.priority_companies.length}
      >
        <div className="flex flex-wrap gap-1 text-xs">
          {cfg.priority_companies.map((p, i) => (
            <span key={i} className="rounded bg-slate-100 px-2 py-0.5 text-slate-700">
              {p}
            </span>
          ))}
        </div>
      </Expandable>
      <Expandable
        label="Scoring prompt"
        count={(cfg.claude_scoring_prompt ?? '').length}
      >
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2 text-xs text-slate-700">
          {promptPreview}
          {promptRest > 0 ? `\n… (+${promptRest} more chars)` : ''}
        </pre>
      </Expandable>
      <Expandable
        label="Fit positive patterns"
        count={(cfg.fit_positive_patterns ?? []).length}
      >
        <ul className="space-y-0.5 font-mono text-xs text-slate-600">
          {(cfg.fit_positive_patterns ?? []).map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      </Expandable>
      <Expandable
        label="Fit negative patterns"
        count={(cfg.fit_negative_patterns ?? []).length}
      >
        <ul className="space-y-0.5 font-mono text-xs text-slate-600">
          {(cfg.fit_negative_patterns ?? []).map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      </Expandable>
      <Expandable
        label="Off-topic title patterns"
        count={(cfg.offtopic_title_patterns ?? []).length}
      >
        <ul className="space-y-0.5 font-mono text-xs text-slate-600">
          {(cfg.offtopic_title_patterns ?? []).map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      </Expandable>
    </div>
  );
};

// --- Step 6: Generate + review (existing, draft-aware) -------------------

type GenState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'success'; config: CrawlerConfig; raw: string }
  | { kind: 'error'; error: string; raw: string };

const Step6Generate = ({
  cv,
  intent,
  current,
  draft,
  haveExisting,
  onBack,
  onSaved,
}: {
  cv: string;
  intent: string;
  current: CrawlerConfig | null;
  draft: WizardDraft;
  haveExisting: boolean;
  onBack: () => void;
  onSaved: (profileName?: string) => void;
}) => {
  const [gen, setGen] = useState<GenState>({ kind: 'idle' });
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [profileName, setProfileName] = useState<string>(() => defaultProfileName());

  const generate = useCallback(async () => {
    setGen({ kind: 'loading' });
    try {
      const res = await fetch('/api/onboarding/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cv, intent }),
      });
      const body = (await res.json()) as GenerateResponse;
      if (body.ok && body.config && typeof body.config === 'object') {
        // Splice the wizard's geo/llm/mode picks INTO the generated config
        // so the saved config reflects all eight wizard steps.
        const merged = normalizeConfig(body.config);
        if (draft.geo_id !== undefined) merged.geo_id = draft.geo_id;
        if (draft.llm_provider) merged.llm_provider = draft.llm_provider;
        if (draft.default_mode) merged.default_mode = draft.default_mode;
        setGen({ kind: 'success', config: merged, raw: body.raw ?? '' });
      } else {
        setGen({
          kind: 'error',
          error: body.error ?? `HTTP ${res.status}`,
          raw: body.raw ?? '',
        });
      }
    } catch (e) {
      setGen({
        kind: 'error',
        error: (e as Error).message,
        raw: '',
      });
    }
  }, [cv, intent, draft]);

  // Auto-kick generation on first mount.
  const kicked = useRef(false);
  useEffect(() => {
    if (!kicked.current) {
      kicked.current = true;
      void generate();
    }
  }, [generate]);

  // Build the wire-format config payload (drops client-only category ids and
  // any undefineds the backend would reject). Shared by both save buttons.
  // Includes the wizard's llm_provider / geo_id / default_mode picks.
  const buildConfigPayload = useCallback((cfg: CrawlerConfig): Record<string, unknown> => {
    const payload: Record<string, unknown> = {
      categories: cfg.categories.map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        queries: c.queries,
      })),
      location: cfg.location,
      date_filter: cfg.date_filter,
      geo_id: cfg.geo_id,
      max_pages: cfg.max_pages,
      priority_companies: cfg.priority_companies,
    };
    if (cfg.claude_scoring_prompt) {
      payload.claude_scoring_prompt = cfg.claude_scoring_prompt;
    }
    if (cfg.fit_positive_patterns) payload.fit_positive_patterns = cfg.fit_positive_patterns;
    if (cfg.fit_negative_patterns) payload.fit_negative_patterns = cfg.fit_negative_patterns;
    if (cfg.offtopic_title_patterns) payload.offtopic_title_patterns = cfg.offtopic_title_patterns;
    if (cfg.llm_provider) {
      const lp: Record<string, unknown> = { name: cfg.llm_provider.name };
      if (cfg.llm_provider.model) lp.model = cfg.llm_provider.model;
      payload.llm_provider = lp;
    }
    if (cfg.default_mode === 'guest' || cfg.default_mode === 'loggedin') {
      payload.default_mode = cfg.default_mode;
    }
    return payload;
  }, []);

  // Overwrite the currently-active profile in place. Kept for the
  // "regenerate this profile" use case.
  const saveOverwrite = useCallback(async () => {
    if (gen.kind !== 'success') return;
    setSaving(true);
    setSaveErr(null);
    try {
      const res = await fetch('/api/onboarding/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cv, config: buildConfigPayload(gen.config) }),
      });
      const body = (await res.json()) as SaveResponse;
      if (!body.ok) {
        setSaveErr(body.error ?? `HTTP ${res.status}`);
      } else {
        onSaved();
      }
    } catch (e) {
      setSaveErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }, [buildConfigPayload, cv, gen, onSaved]);

  // Save as a NEW named profile, then activate it. Default for the friend-flow.
  const saveAsNewProfile = useCallback(async () => {
    if (gen.kind !== 'success') return;
    if (!PROFILE_NAME_RE.test(profileName)) {
      setSaveErr(
        'Profile name must be 1-40 chars: letters, digits, underscore, hyphen; first char alphanumeric.',
      );
      return;
    }
    setSaving(true);
    setSaveErr(null);
    try {
      const res = await fetch('/api/onboarding/save-as-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cv,
          config: buildConfigPayload(gen.config),
          profile_name: profileName,
        }),
      });
      const body = (await res.json()) as SaveResponse;
      if (!body.ok) {
        setSaveErr(body.error ?? `HTTP ${res.status}`);
      } else {
        onSaved(body.profile ?? profileName);
      }
    } catch (e) {
      setSaveErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }, [buildConfigPayload, cv, gen, onSaved, profileName]);

  return (
    <div>
      <h2 className="mb-2 text-base font-semibold text-slate-800">Generate & review</h2>
      {gen.kind === 'loading' && (
        <Banner kind="info">
          <span className="inline-flex items-center gap-2">
            <span className="h-2 w-2 animate-pulse rounded-full bg-indigo-500" />
            Generating your config… this takes up to 3 minutes.
          </span>
        </Banner>
      )}
      {gen.kind === 'error' && (
        <>
          <Banner kind="err">
            Generation failed: {gen.error}
          </Banner>
          {gen.raw && (
            <details className="mb-3 rounded border border-slate-200 bg-white p-3 text-xs">
              <summary className="cursor-pointer text-slate-600">Raw model output</summary>
              <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap text-slate-700">
                {gen.raw}
              </pre>
            </details>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onBack}
              className="rounded border border-slate-300 bg-white px-4 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
            >
              ← Edit intent
            </button>
            <button
              type="button"
              onClick={generate}
              className="rounded bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700"
            >
              Retry
            </button>
          </div>
        </>
      )}

      {gen.kind === 'success' && (
        <>
          {haveExisting ? (
            // Returning user — show side-by-side so they can see what's
            // changing before they choose between new-profile and overwrite.
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <section>
                <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-indigo-700">
                  Generated
                </div>
                <ConfigInspector cfg={gen.config} />
              </section>
              <section>
                <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Current
                </div>
                {current ? (
                  <ConfigInspector cfg={current} />
                ) : (
                  <div className="rounded border border-dashed border-slate-300 p-3 text-sm italic text-slate-500">
                    No existing config — this will be your first one.
                  </div>
                )}
              </section>
            </div>
          ) : (
            // First-run — there's nothing to compare against (the "current"
            // is just the auto-created empty default profile). Render the
            // generated config full-width so it's the obvious focus.
            <section>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-indigo-700">
                Your config
              </div>
              <ConfigInspector cfg={gen.config} />
            </section>
          )}

          {saveErr && <div className="mt-4"><Banner kind="err">Save failed: {saveErr}</Banner></div>}

          <div className="mt-5 rounded border border-slate-200 bg-slate-50 p-3">
            {haveExisting ? (
              // Returning user — let them pick between new-profile (preserves
              // their current one) and overwrite (in-place edit).
              <>
                <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Profile name
                </label>
                <input
                  type="text"
                  value={profileName}
                  onChange={(e) => { setProfileName(e.target.value); }}
                  disabled={saving}
                  placeholder={defaultProfileName()}
                  className="mb-2 w-full max-w-sm rounded border border-slate-300 bg-white px-2 py-1 text-sm font-mono shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400 disabled:opacity-50"
                />
                <p className="text-xs text-slate-500">
                  Letters, digits, underscore, hyphen. Max 40 chars.
                </p>
              </>
            ) : (
              // First-run — only one meaningful action (write into the active
              // 'default' profile). Skip the profile-name input + the
              // new-vs-overwrite choice; both are noise here.
              <p className="text-xs text-slate-500">
                Saves into your active profile so the next scrape uses it.
              </p>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {haveExisting ? (
                <>
                  <button
                    type="button"
                    onClick={saveAsNewProfile}
                    disabled={saving || !PROFILE_NAME_RE.test(profileName)}
                    className="rounded bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                  >
                    {saving ? 'Saving…' : 'Save as new profile'}
                  </button>
                  <button
                    type="button"
                    onClick={saveOverwrite}
                    disabled={saving}
                    className="rounded border border-slate-300 bg-white px-4 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                    title="Overwrites the currently-active profile in place."
                  >
                    Overwrite active profile
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={saveOverwrite}
                  disabled={saving}
                  className="rounded bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
              )}
              <button
                type="button"
                onClick={generate}
                disabled={saving}
                className="rounded border border-slate-300 bg-white px-4 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Try again
              </button>
              <button
                type="button"
                onClick={onBack}
                disabled={saving}
                className="rounded border border-slate-300 bg-white px-4 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                ← Edit intent
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

// --- Step 7: What's next -------------------------------------------------

const Step7WhatsNext = ({
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

// --- Top-level page -----------------------------------------------------

export const OnboardingPage = ({
  onSwitchTab,
  onOnboarded,
}: {
  onSwitchTab: (tab: 'corpus' | 'config' | 'history') => void;
  // Called by the wizard after a successful Step 6 save so the parent App
  // can re-fetch /api/profiles and unlock the rest of the tabs. Without
  // this signal App's `onboarded` stays stale at false and the Step 7
  // navigation buttons silently no-op (App keeps force-rendering the wizard).
  onOnboarded?: () => void;
}) => {
  const [step, setStep] = useState<Step>(0);
  const [draft, setDraft] = useState<WizardDraft>({});
  const [cv, setCv] = useState('');
  const [intent, setIntent] = useState('');
  const [current, setCurrent] = useState<CrawlerConfig | null>(null);
  const [haveExisting, setHaveExisting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [savedProfile, setSavedProfile] = useState<string | null>(null);

  // Load current config on mount so we can show side-by-side diff and the
  // "you already have a config" banner. Note: config.json *always* exists
  // after _migrate_if_needed auto-creates a default profile on first ctl
  // call, so we can't use config existence as the "already onboarded" signal.
  // cv.txt is the real "user finished the wizard before" marker, same as in
  // App.tsx. /api/profiles reports cv_present.
  useEffect(() => {
    (async () => {
      try {
        const profiles = await fetch(`/api/profiles?t=${Date.now()}`);
        if (profiles.ok) {
          const j = (await profiles.json()) as { cv_present?: boolean };
          setHaveExisting(j.cv_present === true);
        }
        const res = await fetch(`/api/config?t=${Date.now()}`);
        if (res.ok) {
          const raw: unknown = await res.json();
          setCurrent(normalizeConfig(raw));
        }
      } catch {
        /* ignore; first-run user */
      }
    })();
  }, []);

  const canShowSaved = useMemo(() => saved && step !== 7, [saved, step]);

  return (
    <div className="mx-auto w-full max-w-4xl overflow-y-auto p-6">
      <h1 className="mb-1 text-lg font-semibold text-slate-900">Setup</h1>
      <p className="mb-4 text-sm text-slate-500">
        Walk through pre-flight, pick an LLM + geo + mode, then upload your CV
        so the LLM can build a tailored scraper config you'll review before saving.
      </p>

      {canShowSaved && (
        <Banner kind="ok">
          <span className="inline-flex items-center gap-3">
            <span>
              {savedProfile
                ? `Saved as profile '${savedProfile}' and activated. Your next scrape will use it.`
                : 'Config saved. Your next scrape will use it.'}
            </span>
            <button
              type="button"
              onClick={() => { onSwitchTab('config'); }}
              className="rounded bg-white px-2 py-0.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100"
            >
              Open Crawler Config →
            </button>
          </span>
        </Banner>
      )}

      <Stepper step={step} />

      {step === 0 && <Step0Preflight onAdvance={() => { setStep(1); }} />}
      {step === 1 && (
        <Step1LLM
          draft={draft}
          setDraft={setDraft}
          onAdvance={() => { setStep(2); }}
          onBack={() => { setStep(0); }}
        />
      )}
      {step === 2 && (
        <Step2Geo
          draft={draft}
          setDraft={setDraft}
          onAdvance={() => { setStep(3); }}
          onBack={() => { setStep(1); }}
        />
      )}
      {step === 3 && (
        <Step3Mode
          draft={draft}
          setDraft={setDraft}
          onAdvance={() => { setStep(4); }}
          onBack={() => { setStep(2); }}
        />
      )}
      {step === 4 && (
        <Step4CV
          cv={cv}
          setCv={setCv}
          onNext={() => { setStep(5); }}
          onBack={() => { setStep(3); }}
          haveExistingConfig={haveExisting}
        />
      )}
      {step === 5 && (
        <Step5Intent
          intent={intent}
          setIntent={setIntent}
          onBack={() => { setStep(4); }}
          onNext={() => { setStep(6); }}
        />
      )}
      {step === 6 && (
        <Step6Generate
          cv={cv}
          intent={intent}
          current={current}
          draft={draft}
          haveExisting={haveExisting}
          onBack={() => { setStep(5); }}
          onSaved={(name) => {
            setSavedProfile(name ?? null);
            setSaved(true);
            setStep(7);
            // Tell App to re-check cv_present so the user can leave the
            // wizard from Step 7 (otherwise App.tsx force-renders us).
            onOnboarded?.();
          }}
        />
      )}
      {step === 7 && (
        <Step7WhatsNext
          savedProfile={savedProfile}
          defaultMode={draft.default_mode ?? 'guest'}
          onSwitchTab={onSwitchTab}
          onDismiss={() => { onSwitchTab('corpus'); }}
        />
      )}
    </div>
  );
};

export default OnboardingPage;
