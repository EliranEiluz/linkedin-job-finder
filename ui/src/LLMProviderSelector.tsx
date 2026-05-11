// Shared LLM provider picker — extracted from the onboarding wizard's
// Step1LLM so the same UX can also live in a post-onboarding card inside
// the Crawler Config tab.
//
// Owns:
//   - lazy-loaded provider list from /api/llm/list
//   - selection state
//   - credential input for providers where needs_key=true
//   - "Test connection" (no-key path) or "Save & test" (key path)
//   - inline status (✓ / ✗) under the selected provider's panel
//
// Does NOT own:
//   - auto-detect flow (wizard-only; lives in Step1LLM wrapper)
//   - wizard navigation (Back/Continue; lives in Step1LLM wrapper)
//   - config save (the parent decides what to do once a provider tests
//     green; wizard sets `draft.llm_provider`, the card writes through
//     the existing `/api/config` save path)
//
// Model selection is intentionally NOT here — that's a separate task
// (#114). A `<div data-slot="model-picker" />` placeholder is left in
// the selected-provider panel so the model dropdown can slot in later
// without re-flowing the layout.

import { useCallback, useEffect, useState } from 'react';
import clsx from 'clsx';
import type { LLMProviderName } from './configTypes';
import {
  LLM_LIST_URL,
  LLM_SAVE_CRED_URL,
  LLM_TEST_URL,
  type LLMProvider,
  type LLMListResponse,
  type LLMSaveCredResponse,
  type LLMTestResponse,
} from './llmApi';

export type TestState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ok'; msg: string }
  | { kind: 'err'; msg: string };

export interface LLMProviderSelectorProps {
  // Provider name to highlight on mount, if it exists in the fetched list.
  // The wizard passes the draft's current value; the card passes the
  // active config's. Pass undefined to leave nothing selected initially.
  initialProviderName?: LLMProviderName;
  // Called whenever a provider tests green. Parent decides what to do
  // with the change — wizard sets draft + auto-advances; card kicks the
  // parent's "save config" flow.
  onTestSuccess: (name: LLMProviderName) => void;
  // Optional callback when the list arrives — wizard uses this to know
  // when its lazy-load completed so it can stop showing a loading banner.
  onProvidersLoaded?: (providers: LLMProvider[]) => void;
  // Hides the "Connected ✓" success banner once the parent has consumed
  // the onTestSuccess signal (e.g. wizard advances to the next step).
  // Defaults to false so the success state stays visible in the card.
  clearStatusOnSuccess?: boolean;
}

// Hits the same three endpoints as Step1LLM. Endpoint constants live in
// llmApi.ts so any future move is a one-line change.
export const LLMProviderSelector = ({
  initialProviderName,
  onTestSuccess,
  onProvidersLoaded,
  clearStatusOnSuccess = false,
}: LLMProviderSelectorProps) => {
  const [providers, setProviders] = useState<LLMProvider[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [selected, setSelected] = useState<LLMProvider | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [testState, setTestState] = useState<TestState>({ kind: 'idle' });

  // Fetch the provider catalog once on mount. Same endpoint Step1LLM
  // used; the catalog is small and stable.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(LLM_LIST_URL);
        const body = (await res.json()) as LLMListResponse;
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- mutated by cleanup
        if (cancelled) return;
        if (body.ok && body.providers) {
          setProviders(body.providers);
          onProvidersLoaded?.(body.providers);
        } else {
          setListError(body.error ?? 'Could not load provider list.');
        }
      } catch (e) {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- mutated by cleanup
        if (!cancelled) setListError((e as Error).message);
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- mutated by cleanup
        if (!cancelled) setListLoading(false);
      }
    })();
    return () => { cancelled = true; };
  // onProvidersLoaded is intentionally not a dependency — we only want
  // to fire it on the initial fetch, not whenever the parent rebinds the
  // callback. Same pattern as the wizard's original lazy-load effect.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pre-select the parent's initial choice once the catalog arrives.
  // We only auto-select if the user hasn't already clicked a different
  // tile (which would set `selected` and short-circuit this effect).
  useEffect(() => {
    if (selected) return;
    if (!initialProviderName) return;
    const match = providers.find((p) => p.name === initialProviderName);
    if (match) setSelected(match);
  }, [providers, initialProviderName, selected]);

  const onSelect = useCallback((p: LLMProvider) => {
    setSelected(p);
    setTestState({ kind: 'idle' });
    setApiKey('');
  }, []);

  // No-key path: hit /api/llm/test directly. claude_cli + ollama both
  // take this branch (needs_key=false). On success we surface the
  // status AND notify the parent so it can persist the choice.
  const onTestNoKey = useCallback(async () => {
    if (!selected) return;
    setTestState({ kind: 'loading' });
    try {
      const res = await fetch(LLM_TEST_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: selected.name }),
      });
      const body = (await res.json()) as LLMTestResponse;
      if (body.ok) {
        if (clearStatusOnSuccess) {
          setTestState({ kind: 'idle' });
        } else {
          setTestState({ kind: 'ok', msg: body.message ?? 'Connected' });
        }
        onTestSuccess(selected.name);
      } else {
        setTestState({ kind: 'err', msg: body.message ?? body.error ?? 'failed' });
      }
    } catch (e) {
      setTestState({ kind: 'err', msg: (e as Error).message });
    }
  }, [selected, onTestSuccess, clearStatusOnSuccess]);

  // Key path: save the credential first (sensitive — never logged), then
  // hit /api/llm/test. The in-memory key is dropped after a green save
  // so the password input clears.
  const onSaveAndTest = useCallback(async () => {
    if (!selected) return;
    if (!apiKey.trim()) {
      setTestState({ kind: 'err', msg: 'API key required' });
      return;
    }
    setTestState({ kind: 'loading' });
    try {
      const saveRes = await fetch(LLM_SAVE_CRED_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: selected.name, key: apiKey }),
      });
      const saveBody = (await saveRes.json()) as LLMSaveCredResponse;
      if (!saveBody.ok) {
        setTestState({ kind: 'err', msg: saveBody.error ?? 'save failed' });
        return;
      }
      const testRes = await fetch(LLM_TEST_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: selected.name }),
      });
      const testBody = (await testRes.json()) as LLMTestResponse;
      if (testBody.ok) {
        setApiKey('');
        if (clearStatusOnSuccess) {
          setTestState({ kind: 'idle' });
        } else {
          setTestState({ kind: 'ok', msg: testBody.message ?? 'Connected' });
        }
        onTestSuccess(selected.name);
      } else {
        setTestState({ kind: 'err', msg: testBody.message ?? testBody.error ?? 'test failed' });
      }
    } catch (e) {
      setTestState({ kind: 'err', msg: (e as Error).message });
    }
  }, [selected, apiKey, onTestSuccess, clearStatusOnSuccess]);

  if (listLoading) {
    return (
      <div className="rounded border border-slate-200 bg-slate-50 px-3 py-3 text-xs text-slate-500">
        Loading provider list…
      </div>
    );
  }
  if (listError) {
    return (
      <div className="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
        <div className="font-semibold">Could not load LLM providers</div>
        <div className="mt-0.5 break-all">{listError}</div>
      </div>
    );
  }

  return (
    <div data-testid="llm-provider-selector">
      <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-2">
        {providers.map((p) => {
          const isSel = selected?.name === p.name;
          const isCurrent = initialProviderName === p.name;
          return (
            <button
              key={p.name}
              type="button"
              aria-pressed={isSel}
              aria-label={`Select ${p.label}`}
              onClick={() => { onSelect(p); }}
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
                {isCurrent && !isSel && (
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600">
                    Active
                  </span>
                )}
              </div>
              <div className="mt-1 text-xs leading-snug text-slate-600">{p.blurb}</div>
            </button>
          );
        })}
      </div>

      {selected && (
        <div className="mb-2 rounded border border-slate-200 bg-slate-50 p-3">
          <div className="mb-2 text-sm font-semibold text-slate-800">{selected.label}</div>

          {/* Reserved slot for the model dropdown — task #114 will wire
              it. Keeping the placeholder so the layout doesn't reflow
              when the dropdown lands. */}
          <div data-slot="model-picker" />

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
                aria-label={`${selected.label} API key`}
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
                  onClick={() => void onSaveAndTest()}
                  disabled={testState.kind === 'loading' || !apiKey.trim()}
                  className="rounded bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                >
                  {testState.kind === 'loading' ? 'Saving…' : 'Save & test'}
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-xs text-slate-600">
                {selected.name === 'claude_cli'
                  ? 'No key needed — uses your local `claude` CLI sign-in.'
                  : 'No key needed — runs locally.'}
              </p>
              <button
                type="button"
                onClick={() => void onTestNoKey()}
                disabled={testState.kind === 'loading'}
                className="rounded bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {testState.kind === 'loading' ? 'Testing…' : 'Test connection'}
              </button>
            </div>
          )}

          {testState.kind === 'ok' && (
            <div
              role="status"
              className="mt-3 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
            >
              ✓ Connected — {testState.msg}
            </div>
          )}
          {testState.kind === 'err' && (
            <div
              role="alert"
              className="mt-3 rounded border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800"
            >
              ✗ {testState.msg}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
