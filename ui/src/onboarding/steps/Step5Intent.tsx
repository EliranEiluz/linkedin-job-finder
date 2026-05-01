import { BackButton } from '../components';
import { INTENT_MIN_CHARS } from '../types';

export const Step5Intent = ({
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
      onChange={(e) => { setIntent(e.target.value); }}
      placeholder="e.g. Staff/principal backend or platform engineer, Go or Rust preferred, remote-friendly, mid-size infra companies, no sales / no smart-contract dev / no interviews that require LeetCode live coding…"
      className="h-56 w-full rounded border border-slate-300 bg-white p-3 text-sm leading-6 shadow-sm focus:border-indigo-400 focus:outline-none focus:ring-1 focus:ring-indigo-400"
    />
    <div className="mt-2 flex items-center justify-between">
      <span className="text-xs text-slate-500">
        {intent.length} chars
        {intent.length < INTENT_MIN_CHARS && ` (need ≥ ${INTENT_MIN_CHARS})`}
      </span>
      <div className="flex gap-2">
        <BackButton onBack={onBack} />
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
