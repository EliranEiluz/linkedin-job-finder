// 9-step onboarding wizard. The Step components live under
// `./onboarding/steps/`; shared types in `./onboarding/types`; shared
// presentational primitives (Stepper, Banner, BackButton, ConfigInspector)
// in `./onboarding/components`. This file is just the orchestrator: it
// owns the step-state machine, the wizard draft, and the cv/intent inputs,
// and routes them through the matching step component.
//
// Step 6 (Notifications) was inserted between Intent (5) and the LLM-driven
// Generate (was 6, now 7). The internal file names of Step6Generate and
// Step7WhatsNext were kept rather than renamed to Step7/Step8 to keep the
// rename diff small; the Step <enum> values are the source of truth.
//
// POSTs to /api/onboarding/{generate,save,save-as-profile} are handled
// inside Step6Generate. Other steps hit /api/preflight, /api/llm/*,
// /api/notifications/*, /api/linkedin-session/*, /api/cv/*, /api/scrape.

import { useEffect, useMemo, useState } from 'react';
import type { CrawlerConfig } from './configTypes';
import { normalizeConfig } from './configMigrate';
import { Banner, Stepper } from './onboarding/components';
import { Step0Preflight } from './onboarding/steps/Step0Preflight';
import { Step1LLM } from './onboarding/steps/Step1LLM';
import { Step2Geo } from './onboarding/steps/Step2Geo';
import { Step3Mode } from './onboarding/steps/Step3Mode';
import { Step4CV } from './onboarding/steps/Step4CV';
import { Step5Intent } from './onboarding/steps/Step5Intent';
import { Step6Notifications } from './onboarding/steps/Step6Notifications';
import { Step6Generate } from './onboarding/steps/Step6Generate';
import { Step7WhatsNext } from './onboarding/steps/Step7WhatsNext';
import type { Step, WizardDraft } from './onboarding/types';

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
        const profiles = await fetch(`/api/profiles?t=${Date.now().toString()}`);
        if (profiles.ok) {
          const j = (await profiles.json()) as { cv_present?: boolean };
          setHaveExisting(j.cv_present === true);
        }
        const res = await fetch(`/api/config?t=${Date.now().toString()}`);
        if (res.ok) {
          const raw: unknown = await res.json();
          setCurrent(normalizeConfig(raw));
        }
      } catch {
        /* ignore; first-run user */
      }
    })();
  }, []);

  const canShowSaved = useMemo(() => saved && step !== 8, [saved, step]);

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
        <Step6Notifications
          onAdvance={() => { setStep(7); }}
          onBack={() => { setStep(5); }}
        />
      )}
      {step === 7 && (
        <Step6Generate
          cv={cv}
          intent={intent}
          current={current}
          draft={draft}
          haveExisting={haveExisting}
          onBack={() => { setStep(6); }}
          onSaved={(name) => {
            setSavedProfile(name ?? null);
            setSaved(true);
            setStep(8);
            // Tell App to re-check cv_present so the user can leave the
            // wizard from the final step (otherwise App.tsx force-renders us).
            onOnboarded?.();
          }}
        />
      )}
      {step === 8 && (
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
