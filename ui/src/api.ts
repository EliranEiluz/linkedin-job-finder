// Thin wrappers around `fetch` for the patterns repeated across the app.
// Deliberately small — every callsite still owns its response shape and
// error handling. The goal is to drop boilerplate (JSON content-type
// header, cache-busting query string), not to invent a new framework.

/** Fetch a JSON file from the static root with a cache-busting `?t=`
 *  param. Used for the /results.json, /run_history.json, /defaults.json
 *  endpoints where the dev middleware serves files-from-disk that change
 *  out-of-band (scrape runs, manual edits) and `?t=Date.now()` is the
 *  smallest-blast-radius way to defeat any intermediate caching. */
export const fetchJsonNoCache = async (url: string): Promise<Response> =>
  fetch(`${url}?t=${Date.now().toString()}`);

/** POST a JSON body. Sets Content-Type and stringifies. Returns the raw
 *  Response so the caller can branch on `res.status` (e.g. 409 for the
 *  add-manual dedup case). */
export const postJson = async (
  url: string,
  body: Record<string, unknown>,
): Promise<Response> =>
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
