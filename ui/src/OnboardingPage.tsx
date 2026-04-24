// 3-step onboarding wizard: upload CV -> write intent -> generate + review.
// POSTs to /api/onboarding/generate and /api/onboarding/save in the Vite dev
// middleware. No routing — just in-component step state.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import type { CrawlerConfig } from './configTypes';
import { normalizeConfig } from './configMigrate';

type Step = 1 | 2 | 3;

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

const CV_MIN_CHARS = 200;
const INTENT_MIN_CHARS = 50;

// Mirrors onboarding_ctl._PROFILE_NAME_RE.
const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

// Default profile name shown in Step 3 — "onboarded-YYYY-MM-DD". Pure local
// date (not UTC) so a user in Asia doesn't see a tomorrow-dated profile.
const defaultProfileName = (): string => {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `onboarded-${yyyy}-${mm}-${dd}`;
};

const Stepper = ({ step }: { step: Step }) => {
  const labels = ['Upload CV', 'Write intent', 'Generate & review'];
  return (
    <ol className="mb-6 flex items-center gap-2 text-sm">
      {labels.map((label, i) => {
        const n = (i + 1) as Step;
        const active = n === step;
        const done = n < step;
        return (
          <li key={label} className="flex items-center gap-2">
            <span
              className={clsx(
                'flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold',
                active && 'bg-indigo-600 text-white',
                done && 'bg-indigo-200 text-indigo-800',
                !active && !done && 'bg-slate-200 text-slate-500',
              )}
            >
              {done ? '✓' : n}
            </span>
            <span
              className={clsx(
                'font-medium',
                active ? 'text-indigo-700' : 'text-slate-600',
              )}
            >
              {label}
            </span>
            {i < 2 && <span className="mx-1 text-slate-300">→</span>}
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

// Read an uploaded file as UTF-8 text. For .pdf we just try the same thing —
// it won't be clean, but the user can paste instead and the warning banner
// tells them so.
const readFileAsText = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsText(file);
  });

// --- Step 1: CV upload ---------------------------------------------------

const Step1CV = ({
  cv,
  setCv,
  onNext,
  haveExistingConfig,
}: {
  cv: string;
  setCv: (v: string) => void;
  onNext: () => void;
  haveExistingConfig: boolean;
}) => {
  const [pdfWarn, setPdfWarn] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const onFile = useCallback(async (file: File) => {
    setPdfWarn(file.name.toLowerCase().endsWith('.pdf'));
    try {
      const text = await readFileAsText(file);
      setCv(text);
    } catch {
      // leave cv untouched; user can paste
    }
  }, [setCv]);

  return (
    <div>
      {haveExistingConfig && (
        <Banner kind="info">
          You already have a config. At the end of setup you can either save
          the generated one as a <span className="font-semibold">new profile</span>{' '}
          (recommended — keeps your current one untouched) or{' '}
          <span className="font-semibold">overwrite the active profile</span>.
        </Banner>
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
              setPdfWarn(false);
              if (fileRef.current) fileRef.current.value = '';
            }}
            className="text-xs text-slate-500 hover:text-rose-600"
          >
            Clear
          </button>
        )}
      </div>
      {pdfWarn && (
        <Banner kind="warn">
          PDF text extraction is best-effort — if the textarea below looks
          garbled, paste the plain text instead.
        </Banner>
      )}
      <textarea
        value={cv}
        onChange={(e) => setCv(e.target.value)}
        placeholder="Paste your CV here…"
        className="h-72 w-full rounded border border-slate-300 bg-white p-3 text-sm font-mono leading-5 shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
      />
      <div className="mt-2 flex items-center justify-between">
        <span className="text-xs text-slate-500">
          {cv.length.toLocaleString()} chars
          {cv.length < CV_MIN_CHARS && ` (need ≥ ${CV_MIN_CHARS})`}
        </span>
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
  );
};

// --- Step 2: Intent ------------------------------------------------------

const Step2Intent = ({
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
      onChange={(e) => setIntent(e.target.value)}
      placeholder="e.g. Staff/principal backend or platform engineer, Go or Rust preferred, remote-friendly, mid-size infra companies, no sales / no smart-contract dev / no interviews that require LeetCode live coding…"
      className="h-56 w-full rounded border border-slate-300 bg-white p-3 text-sm leading-6 shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
    />
    <div className="mt-2 flex items-center justify-between">
      <span className="text-xs text-slate-500">
        {intent.length} chars
        {intent.length < INTENT_MIN_CHARS && ` (need ≥ ${INTENT_MIN_CHARS})`}
      </span>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onBack}
          className="rounded border border-slate-300 bg-white px-4 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          ← Back
        </button>
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

// --- Step 3 helpers ------------------------------------------------------

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
        onClick={() => setOpen((v) => !v)}
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

// --- Step 3: Generate + review ------------------------------------------

type GenState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'success'; config: CrawlerConfig; raw: string }
  | { kind: 'error'; error: string; raw: string };

const Step3Generate = ({
  cv,
  intent,
  current,
  onBack,
  onSaved,
}: {
  cv: string;
  intent: string;
  current: CrawlerConfig | null;
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
        setGen({
          kind: 'success',
          config: normalizeConfig(body.config),
          raw: body.raw ?? '',
        });
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
  }, [cv, intent]);

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
            Claude is generating your config… this takes up to 3 minutes.
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
              <summary className="cursor-pointer text-slate-600">Raw Claude output</summary>
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

          {saveErr && <div className="mt-4"><Banner kind="err">Save failed: {saveErr}</Banner></div>}

          <div className="mt-5 rounded border border-slate-200 bg-slate-50 p-3">
            <label className="mb-1 block text-xs font-semibold uppercase tracking-wider text-slate-500">
              Profile name
            </label>
            <input
              type="text"
              value={profileName}
              onChange={(e) => setProfileName(e.target.value)}
              disabled={saving}
              placeholder={defaultProfileName()}
              className="mb-2 w-full max-w-sm rounded border border-slate-300 bg-white px-2 py-1 text-sm font-mono shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400 disabled:opacity-50"
            />
            <p className="text-xs text-slate-500">
              Letters, digits, underscore, hyphen. Max 40 chars.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
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

// --- Top-level page -----------------------------------------------------

export const OnboardingPage = ({
  onSwitchTab,
}: {
  onSwitchTab: (tab: 'corpus' | 'config' | 'history') => void;
}) => {
  const [step, setStep] = useState<Step>(1);
  const [cv, setCv] = useState('');
  const [intent, setIntent] = useState('');
  const [current, setCurrent] = useState<CrawlerConfig | null>(null);
  const [haveExisting, setHaveExisting] = useState(false);
  const [saved, setSaved] = useState(false);
  const [savedProfile, setSavedProfile] = useState<string | null>(null);

  // Load current config on mount so we can show side-by-side diff and the
  // "you already have a config" banner.
  useEffect(() => {
    (async () => {
      try {
        const info = await fetch(`/api/config-info?t=${Date.now()}`);
        if (info.ok) {
          const j = (await info.json()) as { exists?: boolean };
          setHaveExisting(Boolean(j.exists));
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

  const canShowSaved = useMemo(() => saved, [saved]);

  return (
    <div className="mx-auto w-full max-w-4xl overflow-y-auto p-6">
      <h1 className="mb-1 text-lg font-semibold text-slate-900">Setup</h1>
      <p className="mb-4 text-sm text-slate-500">
        Upload your CV and describe what you're looking for. Claude builds a
        tailored scraper config you can review before saving.
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
              onClick={() => onSwitchTab('config')}
              className="rounded bg-white px-2 py-0.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100"
            >
              Open Crawler Config →
            </button>
          </span>
        </Banner>
      )}

      <Stepper step={step} />

      {step === 1 && (
        <Step1CV
          cv={cv}
          setCv={setCv}
          onNext={() => setStep(2)}
          haveExistingConfig={haveExisting}
        />
      )}
      {step === 2 && (
        <Step2Intent
          intent={intent}
          setIntent={setIntent}
          onBack={() => setStep(1)}
          onNext={() => setStep(3)}
        />
      )}
      {step === 3 && (
        <Step3Generate
          cv={cv}
          intent={intent}
          current={current}
          onBack={() => setStep(2)}
          onSaved={(name) => {
            setSavedProfile(name ?? null);
            setSaved(true);
          }}
        />
      )}
    </div>
  );
};

export default OnboardingPage;
