#!/usr/bin/env python3
"""
Probe the LinkedIn guest job-search API.

The endpoint `/jobs-guest/jobs/api/seeMoreJobPostings/search` is unauthenticated
and is reportedly free of logged-in personalization. This script hits it,
parses the returned `<li>` cards, and reports whether we can paginate past
the ~25 cap that bites the logged-in browser scraper.

Usage:
  python3 probe_guest_api.py "security researcher"
  python3 probe_guest_api.py "MPC engineer" --pages 6
  python3 probe_guest_api.py "cryptography" --geo-id 103644278    # United States
  python3 probe_guest_api.py "security researcher" --days 7

GeoIds:
  Israel        = 101620260
  United States = 103644278
  United Kingdom = 101165590
  Worldwide     = 92000000
"""

import argparse
import sys
import time
from collections import Counter
from urllib.parse import urlencode

import requests
from bs4 import BeautifulSoup

GUEST_URL = "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search"

ISRAEL_GEO = "101620260"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.linkedin.com/jobs/search/",
}


def fetch_page(query: str, geo_id: str, start: int, date_filter: str) -> tuple[int, str]:
    params = {"keywords": query, "geoId": geo_id, "start": str(start)}
    if date_filter:
        params["f_TPR"] = date_filter
    url = f"{GUEST_URL}?{urlencode(params)}"
    print(f"  GET {url}")
    r = requests.get(url, headers=HEADERS, timeout=20)
    return r.status_code, r.text


def parse_cards(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    out = []
    for li in soup.select("li"):
        link = li.select_one("a[href*='/jobs/view/']")
        if not link:
            continue
        href = link.get("href") or ""
        if "/jobs/view/" not in href:
            continue
        job_id = href.split("/jobs/view/")[1].split("/")[0].split("?")[0]
        title_el = li.select_one(".base-search-card__title, .full-link, h3, .sr-only")
        title = (title_el.get_text(strip=True) if title_el else "").strip()
        co_el = li.select_one(".base-search-card__subtitle a, .base-search-card__subtitle, h4")
        company = (co_el.get_text(strip=True) if co_el else "").strip()
        loc_el = li.select_one(".job-search-card__location")
        location = (loc_el.get_text(strip=True) if loc_el else "").strip()
        date_el = li.select_one("time")
        posted = (date_el.get("datetime") if date_el else "") or ""
        out.append(
            {
                "id": job_id,
                "title": title,
                "company": company,
                "location": location,
                "posted": posted,
                "url": href.split("?")[0],
            }
        )
    # Dedup within the same page (LinkedIn sometimes duplicates).
    seen = set()
    deduped = []
    for c in out:
        if c["id"] in seen:
            continue
        seen.add(c["id"])
        deduped.append(c)
    return deduped


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("query", help='search query, e.g. "security researcher"')
    ap.add_argument("--geo-id", default=ISRAEL_GEO, help=f"geoId (default: Israel {ISRAEL_GEO})")
    ap.add_argument("--days", type=int, default=0, help="date filter in days; 0 = any (default)")
    ap.add_argument(
        "--pages", type=int, default=4, help="number of pages to fetch (start=0,25,...)"
    )
    ap.add_argument(
        "--sleep", type=float, default=2.0, help="seconds between page requests (default 2.0)"
    )
    args = ap.parse_args()

    date_filter = f"r{args.days * 86400}" if args.days else ""

    all_cards = []
    seen_ids = set()
    statuses = []
    page_counts = []
    print(
        f"Probing guest API for {args.query!r}, geoId={args.geo_id}, "
        f"days={args.days or 'any'}, pages={args.pages}"
    )

    for page_idx in range(args.pages):
        start = page_idx * 25
        status, html = fetch_page(args.query, args.geo_id, start, date_filter)
        statuses.append(status)
        if status != 200:
            print(f"  page {page_idx + 1}: HTTP {status} — bailing.")
            page_counts.append(0)
            break
        cards = parse_cards(html)
        page_counts.append(len(cards))
        new_cards = [c for c in cards if c["id"] not in seen_ids]
        for c in new_cards:
            seen_ids.add(c["id"])
            all_cards.append(c)
        print(
            f"  page {page_idx + 1}: {len(cards):>3} cards parsed, "
            f"{len(new_cards)} new (total {len(all_cards)})"
        )
        if not new_cards:
            print(f"  page {page_idx + 1}: no new cards — stopping.")
            break
        time.sleep(args.sleep)

    print()
    print("=" * 72)
    print(f"Query : {args.query!r}")
    print(f"Geo   : {args.geo_id}")
    print(f"Days  : {args.days or 'any'}")
    print(f"Pages : {len(page_counts)} requested ({page_counts})")
    print(f"HTTP  : {statuses}")
    print(f"Unique cards: {len(all_cards)}")
    print("=" * 72)

    if not all_cards:
        print("\n(No results — check status codes above.)")
        sys.exit(0)

    # Top companies
    co_counter = Counter(c["company"] for c in all_cards if c["company"])
    print("\nTop companies:")
    for co, n in co_counter.most_common(20):
        print(f"  {n:>3}  {co}")

    # Sample
    print("\nFirst 15 cards:")
    for c in all_cards[:15]:
        print(
            f"  [{(c['posted'] or '?'):>10}] "
            f"{c['title'][:50]:50} @ {(c['company'] or '?')[:25]:25} "
            f"  {(c['location'] or '?')[:30]}"
        )

    print()
    # Did big-cos appear?
    BIGCO_NAMES = [
        "nvidia",
        "microsoft",
        "google",
        "apple",
        "amazon",
        "intel",
        "ibm",
        "meta",
        "cloudflare",
        "qualcomm",
    ]
    big_hits = dict.fromkeys(BIGCO_NAMES, 0)
    for c in all_cards:
        co = (c["company"] or "").lower()
        for n in BIGCO_NAMES:
            if n in co:
                big_hits[n] += 1
    has_big = sum(big_hits.values())
    if has_big:
        print(f"BIG-CO HITS: {sum(big_hits.values())} total")
        for n, cnt in big_hits.items():
            if cnt:
                print(f"  {n}: {cnt}")
    else:
        print("BIG-CO HITS: 0 (no NVIDIA/MSFT/Google/Apple/etc)")


if __name__ == "__main__":
    main()
