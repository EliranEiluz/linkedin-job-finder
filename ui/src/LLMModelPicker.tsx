// Shared model + reasoning-effort picker. Lands inside the
// LLMProviderSelector's `<div data-slot="model-picker" />` placeholder
// and the LLMProviderCard's body. Task #114.
//
// Owns:
//   - lazy-fetch of /api/llm/models?provider=X once credentials are present
//   - model dropdown (with a search input above when there are 20+ entries)
//   - contextual reasoning-effort control that adapts to the selected
//     model's `reasoning.shape`:
//       levels  -> dropdown of declared levels + "off"
//       budget  -> number input with min/max + "dynamic" toggle (value=-1)
//       boolean -> on/off toggle
//       none    -> control hidden
//
// Does NOT own:
//   - credential entry (the provider selector does that — model fetch is
//     triggered only after the user has actually tested the credential
//     green or the provider doesn't need one)
//   - config save (the parent decides; the picker fires onChange with the
//     full {model, reasoning_effort} pair and lets the wrapper persist it
//     via its existing save path)

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { LLMProviderName, ReasoningEffort } from './configTypes';
import {
  LLM_MODELS_URL,
  MODEL_SEARCH_THRESHOLD,
  type LLMModelsResponse,
  type ModelInfo,
  type ReasoningCapability,
} from './llmApi';

export interface LLMModelPickerProps {
  // Provider whose catalog to fetch. Must be set before any meaningful
  // render — if undefined, the picker renders nothing (the selector
  // hasn't picked a provider yet).
  provider: LLMProviderName | undefined;
  // Currently-selected model id from the active config (so the dropdown
  // pre-highlights it on mount). Undefined = "let the user pick".
  value: string | undefined;
  // Currently-saved reasoning_effort. Shape must match the chosen model's
  // declared `reasoning.shape`; the picker treats a mismatched type as
  // "no override" and falls back to the model's declared default.
  reasoningEffort: ReasoningEffort | undefined;
  // Fires whenever the user changes either control. The wrapper persists
  // both fields together so a partial state (model w/o effort or vice
  // versa) never reaches config.json.
  onChange: (next: { model: string | undefined; reasoning_effort: ReasoningEffort | undefined }) => void;
  // When the provider is gated on credentials (`needs_key=true` and the
  // user hasn't tested green yet), we skip the fetch — the selector
  // will re-render us once a credential lands.
  enabled?: boolean;
}

// Levels we render in the "levels" shape's secondary dropdown. "off" is
// a synthetic local sentinel meaning "omit the reasoning_effort field
// from the request" — every backend treats null/undefined the same way.
const OFF_VALUE = 'off';

// Tooltip on the effort control. Copy locked in by spec.
const EFFORT_TOOLTIP =
  "Higher effort = slower + more accurate. For job scoring, 'off' or "
  + "'low' is usually plenty. Default off.";

export const LLMModelPicker = ({
  provider,
  value,
  reasoningEffort,
  onChange,
  enabled = true,
}: LLMModelPickerProps) => {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  // Lazy-fetch the catalog once the provider is known. We refetch on
  // provider change — the picker is shared between the wizard step and
  // the post-onboarding card, both of which may swap providers mid-flow.
  useEffect(() => {
    if (!provider || !enabled) {
      setModels([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const url = `${LLM_MODELS_URL}?provider=${encodeURIComponent(provider)}`;
        const res = await fetch(url);
        const body = (await res.json()) as LLMModelsResponse;
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- mutated by cleanup
        if (cancelled) return;
        if (body.ok && body.models) {
          setModels(body.models);
        } else {
          setError(body.error ?? 'Could not load model list.');
        }
      } catch (e) {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- mutated by cleanup
        if (!cancelled) setError((e as Error).message);
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- mutated by cleanup
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [provider, enabled]);

  // Resolve the ModelInfo currently selected (if any). We look it up
  // every render rather than caching it because the catalog can change
  // under us (provider swap → new model list → previously-saved model
  // might not be in the new list).
  const selectedModel: ModelInfo | undefined = useMemo(
    () => models.find((m) => m.id === value),
    [models, value],
  );

  // Filtered view of the catalog used by the dropdown when search is on.
  // Cheap: a substring match against id + display_name. Case-insensitive.
  const filtered: ModelInfo[] = useMemo(() => {
    if (!search.trim()) return models;
    const s = search.trim().toLowerCase();
    return models.filter(
      (m) => m.id.toLowerCase().includes(s) || m.display_name.toLowerCase().includes(s),
    );
  }, [models, search]);

  const showSearch = models.length >= MODEL_SEARCH_THRESHOLD;

  const onModelChange = useCallback(
    (nextId: string) => {
      // Dropping reasoning_effort on model change is deliberate — the new
      // model might have a different reasoning shape, and stale values
      // would either be silently ignored by the backend or, worse, rejected
      // as an API error. Picking a model "starts fresh" on the effort
      // surface; the user can re-set effort if they want.
      onChange({ model: nextId || undefined, reasoning_effort: undefined });
    },
    [onChange],
  );

  const onEffortChange = useCallback(
    (next: ReasoningEffort | undefined) => {
      onChange({ model: value, reasoning_effort: next });
    },
    [onChange, value],
  );

  if (!provider) return null;
  if (!enabled) {
    return (
      <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
        Save a credential first to load the model list.
      </div>
    );
  }
  if (loading) {
    return (
      <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
        Loading models…
      </div>
    );
  }
  if (error) {
    // No `role="alert"` here — the parent selector's own ✗ banner already
    // owns the alert role; this is a quieter secondary failure surface
    // and the test connection's error is the user-actionable one.
    return (
      <div
        data-testid="llm-model-picker-error"
        className="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800"
      >
        <div className="font-semibold">Could not load models</div>
        <div className="mt-0.5 break-all">{error}</div>
      </div>
    );
  }
  if (models.length === 0) {
    return (
      <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
        No models surfaced — provider returned an empty catalog.
      </div>
    );
  }

  return (
    <div data-testid="llm-model-picker" className="mb-3 space-y-2">
      <div>
        <label
          htmlFor="llm-model-select"
          className="mb-1 block text-xs font-medium text-slate-600"
        >
          Model
        </label>
        {showSearch && (
          <input
            type="search"
            value={search}
            onChange={(e) => { setSearch(e.target.value); }}
            placeholder={`Filter ${String(models.length)} models…`}
            aria-label="Filter models"
            className="mb-1 w-full rounded border border-slate-300 bg-white px-2 py-1 text-sm shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
          />
        )}
        <select
          id="llm-model-select"
          value={value ?? ''}
          onChange={(e) => { onModelChange(e.target.value); }}
          className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-sm shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
        >
          <option value="">— Provider default —</option>
          {filtered.map((m) => (
            <option key={m.id} value={m.id}>
              {m.display_name === m.id ? m.id : `${m.display_name} (${m.id})`}
            </option>
          ))}
        </select>
      </div>

      <ReasoningEffortControl
        capability={selectedModel?.reasoning}
        value={reasoningEffort}
        onChange={onEffortChange}
      />
    </div>
  );
};

// Renders the secondary control matching the selected model's reasoning
// shape. Pulled out as a named component to keep the parent readable —
// the four shapes diverge sharply and inlining all four branches into
// the parent's JSX hurt diffability.
const ReasoningEffortControl = ({
  capability,
  value,
  onChange,
}: {
  capability: ReasoningCapability | undefined;
  value: ReasoningEffort | undefined;
  onChange: (next: ReasoningEffort | undefined) => void;
}) => {
  if (!capability || !capability.supported || capability.shape === 'none') {
    return null;
  }

  if (capability.shape === 'levels') {
    const levels = capability.levels ?? [];
    const stringValue =
      typeof value === 'string' && value.length > 0 ? value : OFF_VALUE;
    return (
      <div data-testid="effort-levels">
        <label
          htmlFor="llm-effort-level"
          title={EFFORT_TOOLTIP}
          className="mb-1 block text-xs font-medium text-slate-600"
        >
          Reasoning effort
        </label>
        <select
          id="llm-effort-level"
          value={stringValue}
          onChange={(e) => {
            const next = e.target.value;
            onChange(next === OFF_VALUE ? OFF_VALUE : next);
          }}
          aria-label="Reasoning effort"
          className="w-full rounded border border-slate-300 bg-white px-2 py-1 text-sm shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
        >
          <option value={OFF_VALUE}>off (fastest)</option>
          {levels.map((lvl) => (
            <option key={lvl} value={lvl}>
              {lvl}
            </option>
          ))}
        </select>
      </div>
    );
  }

  if (capability.shape === 'budget') {
    const [lo, hi] = capability.budget_range ?? [0, 32768];
    // -1 = dynamic. Anything else is a literal token budget. We let the
    // user toggle "dynamic" with a checkbox so the budget input doesn't
    // need to know how to render negative numbers.
    const isDynamic = value === -1;
    const numericValue =
      typeof value === 'number' && value >= 0 ? value : lo;
    return (
      <div data-testid="effort-budget" className="space-y-1">
        <label
          htmlFor="llm-effort-budget"
          title={EFFORT_TOOLTIP}
          className="mb-1 block text-xs font-medium text-slate-600"
        >
          Thinking budget (tokens)
        </label>
        <div className="flex items-center gap-2">
          <input
            id="llm-effort-budget"
            type="number"
            min={lo}
            max={hi}
            value={isDynamic ? '' : numericValue}
            disabled={isDynamic}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n)) onChange(n);
            }}
            aria-label="Thinking budget tokens"
            className="w-32 rounded border border-slate-300 bg-white px-2 py-1 text-sm shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400 disabled:bg-slate-100"
          />
          <label className="flex items-center gap-1 text-xs text-slate-600">
            <input
              type="checkbox"
              checked={isDynamic}
              onChange={(e) => {
                onChange(e.target.checked ? -1 : lo);
              }}
              aria-label="Use dynamic thinking budget"
            />
            dynamic
          </label>
          <span className="text-[10px] text-slate-500">
            range {String(lo)}–{String(hi)}
          </span>
        </div>
      </div>
    );
  }

  // shape === "boolean"
  const isOn = value === true;
  return (
    <div data-testid="effort-boolean">
      <label
        title={EFFORT_TOOLTIP}
        className="flex items-center gap-2 text-xs font-medium text-slate-600"
      >
        <input
          type="checkbox"
          checked={isOn}
          onChange={(e) => { onChange(e.target.checked); }}
          aria-label="Enable thinking mode"
        />
        Thinking mode {isOn ? '(on)' : '(off)'}
      </label>
    </div>
  );
};
