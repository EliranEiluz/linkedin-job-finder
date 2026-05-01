import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import type { LLMProviderName } from '../../configTypes';
import { Banner, BackButton } from '../components';
import type {
  LLMListResponse,
  LLMProvider,
  LLMSaveCredResponse,
  LLMTestResponse,
  WizardDraft,
} from '../types';

export const Step1LLM = ({
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
