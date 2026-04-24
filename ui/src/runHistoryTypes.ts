// Mirrors the entry shape produced by search.py:_append_run_history().

export interface RunQueryStats {
  query: string;
  category: 'crypto' | 'security_researcher' | 'company';
  real: number;
  jymbii: number;
  unknown: number;
  banner: boolean;
  jobs_kept_after_dedup: number;
}

export interface RunTotals {
  new_jobs: number;
  scored_claude: number;
  scored_regex: number;
  title_filtered: number;
  descriptions_fetched: number;
  descriptions_failed: number;
}

export interface RunFitDistribution {
  good: number;
  ok: number;
  skip: number;
  unscored: number;
}

export interface RunArgs {
  all: boolean;
  no_enrich: boolean;
  all_time: boolean;
  pages: number | null;
  max_pages_used: number;
}

export interface RunRecord {
  started_at: string;
  ended_at: string;
  duration_sec: number;
  args: RunArgs;
  queries: RunQueryStats[];
  totals: RunTotals;
  fit_distribution: RunFitDistribution;
  errors: { query: string; error: string }[];
}

export interface RunHistoryFile {
  runs: RunRecord[];
}
