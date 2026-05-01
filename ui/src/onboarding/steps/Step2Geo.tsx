import { useState } from 'react';
import clsx from 'clsx';
import { BackButton } from '../components';
import type { WizardDraft } from '../types';

const GEO_CARDS: { value: string; label: string; sub: string }[] = [
  { value: '', label: '(session default)', sub: "Uses LinkedIn's home filter" },
  { value: '103644278', label: 'United States', sub: '103644278' },
  { value: '101620260', label: 'Israel', sub: '101620260' },
  { value: '92000000', label: 'Worldwide', sub: '92000000' },
];

export const Step2Geo = ({
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
  const [customOpen, setCustomOpen] = useState(false);
  const [custom, setCustom] = useState('');

  const pick = (value: string) => {
    setDraft({ ...draft, geo_id: value });
    onAdvance();
  };

  return (
    <div>
      <h2 className="mb-2 text-base font-semibold text-slate-800">Pick a geo scope</h2>
      <p className="mb-4 text-sm text-slate-600">
        Where should the scraper look? You can change this later in Crawler Config.
      </p>
      <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-2">
        {GEO_CARDS.map((g) => {
          const isSel = (draft.geo_id ?? '') === g.value;
          return (
            <button
              key={g.value}
              type="button"
              aria-pressed={isSel}
              onClick={() => { pick(g.value); }}
              className={clsx(
                'rounded border p-4 text-left transition focus:outline-none focus:ring-2 focus:ring-indigo-400',
                isSel
                  ? 'border-indigo-500 bg-indigo-50 ring-1 ring-indigo-300'
                  : 'border-slate-200 bg-white hover:border-indigo-300 hover:bg-indigo-50/40',
              )}
            >
              <div className="font-semibold text-slate-800">{g.label}</div>
              <div className="mt-1 text-xs text-slate-500">{g.sub}</div>
            </button>
          );
        })}
      </div>

      <div className="mb-4 rounded border border-slate-200 bg-white">
        <button
          type="button"
          onClick={() => { setCustomOpen((v) => !v); }}
          className="flex w-full items-center justify-between rounded-t px-3 py-2 text-left text-sm hover:bg-slate-50"
        >
          <span className="font-medium text-slate-700">Custom URN</span>
          <span className="text-xs text-slate-400">{customOpen ? '▼' : '▶'}</span>
        </button>
        {customOpen && (
          <div className="border-t border-slate-100 p-3">
            <p className="mb-2 text-xs text-slate-500">
              Numeric LinkedIn geo URN (e.g. 101165590 for the UK).
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                inputMode="numeric"
                value={custom}
                onChange={(e) => { setCustom(e.target.value.replace(/[^\d]/g, '')); }}
                placeholder="e.g. 101165590"
                className="flex-1 rounded border border-slate-300 bg-white px-2 py-1 font-mono text-sm shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
              />
              <button
                type="button"
                disabled={!custom}
                onClick={() => { pick(custom); }}
                className="rounded bg-indigo-600 px-3 py-1 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                Use
              </button>
            </div>
          </div>
        )}
      </div>

      <div>
        <BackButton onBack={onBack} />
      </div>
    </div>
  );
};
