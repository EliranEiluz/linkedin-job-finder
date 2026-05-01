#!/usr/bin/env python3
"""
On-demand diagnostic for a single LinkedIn query.

Opens the search URL in the saved session, scrolls the INNER results pane
until card count stabilizes, then dumps every card with:
  - position
  - title + company
  - parsed `trk=` query param (real vs JYMBII / recommendation)
  - data-occludable-job-id presence
  - whether `.jobs-search-no-results-banner` is shown

Use this whenever you suspect LinkedIn is padding your query with filler
("you may be interested in ...") jobs.

Usage:
  python3 debug_query.py "MPC engineer"
  python3 debug_query.py "cryptography engineer" --start 25
  python3 debug_query.py "Fireblocks" --company        # skip phrase-quoting
  python3 debug_query.py "MPC engineer" --save debug_mpc.json   # dump cards as JSON
"""

import argparse
import json
import random
import sys
import time
from pathlib import Path
from urllib.parse import parse_qs, quote_plus, urlparse

from playwright.sync_api import TimeoutError as PlaywrightTimeout
from playwright.sync_api import sync_playwright

HERE = Path(__file__).parent
SESSION_FILE = HERE / "linkedin_session.json"

# --- Card classification ---
# Discovered 2026-04 by diffing two live queries:
#   - "cryptography engineer" (0 real hits → 7 filler cards)
#   - "Fireblocks"             (7 real hits, 0 filler)
# Both sets carried trk=flagship3_search_srp_jobs, so trk is USELESS as a
# discriminator. The canonical signal is the no-results banner (discard all);
# the secondary signal is the `eBP` query param on each card's anchor.
EBP_REAL = {
    "NON_CHARGEABLE_CHANNEL",  # normal organic search hit
    "C",
    "CHARGEABLE_CHANNEL",  # promoted/sponsored search slot
}
EBP_JYMBII = {
    "NOT_ELIGIBLE_FOR_CHARGING",  # appended recommendation filler
}


def classify_ebp(ebp: str, banner_present: bool) -> str:
    """Return 'real', 'jymbii', or 'unknown'. Banner overrides everything."""
    if banner_present:
        return "jymbii"
    if not ebp:
        return "unknown"
    if ebp in EBP_JYMBII:
        return "jymbii"
    if ebp in EBP_REAL:
        return "real"
    return "unknown"


def company_relevance(query: str, company: str, is_company_query: bool) -> bool:
    """For company queries, LinkedIn silently falls back to region-sorted jobs
    when the company has 0 matches (no banner, eBP=NON_CHARGEABLE_CHANNEL).
    Drop any card whose company field doesn't contain the query string."""
    if not is_company_query:
        return True
    return query.lower() in (company or "").lower()


def _build_search_url(query: str, start: int, is_company: bool) -> str:
    is_multiword = " " in query.strip()
    keyword_value = f'"{query}"' if (is_multiword and not is_company) else query
    parts = [
        "https://www.linkedin.com/jobs/search/",
        f"?keywords={quote_plus(keyword_value)}",
        "&f_TPR=r604800",
        "&sortBy=DD",
    ]
    if start:
        parts.append(f"&start={start}")
    return "".join(parts)


def scroll_inner_list(page, max_rounds=30, stable_needed=3) -> int:
    """
    Scroll the inner results container (not the window) until the count of
    *populated* cards (with a /jobs/view/ anchor) plateaus. Raw occludable
    shells are ignored so we don't stop early when 18/25 cards are empty
    placeholders LinkedIn hasn't hydrated yet.
    """
    stable = 0
    last = 0
    for _ in range(max_rounds):
        count = page.evaluate(
            """() => document.querySelectorAll(
                 "li.scaffold-layout__list-item a[href*='/jobs/view/'], " +
                 "li.jobs-search-results__list-item a[href*='/jobs/view/'], " +
                 "div.job-card-container a[href*='/jobs/view/']"
               ).length"""
        )
        if count == last:
            stable += 1
            if stable >= stable_needed:
                return count
        else:
            stable = 0
            last = count

        page.evaluate(
            """() => {
              const sels = [
                '.scaffold-layout__list-container',
                '.jobs-search-results-list',
                '.jobs-search-results',
                'main .scaffold-layout__list',
              ];
              for (const s of sels) {
                const el = document.querySelector(s);
                if (el && el.scrollHeight > el.clientHeight) {
                  el.scrollTop = el.scrollHeight;
                  return;
                }
              }
              // Fallback: scroll the window.
              window.scrollBy(0, window.innerHeight * 0.9);
            }"""
        )
        time.sleep(random.uniform(0.5, 1.0))
    return last


def extract_cards(page):
    """Return a list of dicts describing every card on the page."""
    return page.evaluate(
        """() => {
          const banner = document.querySelector('.jobs-search-no-results-banner');
          const sels = [
            'li.scaffold-layout__list-item[data-occludable-job-id]',
            'li.scaffold-layout__list-item',
            'li.jobs-search-results__list-item',
            'div.job-card-container',
            '[data-job-id]',
          ];
          let cards = [];
          for (const s of sels) {
            const got = Array.from(document.querySelectorAll(s));
            if (got.length) { cards = got; break; }
          }
          const out = cards.map((card, idx) => {
            const link = card.querySelector("a[href*='/jobs/view/']");
            const href = link ? (link.getAttribute('href') || '') : '';
            const ariaTitle = link ? (link.getAttribute('aria-label') || '') : '';
            const titleEl = card.querySelector(
              '.job-card-list__title--link, .job-card-list__title, ' +
              '.base-card__full-link, .artdeco-entity-lockup__title'
            );
            const companyEl = card.querySelector(
              '.job-card-container__company-name, .artdeco-entity-lockup__subtitle, ' +
              '.base-search-card__subtitle'
            );
            const jobIdAttr =
              card.getAttribute('data-occludable-job-id') ||
              card.getAttribute('data-job-id') || '';
            const trkCtrl = link ? (link.getAttribute('data-tracking-control-name') || '') : '';
            return {
              idx,
              href,
              jobIdAttr,
              hasOccludable: card.hasAttribute('data-occludable-job-id'),
              title: (ariaTitle || (titleEl && titleEl.innerText) || '').split('\\n')[0].trim(),
              company: (companyEl && companyEl.innerText || '').split('\\n')[0].trim(),
              trkCtrl,
            };
          });
          return {
            bannerPresent: Boolean(banner),
            bannerText: banner ? banner.innerText.trim().slice(0, 200) : '',
            cards: out,
          };
        }"""
    )


def parse_href_params(href: str) -> tuple[str, str]:
    """Return (trk, eBP). Either may be ''."""
    try:
        q = parse_qs(urlparse(href).query)
        return (q.get("trk") or [""])[0], (q.get("eBP") or [""])[0]
    except Exception:
        return "", ""


def parse_job_id_from_href(href: str) -> str:
    if "/jobs/view/" not in href:
        return ""
    return href.split("/jobs/view/")[1].split("/")[0].split("?")[0]


def pretty_print(query: str, url: str, snapshot: dict):
    banner = snapshot.get("bannerPresent")
    cards = snapshot.get("cards", [])

    print(f"\n{'=' * 72}")
    print(f"QUERY     : {query!r}")
    print(f"URL       : {url}")
    print(f"CARDS     : {len(cards)}")
    print(f"NO-RESULTS BANNER: {'YES — whole list is filler' if banner else 'no'}")
    if banner:
        print(f"  banner text: {snapshot.get('bannerText', '')[:120]}")
    print(f"{'=' * 72}")

    # Crude "looks like a company query" heuristic for the diagnostic:
    # single-word Capitalized token. Callers can force via --company.
    is_company_query = getattr(pretty_print, "_is_company_query", False)

    buckets = {"real": [], "jymbii": [], "unknown": [], "offtarget": []}
    for c in cards:
        trk, ebp = parse_href_params(c["href"])
        c["_trk"] = trk
        c["_ebp"] = ebp
        c["_job_id"] = parse_job_id_from_href(c["href"])
        klass = classify_ebp(ebp, banner)
        # Populated cards only — skip empty occludable shells for relevance.
        if (
            klass != "jymbii"
            and c["title"]
            and not company_relevance(query, c["company"], is_company_query)
        ):
            c["_class"] = "offtarget"
        else:
            c["_class"] = klass
        buckets[c["_class"]].append(c)

    def _row(c):
        flag = {"real": "✓", "jymbii": "≈", "unknown": "?", "offtarget": "✗"}[c["_class"]]
        occ = "occ" if c["hasOccludable"] else "   "
        t = (c["title"] or "(no title)")[:44]
        co = (c["company"] or "")[:22]
        ebp = (c["_ebp"] or "-")[:26]
        return f"  {c['idx']:>2} {flag} {occ}  {t:<44}  {co:<22}  eBP={ebp}"

    print(f"\n{'real results':=^72}")
    print(f"{len(buckets['real'])}")
    for c in buckets["real"]:
        print(_row(c))

    if buckets["jymbii"]:
        print(f"\n{'jymbii / recommendation pad':=^72}")
        print(f"{len(buckets['jymbii'])}")
        for c in buckets["jymbii"]:
            print(_row(c))

    if buckets["offtarget"]:
        print(f"\n{'off-target (company-mismatch)':=^72}")
        print(f"{len(buckets['offtarget'])}")
        for c in buckets["offtarget"]:
            print(_row(c))

    if buckets["unknown"]:
        print(f"\n{'unknown/empty':=^72}")
        populated_unk = [c for c in buckets["unknown"] if c["title"]]
        empty_unk = [c for c in buckets["unknown"] if not c["title"]]
        print(
            f"{len(buckets['unknown'])} "
            f"(populated={len(populated_unk)}, empty-occludable-shells={len(empty_unk)})"
        )
        for c in populated_unk:
            print(_row(c))

    print(f"\n{'summary':=^72}")
    print(f"  real      : {len(buckets['real'])}")
    print(f"  jymbii    : {len(buckets['jymbii'])}")
    print(f"  offtarget : {len(buckets['offtarget'])}  (company query only)")
    print(f"  unknown   : {len(buckets['unknown'])}")
    print(f"  banner    : {'YES' if banner else 'no'}")
    if not buckets["real"] and (buckets["jymbii"] or buckets["offtarget"]):
        print("\nVERDICT: this query has ZERO real hits — all populated cards are filler.")
    elif buckets["offtarget"]:
        print(
            f"\nVERDICT: mixed — {len(buckets['real'])} real hits + "
            f"{len(buckets['offtarget'])} off-target filler (company name mismatch)."
        )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("query", help="search keyword (quote if multi-word)")
    ap.add_argument("--start", type=int, default=0, help="pagination offset (0, 25, 50, ...)")
    ap.add_argument(
        "--company", action="store_true", help="treat as company name — skip phrase-quoting"
    )
    ap.add_argument("--save", metavar="PATH", help="also write the full card snapshot as JSON")
    ap.add_argument(
        "--keep-open",
        action="store_true",
        help="wait for Enter before closing the browser so you can inspect manually",
    )
    args = ap.parse_args()

    if not SESSION_FILE.exists():
        print(f"No session at {SESSION_FILE}. Run search.py once to log in.")
        sys.exit(1)

    url = _build_search_url(args.query, args.start, args.company)
    print(f"Opening {url}")

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=False,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--disable-features=IsolateOrigins,site-per-process",
            ],
            ignore_default_args=["--enable-automation"],
        )
        ctx = browser.new_context(
            storage_state=str(SESSION_FILE),
            viewport={"width": 1280, "height": 900},
            locale="en-US",
            timezone_id="Asia/Jerusalem",
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
        )
        page = ctx.new_page()
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=25000)
        except PlaywrightTimeout:
            print("Nav timeout.")
            ctx.close()
            browser.close()
            sys.exit(2)

        time.sleep(random.uniform(2.0, 3.0))

        cur = (page.url or "").lower()
        if "login" in cur or "authwall" in cur or "checkpoint" in cur:
            print("Session expired. Re-run search.py to log in again.")
            ctx.close()
            browser.close()
            sys.exit(3)

        final = scroll_inner_list(page, max_rounds=25)
        print(f"Inner-pane scroll settled at {final} cards.")
        snapshot = extract_cards(page)
        # Tell pretty_print whether to apply the company relevance filter.
        pretty_print._is_company_query = bool(args.company)
        pretty_print(args.query, url, snapshot)

        if args.save:
            Path(args.save).write_text(
                json.dumps(
                    {
                        "query": args.query,
                        "url": url,
                        "final_count": final,
                        "snapshot": snapshot,
                    },
                    indent=2,
                    ensure_ascii=False,
                )
            )
            print(f"\nWrote snapshot: {args.save}")

        if args.keep_open:
            print("\nBrowser kept open — press Enter in terminal to close.")
            input()

        ctx.close()
        browser.close()


if __name__ == "__main__":
    main()
