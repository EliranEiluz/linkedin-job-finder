// Wizard step that lets the user pick which LLM provider the scraper
// uses for fit-scoring. Most of this file's body used to be a bespoke
// picker grid + credential form + test/save plumbing; that part has been
// extracted into the shared <LLMProviderSelector /> so the same UX can
// also run in a post-onboarding card inside the Crawler Config tab.
//
// What's left here is the wizard-only shell:
//   1. auto-detect on mount (POST /api/llm/test with name='auto')
//   2. happy path → "Continue / Change" buttons
//   3. fail path → show the shared picker
//   4. wizard navigation (Back + auto-advance on a green test)

import { useCallback, useEffect, useState } from 'react';
import type { LLMProviderName } from '../../configTypes';
import { LLMProviderSelector } from '../../LLMProviderSelector';
import { LLM_TEST_URL, type LLMTestResponse } from '../../llmApi';
import { Banner, BackButton } from '../components';
import type { WizardDraft } from '../types';

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

  // Auto-detect on mount. Same call the wizard always made — the shared
  // selector deliberately doesn't own this because the card variant
  // shouldn't auto-detect (the user opened it specifically to change
  // their provider, not to be told one already works).
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(LLM_TEST_URL, {
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

  // When the picker reports a green test, capture the choice on the
  // wizard draft and auto-advance after a short pause so the user sees
  // the "Connected ✓" banner before the step changes.
  const advanceWith = useCallback(
    (name: LLMProviderName) => {
      setDraft({ ...draft, llm_provider: { name } });
      setTimeout(onAdvance, 600);
    },
    [draft, setDraft, onAdvance],
  );

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
          <LLMProviderSelector
            initialProviderName={draft.llm_provider?.name}
            onTestSuccess={advanceWith}
          />
          <div className="flex gap-2">
            <BackButton onBack={onBack} />
          </div>
        </>
      )}
    </div>
  );
};
