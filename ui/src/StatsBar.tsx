import type { Job } from './types';

interface Props {
  all: Job[];
  filtered: Job[];
  applied: Set<string>;
  // category-id → human-readable name from /api/config. When the id is
  // present in the map we render the name ("Security"); otherwise we fall
  // back to id-de-snaking ("Cat Mobyb81c 5").
  categoryNamesById?: Map<string, string>;
}

const Chip = ({
  label,
  value,
  color = 'bg-slate-100 text-slate-700',
  tooltip,
}: {
  label: string;
  value: number | string;
  color?: string;
  tooltip?: string;
}) => (
  <div
    className={`inline-flex items-baseline gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${color}`}
    title={tooltip}
  >
    <span className="font-semibold tabular-nums">{value}</span>
    <span className="opacity-75">{label}</span>
  </div>
);

// Shared palette for category chips — indexes wrap so any user-defined
// category id gets a stable color without hardcoding known values.
const CATEGORY_PALETTE = [
  'bg-indigo-100 text-indigo-700',
  'bg-violet-100 text-violet-700',
  'bg-sky-100 text-sky-700',
  'bg-amber-100 text-amber-800',
  'bg-rose-100 text-rose-700',
  'bg-emerald-100 text-emerald-700',
  'bg-cyan-100 text-cyan-700',
  'bg-fuchsia-100 text-fuchsia-700',
];

const displayCategory = (id: string): string => {
  // Convert snake_case / kebab-case to Title Case for display. Unknown
  // categories just render whatever the user named them.
  return id.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
};

export const StatsBar = ({ all, filtered, applied, categoryNamesById }: Props) => {
  const byFit = { good: 0, ok: 0, skip: 0, unscored: 0 };
  const byCat: Record<string, number> = {};  // category id → count
  const bySource = { loggedin: 0, guest: 0 };
  let priorityCount = 0;
  let appliedCount = 0;
  const companies = new Set<string>();
  for (const j of all) {
    if (j.fit === 'good') byFit.good++;
    else if (j.fit === 'ok') byFit.ok++;
    else if (j.fit === 'skip') byFit.skip++;
    else byFit.unscored++;
    if (j.category) byCat[j.category] = (byCat[j.category] ?? 0) + 1;
    if (j.source === 'loggedin') bySource.loggedin++;
    else if (j.source === 'guest') bySource.guest++;
    if (j.priority) priorityCount++;
    if (applied.has(j.id)) appliedCount++;
    if (j.company) companies.add(j.company.toLowerCase());
  }
  // Stable-ordered list of category ids for chip rendering.
  const catIds = Object.keys(byCat).sort();

  return (
    <div className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 backdrop-blur">
      <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
        <div className="mr-2 flex items-baseline gap-1.5">
          <span className="text-xl font-semibold tabular-nums text-brand-700">
            {filtered.length.toLocaleString()}
          </span>
          <span className="text-xs text-slate-500">
            of {all.length.toLocaleString()} jobs
          </span>
        </div>
        <div className="h-6 w-px bg-slate-200" />
        <Chip label="good" value={byFit.good} color="bg-emerald-100 text-emerald-800" />
        <Chip label="ok" value={byFit.ok} color="bg-amber-100 text-amber-800" />
        <Chip label="skip" value={byFit.skip} color="bg-slate-200 text-slate-600" />
        <Chip label="unscored" value={byFit.unscored} color="bg-slate-100 text-slate-500" />
        <div className="h-6 w-px bg-slate-200" />
        <Chip
          label="priority"
          value={priorityCount}
          color="bg-red-100 text-red-700"
          tooltip="Company is on your priority_companies list (Crawler Config)"
        />
        <Chip
          label="applied"
          value={appliedCount}
          color="bg-emerald-100 text-emerald-800"
          tooltip="Jobs you've ticked the Applied checkbox on (stored locally)"
        />
        <div className="h-6 w-px bg-slate-200" />
        <Chip
          label="🔐 loggedin"
          value={bySource.loggedin}
          color="bg-indigo-100 text-indigo-800"
          tooltip="Job scraped via Playwright + saved LinkedIn session"
        />
        <Chip
          label="🌐 guest"
          value={bySource.guest}
          color="bg-emerald-100 text-emerald-800"
          tooltip="Job scraped via the unauthenticated /jobs-guest API"
        />
        {catIds.length > 0 && <div className="h-6 w-px bg-slate-200" />}
        {catIds.map((cid, i) => (
          <Chip
            key={cid}
            label={categoryNamesById?.get(cid) ?? displayCategory(cid)}
            value={byCat[cid]}
            color={CATEGORY_PALETTE[i % CATEGORY_PALETTE.length]}
          />
        ))}
        <div className="h-6 w-px bg-slate-200" />
        <Chip label="companies" value={companies.size} />
      </div>
    </div>
  );
};
