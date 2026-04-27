import { useCallback, useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { formatDistanceToNowStrict } from 'date-fns';
import {
  configsEqual,
  DATE_FILTER_OPTIONS,
  GEO_PRESETS,
  isPresetGeoId,
  type CrawlerConfig,
} from './configTypes';
import { normalizeConfig, serializeConfig } from './configMigrate';
import { ScrapeRunPanel } from './ScrapeRunPanel';
import { SchedulerCard } from './SchedulerCard';
import { CategoryManager } from './CategoryManager';
import { ChipInput } from './ChipInput';
import { ProfileSwitcher } from './ProfileSwitcher';

type LoadState =
  | { kind: 'loading' }
  | {
      kind: 'ready';
      config: CrawlerConfig;
      defaults: CrawlerConfig;
      loadedAt: Date;
      mtimeMs: number | null;
    }
  | { kind: 'error'; message: string };

const DEFAULTS_URL = `${import.meta.env.BASE_URL}defaults.json`;

const fetchJsonOr = async (url: string): Promise<unknown | null> => {
  try {
    const res = await fetch(`${url}?t=${Date.now()}`);
    if (!res.ok) return null;
    const text = await res.text();
    return text.trim() ? JSON.parse(text) : null;
  } catch {
    return null;
  }
};

const Card = ({
  title,
  children,
  right,
}: {
  title: string;
  children: React.ReactNode;
  right?: React.ReactNode;
}) => (
  <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
    <div className="mb-3 flex items-center justify-between">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-600">
        {title}
      </h2>
      {right}
    </div>
    {children}
  </section>
);

// ChipInput-backed editor for the priority_companies list. The raw list can
// run 100+ entries; we add a chip-grep filter and a "first N / show all"
// toggle so the card doesn't become a wall of chips.
const PriorityCompaniesEditor = ({
  values,
  onChange,
}: {
  values: string[];
  onChange: (next: string[]) => void;
}) => {
  const [filter, setFilter] = useState('');
  const [showAll, setShowAll] = useState(false);
  const HEAD_N = 30;

  const q = filter.trim().toLowerCase();
  const filtered = q ? values.filter((v) => v.toLowerCase().includes(q)) : values;
  const truncated = !showAll && filtered.length > HEAD_N;
  const visibleSlice = truncated ? filtered.slice(0, HEAD_N) : filtered;

  // Add: append to the underlying list (not the filtered view) so the new
  // chip survives clearing the filter input.
  const addChip = (raw: string) => {
    const v = raw.trim();
    if (!v || values.includes(v)) return;
    onChange([...values, v]);
  };
  const removeChip = (chip: string) => {
    onChange(values.filter((v) => v !== chip));
  };

  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="filter chips…"
          className="flex-1 rounded border border-slate-300 bg-white px-2 py-1 text-xs focus:border-brand-700 focus:outline-none focus:ring-1 focus:ring-brand-700"
        />
        {filtered.length > HEAD_N && (
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-700 hover:bg-slate-100"
          >
            {showAll ? `Show first ${HEAD_N}` : `Show all (${filtered.length})`}
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5 rounded border border-slate-300 bg-white px-2 py-1.5 focus-within:border-brand-700 focus-within:ring-1 focus-within:ring-brand-700">
        {visibleSlice.map((v) => (
          <span
            key={v}
            className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-0.5 font-mono text-xs text-brand-800"
          >
            {v}
            <button
              type="button"
              onClick={() => removeChip(v)}
              className="-mr-0.5 rounded-full px-1 text-brand-700 hover:bg-brand-100 hover:text-brand-900"
              title="Remove"
              aria-label={`Remove ${v}`}
            >
              ×
            </button>
          </span>
        ))}
        {truncated && (
          <span className="inline-flex items-center rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
            +{filtered.length - HEAD_N} more
          </span>
        )}
        <PriorityChipDraftInput
          existing={values}
          onAdd={addChip}
        />
      </div>
    </div>
  );
};

// Inline draft-input for new priority chips. Enter or comma commits.
const PriorityChipDraftInput = ({
  existing,
  onAdd,
}: {
  existing: string[];
  onAdd: (v: string) => void;
}) => {
  const [draft, setDraft] = useState('');
  return (
    <input
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ',') {
          e.preventDefault();
          if (draft.trim() && !existing.includes(draft.trim())) {
            onAdd(draft);
          }
          setDraft('');
        }
      }}
      onBlur={() => {
        if (draft.trim()) onAdd(draft);
        setDraft('');
      }}
      placeholder={existing.length === 0 ? 'add company…' : ''}
      className="min-w-[8rem] flex-1 border-0 bg-transparent p-0 font-mono text-xs focus:outline-none focus:ring-0"
    />
  );
};

// Collapsible card variant — used for the Scoring & filtering section. Default-
// collapsed because most users won't touch it after initial setup.
const CollapsibleCard = ({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="rounded-lg border border-slate-200 bg-white shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between rounded-t-lg px-4 py-3 text-left hover:bg-slate-50"
        aria-expanded={open}
      >
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-600">
          {title}
        </h2>
        <span className="text-xs text-slate-400">{open ? '▼' : '▶'}</span>
      </button>
      {open && <div className="border-t border-slate-100 p-4">{children}</div>}
    </section>
  );
};

export const ConfigPage = () => {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [draft, setDraft] = useState<CrawlerConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);
  // Local-only sub-collapse for the regex-fallback block inside the scoring card.
  const [showRegexFallback, setShowRegexFallback] = useState(false);

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    const defaultsRaw = await fetchJsonOr(DEFAULTS_URL);
    if (!defaultsRaw) {
      setState({
        kind: 'error',
        message:
          'Could not load defaults.json. Run `python3 search.py --print-defaults > defaults.json` and ensure ui/public/defaults.json is symlinked.',
      });
      return;
    }
    const defaults = normalizeConfig(defaultsRaw);

    // Hit the dev API for the active config (works whether or not config.json exists).
    let activeRaw: unknown = null;
    let mtimeMs: number | null = null;
    try {
      const res = await fetch(`/api/config?t=${Date.now()}`);
      if (res.ok) {
        activeRaw = await res.json();
        const infoRes = await fetch(`/api/config-info?t=${Date.now()}`);
        if (infoRes.ok) {
          const info = (await infoRes.json()) as { exists: boolean; mtimeMs?: number };
          mtimeMs = info.exists ? (info.mtimeMs ?? null) : null;
        }
      }
    } catch {
      /* config.json missing or dev API unreachable — fall through to defaults */
    }

    // If the dev API returned nothing, the active config IS the defaults.
    const config = activeRaw === null ? defaults : normalizeConfig(activeRaw);
    setState({
      kind: 'ready',
      config,
      defaults,
      loadedAt: new Date(),
      mtimeMs,
    });
    setDraft(config);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Auto-dismiss toast.
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 3500);
    return () => window.clearTimeout(id);
  }, [toast]);

  const dirty = useMemo(() => {
    if (state.kind !== 'ready' || !draft) return false;
    return !configsEqual(draft, state.config);
  }, [state, draft]);

  const save = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    setToast(null);
    try {
      const payload = serializeConfig(draft);
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`HTTP ${res.status}: ${err}`);
      }
      const info = (await res.json()) as { mtimeMs: number };
      setState((prev) =>
        prev.kind === 'ready'
          ? { ...prev, config: draft, mtimeMs: info.mtimeMs ?? Date.now() }
          : prev,
      );
      setToast({
        kind: 'ok',
        msg: 'Config saved — applies to the next scraper run.',
      });
    } catch (e) {
      setToast({ kind: 'err', msg: `Save failed: ${(e as Error).message}` });
    } finally {
      setSaving(false);
    }
  }, [draft]);

  const discard = useCallback(() => {
    if (state.kind === 'ready') setDraft(state.config);
  }, [state]);

  const resetToDefaults = useCallback(() => {
    if (state.kind === 'ready') setDraft(state.defaults);
  }, [state]);

  if (state.kind === 'loading') {
    return (
      <div className="flex h-full items-center justify-center text-sm text-slate-500">
        Loading config…
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 py-20 text-center">
        <h2 className="mb-2 text-xl font-semibold text-slate-800">
          Couldn't load config
        </h2>
        <p className="mb-5 max-w-lg text-sm text-slate-600">{state.message}</p>
      </div>
    );
  }

  if (!draft) return null;

  // GeoId UI: preset radio + custom input. "Custom" = anything not in the preset list.
  const geoIsCustom = !isPresetGeoId(draft.geo_id);
  const priorityCount = draft.priority_companies.length;

  return (
    <div className="relative flex h-full flex-col overflow-hidden">
      {toast && (
        <div
          className={clsx(
            'absolute left-1/2 top-3 z-30 -translate-x-1/2 rounded-md px-4 py-2 text-sm font-medium shadow-lg',
            toast.kind === 'ok' ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white',
          )}
        >
          {toast.msg}
        </div>
      )}

      <div className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2">
        <div className="text-xs text-slate-500">
          {state.mtimeMs
            ? `Config last modified: ${formatDistanceToNowStrict(new Date(state.mtimeMs), { addSuffix: true })}`
            : 'config.json does not exist yet — defaults are in effect'}
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded border border-slate-300 bg-white px-3 py-1 text-xs text-slate-700 hover:bg-brand-50 hover:text-brand-700"
        >
          ↻ Reload
        </button>
      </div>

      <div className="flex-1 overflow-y-auto bg-slate-50 px-4 py-4 pb-24 md:pb-4">
        <div className="mx-auto flex max-w-4xl flex-col gap-4">
          {/* Profile switcher — switching profiles repoints config.json to a
              different file, then we reload to pull in the new draft state. */}
          <ProfileSwitcher onActiveChange={() => void load()} />

          <ScrapeRunPanel />

          <SchedulerCard />

          <CategoryManager
            categories={draft.categories}
            onChange={(categories) => setDraft({ ...draft, categories })}
          />

          <Card title="Search behavior">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-700">
                  Date filter
                </label>
                <select
                  value={draft.date_filter}
                  onChange={(e) => setDraft({ ...draft, date_filter: e.target.value })}
                  className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm focus:border-brand-700 focus:outline-none focus:ring-1 focus:ring-brand-700"
                >
                  {DATE_FILTER_OPTIONS.map((o) => (
                    <option key={o.value || 'any'} value={o.value}>
                      {o.label}
                      {o.value ? ` (${o.value})` : ''}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-700">
                  Max pages per query (1–20)
                </label>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={draft.max_pages}
                  onChange={(e) => {
                    const n = parseInt(e.target.value, 10);
                    if (Number.isFinite(n)) {
                      setDraft({
                        ...draft,
                        max_pages: Math.min(20, Math.max(1, n)),
                      });
                    }
                  }}
                  className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm focus:border-brand-700 focus:outline-none focus:ring-1 focus:ring-brand-700"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-700">
                  GeoId
                </label>
                <select
                  value={geoIsCustom ? '__custom' : draft.geo_id}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === '__custom') {
                      setDraft({ ...draft, geo_id: geoIsCustom ? draft.geo_id : '' });
                    } else {
                      setDraft({ ...draft, geo_id: v });
                    }
                  }}
                  className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm focus:border-brand-700 focus:outline-none focus:ring-1 focus:ring-brand-700"
                >
                  {GEO_PRESETS.map((g) => (
                    <option key={g.value || 'session'} value={g.value}>
                      {g.label}
                    </option>
                  ))}
                  <option value="__custom">Custom…</option>
                </select>
                {geoIsCustom && (
                  <input
                    type="text"
                    placeholder="Custom geoId (numeric)"
                    value={draft.geo_id}
                    onChange={(e) => setDraft({ ...draft, geo_id: e.target.value })}
                    className="mt-1.5 w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm focus:border-brand-700 focus:outline-none focus:ring-1 focus:ring-brand-700"
                  />
                )}
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold text-slate-700">
                  Location (text override — rarely used)
                </label>
                <input
                  type="text"
                  value={draft.location}
                  onChange={(e) => setDraft({ ...draft, location: e.target.value })}
                  placeholder='e.g. "Israel" or "Tel Aviv"'
                  className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm focus:border-brand-700 focus:outline-none focus:ring-1 focus:ring-brand-700"
                />
              </div>
            </div>
          </Card>

          <CollapsibleCard title="Scoring & filtering">
            <div className="mb-4">
              <label className="mb-1 block text-xs font-semibold text-slate-700">
                Claude scoring prompt
              </label>
              <p className="mb-1.5 text-[11px] text-slate-500">
                Sent to Claude with your CV and a batch of jobs. Use{' '}
                <code className="rounded bg-slate-100 px-1 font-mono">{'{cv}'}</code>{' '}
                and{' '}
                <code className="rounded bg-slate-100 px-1 font-mono">{'{jobs_json}'}</code>{' '}
                placeholders. Leave blank to use the built-in default.
              </p>
              <textarea
                value={draft.claude_scoring_prompt ?? ''}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    claude_scoring_prompt:
                      e.target.value.length > 0 ? e.target.value : undefined,
                  })
                }
                rows={10}
                placeholder="(blank — using built-in default)"
                className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 font-mono text-xs leading-relaxed focus:border-brand-700 focus:outline-none focus:ring-1 focus:ring-brand-700"
              />
            </div>

            <div className="rounded border border-slate-200">
              <button
                type="button"
                onClick={() => setShowRegexFallback((v) => !v)}
                className="flex w-full items-center justify-between bg-slate-50 px-3 py-2 text-left text-xs font-semibold text-slate-600 hover:bg-slate-100"
                aria-expanded={showRegexFallback}
              >
                <span>Regex fallback (only used when Claude scoring is unavailable)</span>
                <span className="text-slate-400">{showRegexFallback ? '▼' : '▶'}</span>
              </button>
              {showRegexFallback && (
                <div className="border-t border-slate-200 p-3">
                  <div className="mb-3">
                    <label className="mb-1 block text-xs font-semibold text-slate-700">
                      Fit-positive regex patterns
                    </label>
                    <ChipInput
                      values={draft.fit_positive_patterns ?? []}
                      onChange={(next) =>
                        setDraft({ ...draft, fit_positive_patterns: next })
                      }
                      placeholder="e.g. cryptograph, machine.learning"
                      monospace
                    />
                  </div>
                  <div className="mb-3">
                    <label className="mb-1 block text-xs font-semibold text-slate-700">
                      Fit-negative regex patterns
                    </label>
                    <ChipInput
                      values={draft.fit_negative_patterns ?? []}
                      onChange={(next) =>
                        setDraft({ ...draft, fit_negative_patterns: next })
                      }
                      placeholder="e.g. devSecOps, IT support"
                      monospace
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-semibold text-slate-700">
                      Off-topic title patterns
                    </label>
                    <ChipInput
                      values={draft.offtopic_title_patterns ?? []}
                      onChange={(next) =>
                        setDraft({ ...draft, offtopic_title_patterns: next })
                      }
                      placeholder="e.g. \\bintern\\b, sales"
                      monospace
                    />
                    <p className="mt-1 text-[11px] text-slate-500">
                      Applied to job titles to drop obvious off-topic hits.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </CollapsibleCard>

          <Card title="Priority companies">
            <p className="mb-2 text-xs text-slate-500">
              Lowercased on save. Match is substring-in-company-name. Press
              Enter or comma to add a chip; click × to remove.
            </p>
            <PriorityCompaniesEditor
              values={draft.priority_companies}
              onChange={(next) => setDraft({ ...draft, priority_companies: next })}
            />
            <div className="mt-1 text-right text-[11px] tabular-nums text-slate-500">
              {priorityCount} {priorityCount === 1 ? 'company' : 'companies'}
            </div>
          </Card>

          {/* Action bar — sticks to the bottom of the scroll container.
              Page padding-bottom (pb-24 below md) reserves room so the bar
              never floats over content. Labels shorten on mobile so all 3
              buttons fit on a 393px viewport; full labels return at md+. */}
          <div className="sticky bottom-0 -mx-4 flex items-center justify-between gap-2 border-t border-slate-200 bg-white px-4 py-3">
            <button
              type="button"
              onClick={resetToDefaults}
              className="min-h-[44px] rounded border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:border-amber-400 hover:text-amber-700"
              title="Replace draft with the in-file defaults"
            >
              <span className="md:hidden">Reset</span>
              <span className="hidden md:inline">Reset to defaults</span>
            </button>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={discard}
                disabled={!dirty || saving}
                className="min-h-[44px] rounded border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Discard
              </button>
              <button
                type="button"
                onClick={() => void save()}
                disabled={!dirty || saving}
                className="min-h-[44px] rounded bg-brand-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-brand-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? 'Saving…' : <><span className="md:hidden">Save</span><span className="hidden md:inline">Save changes</span></>}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
