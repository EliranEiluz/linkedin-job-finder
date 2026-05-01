// Stateless visual primitives shared by every wizard step. Kept separate
// from the step files so each step doesn't pull in the others' deps.

import { useState } from 'react';
import clsx from 'clsx';
import type { CrawlerConfig } from '../configTypes';
import type { Step } from './types';

export const Stepper = ({ step }: { step: Step }) => {
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

export const Banner = ({
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

export const BackButton = ({ onBack }: { onBack: () => void }) => (
  <button
    type="button"
    onClick={onBack}
    className="rounded border border-slate-300 bg-white px-4 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
  >
    ← Back
  </button>
);

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

export const ConfigInspector = ({ cfg }: { cfg: CrawlerConfig }) => {
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
