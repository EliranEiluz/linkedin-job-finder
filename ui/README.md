# Jobs Browser

Static React + TypeScript + Tailwind UI for browsing the LinkedIn job-hunt
corpus, editing the scraper config, and inspecting run history.

## Tabs

- **Corpus** — the original full-corpus browser (`results.json`, filters, applied tracking).
- **Crawler Config** — edits `config.json`. The scraper reads it on startup
  and overlays it over the hardcoded defaults in `search.py`.
- **Run History** — last ~100 runs from `run_history.json` (timeline +
  per-query stats + sparklines).

URL `?tab=corpus|config|history` keeps tabs shareable / browser-back-able.

## Run

```bash
cd ui
npm install
npm run dev
```

Open <http://localhost:5173>.

## How it reads / writes data

- `public/results.json` → symlinked to `../../results.json`
- `public/run_history.json` → symlinked to `../../run_history.json`
- `public/defaults.json` → symlinked to `../../defaults.json` (regenerated
  with `python3 search.py --print-defaults > defaults.json` if you change
  the in-file defaults in `search.py`)
- `config.json` → read & written via the dev API (see below). The Vite
  middleware does the disk IO, NOT the browser.

If symlinks are missing, recreate them:

```bash
cd ui/public
ln -sf ../../results.json results.json
ln -sf ../../run_history.json run_history.json
ln -sf ../../defaults.json defaults.json
```

Seed the run history if it doesn't exist yet:

```bash
echo '{"runs": []}' > run_history.json
```

`config.json` is created by the UI on first save — no need to pre-create it.

## Dev-only API (Vite middleware)

Defined in `vite.config.ts`. Only active under `npm run dev` — `npm run build`
produces a static bundle with no server.

- `GET  /api/config-info` → `{ exists, mtimeMs, size }` for `../config.json`
- `GET  /api/config` → contents of `../config.json` (404 if missing)
- `POST /api/config` → atomic write (temp file + rename). Body: full config JSON.

## Build

```bash
npm run build   # outputs to dist/  (TS-strict, must be clean)
npm run preview
```

The production build is **read-only** for config — there's no API. The Config
page will show "config.json does not exist yet" because `/api/config-info`
isn't there. This is by design; the tool is only meant to be run via `npm run
dev` on the user's own machine.

## Files

- `src/App.tsx` — tab-router shell
- `src/CorpusPage.tsx` — extracted from old `App.tsx`; data loading, keyboard, URL sync
- `src/ConfigPage.tsx` — editor for `config.json`
- `src/RunHistoryPage.tsx` — timeline + summary cards + simple CSS bars
- `src/configTypes.ts`, `src/runHistoryTypes.ts` — shapes mirroring `search.py`
- `src/filters.ts` — filter model + URL codec + `applyFilters`
- `src/StatsBar.tsx`, `src/FilterPanel.tsx`, `src/JobsTable.tsx` — corpus UI
- `src/types.ts`, `src/hooks.ts` — corpus types and shared hooks
