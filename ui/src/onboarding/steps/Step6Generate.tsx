import { useCallback, useEffect, useRef, useState } from 'react';
import type { CrawlerConfig } from '../../configTypes';
import { normalizeConfig } from '../../configMigrate';
import { Banner, ConfigInspector } from '../components';
import {
  PROFILE_NAME_RE,
  defaultProfileName,
  type GenerateResponse,
  type SaveResponse,
  type WizardDraft,
} from '../types';

type GenState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'success'; config: CrawlerConfig; raw: string }
  | { kind: 'error'; error: string; raw: string };

export const Step6Generate = ({
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
          error: body.error ?? `HTTP ${res.status.toString()}`,
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
        setSaveErr(body.error ?? `HTTP ${res.status.toString()}`);
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
        setSaveErr(body.error ?? `HTTP ${res.status.toString()}`);
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
