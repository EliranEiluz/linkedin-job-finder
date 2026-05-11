// Post-onboarding LLM provider card — lives in the Crawler Config tab
// between the Scheduler and Remote Access cards. Reuses the shared
// <LLMProviderSelector />; the card's only job is the visual chrome
// (header + status chip + small description) and wiring "tested green"
// → "persist via the parent's config-save callback".
//
// The wizard's auto-detect dance does NOT happen here. A user opening
// this card has already onboarded with some choice (or "auto"); they're
// here because they want to change it. Showing them a stale "auto ok"
// banner would be misleading. The currently-active provider is rendered
// in the header chip + highlighted in the picker grid.

import { useCallback, useState } from 'react';
import clsx from 'clsx';
import type { LLMProviderName, LLMProviderConfig } from './configTypes';
import { LLMProviderSelector } from './LLMProviderSelector';

// Friendly labels for the header chip. Kept here (not in the selector)
// because the selector renders providers it fetched from the backend
// catalog — the catalog has labels for the six real providers, but the
// header chip can also need to render "Auto" which is a meta-choice that
// never appears in the catalog.
const PROVIDER_LABELS: Record<LLMProviderName, string> = {
  auto: 'Auto-detect',
  claude_cli: 'Claude Code (CLI)',
  claude_sdk: 'Claude API (key)',
  gemini: 'Google Gemini',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  ollama: 'Ollama (local)',
};

export interface LLMProviderCardProps {
  // The current llm_provider field from the draft config. Card surfaces
  // its name in the header chip + uses it as the selector's initial
  // highlight.
  current: LLMProviderConfig | undefined;
  // Called when the user has tested a new provider green AND wants to
  // persist it. The card never writes /api/config itself — it bubbles
  // the change up so the parent (ConfigPage) can run the full
  // serialize/save path that the rest of the page already uses.
  onChange: (next: LLMProviderConfig) => void;
}

export const LLMProviderCard = ({ current, onChange }: LLMProviderCardProps) => {
  // Tracks the most-recent name reported as tested-green by the picker
  // — used to render an inline toast-ish "Saved ✓" hint so the user knows
  // their click landed. Cleared when the user picks something else.
  const [savedName, setSavedName] = useState<LLMProviderName | null>(null);

  const handleTestSuccess = useCallback(
    (name: LLMProviderName) => {
      setSavedName(name);
      // model is intentionally NOT touched here — task #114 (model
      // selection) will revisit this. For now we keep whatever model was
      // on the previous LLMProviderConfig if the name matches, otherwise
      // drop to provider default (undefined).
      const next: LLMProviderConfig =
        current?.name === name && current.model
          ? { name, model: current.model }
          : { name };
      onChange(next);
    },
    [current, onChange],
  );

  const currentLabel = current ? PROVIDER_LABELS[current.name] : PROVIDER_LABELS.auto;

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="mb-1 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-600">
          LLM provider
        </h2>
        <span
          className={clsx(
            'inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700',
          )}
          data-testid="llm-provider-current"
        >
          Active: {currentLabel}
        </span>
      </div>
      <p className="mb-3 text-xs text-slate-500">
        The scraper uses an LLM to score jobs against your CV. Pick a
        provider, paste a key (where needed), and click test — your choice
        is saved to the active profile&apos;s config after a green test.
      </p>

      <LLMProviderSelector
        initialProviderName={current?.name}
        onTestSuccess={handleTestSuccess}
      />

      {savedName && (
        <div
          role="status"
          className="mt-2 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800"
        >
          Provider set to <span className="font-semibold">{PROVIDER_LABELS[savedName]}</span>
          {' '}— applies to the next scraper run.
        </div>
      )}
    </section>
  );
};
