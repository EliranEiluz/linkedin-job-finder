#!/usr/bin/env python3
"""
Probe whether we can fetch the full job description for a given LinkedIn
job_id via plain HTTP (no auth). If yes, the guest-API path becomes a
complete pipeline: search → description → Claude scoring, no browser.

Tries (in order):
  1) https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/<id>
     (an undocumented guest endpoint that returns just the description fragment)
  2) https://www.linkedin.com/jobs/view/<id>/        (public anonymous SPA)
  3) Parse JSON-LD <script type="application/ld+json"> JobPosting from (2)

For each strategy: report HTTP status, bytes, length of extracted description,
first 200 chars of description.
"""

import argparse
import json
import re
import sys

import requests
from bs4 import BeautifulSoup

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}


def _strip_html(s: str) -> str:
    s = re.sub(r"<[^>]+>", " ", s or "")
    s = re.sub(r"\s+", " ", s).strip()
    return s


def strategy_jobposting_endpoint(job_id: str) -> dict:
    """The /jobs-guest/jobs/api/jobPosting/<id> endpoint — undocumented but
    historically returns the description block as a small HTML fragment."""
    url = f"https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/{job_id}"
    r = requests.get(url, headers=HEADERS, timeout=15)
    out = {
        "strategy": "jobposting_endpoint",
        "url": url,
        "status": r.status_code,
        "bytes": len(r.content),
    }
    if r.status_code == 200 and r.text.strip():
        soup = BeautifulSoup(r.text, "html.parser")
        # Look for the description container — multiple class variants.
        desc_el = (soup.select_one(".description__text") or
                   soup.select_one(".show-more-less-html__markup") or
                   soup.select_one("[class*='description']"))
        if desc_el:
            desc = _strip_html(desc_el.decode_contents())
        else:
            desc = _strip_html(r.text)
        out["desc_len"] = len(desc)
        out["sample"] = desc[:300]
    return out


def strategy_public_view(job_id: str) -> tuple[dict, str]:
    """Fetch the public SPA page and try CSS-class extraction.
    Returns (result_dict, raw_html) so the JSON-LD strategy can reuse the html."""
    url = f"https://www.linkedin.com/jobs/view/{job_id}/"
    r = requests.get(url, headers=HEADERS, timeout=15, allow_redirects=True)
    out = {
        "strategy": "public_view_html",
        "url": url,
        "final_url": r.url,
        "status": r.status_code,
        "bytes": len(r.content),
    }
    if "authwall" in (r.url or "").lower() or "/login" in (r.url or "").lower():
        out["note"] = "redirected to authwall/login"
        return out, r.text
    if r.status_code != 200:
        return out, r.text
    soup = BeautifulSoup(r.text, "html.parser")
    desc_el = (soup.select_one(".description__text") or
               soup.select_one(".show-more-less-html__markup") or
               soup.select_one(".jobs-description__content") or
               soup.select_one("#job-details"))
    if desc_el:
        desc = _strip_html(desc_el.decode_contents())
        out["desc_len"] = len(desc)
        out["sample"] = desc[:300]
    return out, r.text


def strategy_jsonld(job_id: str, html: str) -> dict:
    """Parse <script type='application/ld+json'> JobPosting blocks."""
    out = {"strategy": "json_ld_from_public_view"}
    soup = BeautifulSoup(html, "html.parser")
    found = None
    for s in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(s.get_text())
        except Exception:
            continue
        blocks = data if isinstance(data, list) else [data]
        for b in blocks:
            if isinstance(b, dict) and b.get("@type") in ("JobPosting", "JobPostings"):
                found = b
                break
        if found:
            break
    if not found:
        out["note"] = "no JSON-LD JobPosting block found"
        return out
    desc = found.get("description") or ""
    desc = _strip_html(desc)
    out["title"] = found.get("title")
    out["company"] = (found.get("hiringOrganization") or {}).get("name")
    out["date_posted"] = found.get("datePosted")
    out["valid_through"] = found.get("validThrough")
    out["employment_type"] = found.get("employmentType")
    out["desc_len"] = len(desc)
    out["sample"] = desc[:300]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("job_id", help="LinkedIn job ID, e.g. 4392415051")
    args = ap.parse_args()
    job_id = args.job_id.strip()
    if not job_id.isdigit():
        print(f"Job ID looks suspicious: {job_id!r}", file=sys.stderr)

    print(f"=== job_id = {job_id} ===\n")

    # Strategy 1: jobPosting fragment endpoint
    s1 = strategy_jobposting_endpoint(job_id)
    print(f"[1] {s1['strategy']}")
    print(f"    url: {s1['url']}")
    print(f"    HTTP {s1['status']}, {s1['bytes']:,} bytes")
    if "desc_len" in s1:
        print(f"    desc_len={s1['desc_len']:,}")
        print(f"    sample: {s1['sample']!r}")
    print()

    # Strategy 2: public view (SPA HTML)
    s2, html = strategy_public_view(job_id)
    print(f"[2] {s2['strategy']}")
    print(f"    url: {s2['url']}")
    print(f"    final: {s2.get('final_url')}")
    print(f"    HTTP {s2['status']}, {s2['bytes']:,} bytes")
    if "note" in s2:
        print(f"    note: {s2['note']}")
    if "desc_len" in s2:
        print(f"    desc_len={s2['desc_len']:,}")
        print(f"    sample: {s2['sample']!r}")
    print()

    # Strategy 3: JSON-LD parsed from #2's HTML
    s3 = strategy_jsonld(job_id, html)
    print(f"[3] {s3['strategy']}")
    if "note" in s3:
        print(f"    note: {s3['note']}")
    else:
        print(f"    title: {s3.get('title')!r}")
        print(f"    company: {s3.get('company')!r}")
        print(f"    date_posted: {s3.get('date_posted')}  valid_through: {s3.get('valid_through')}")
        print(f"    employment_type: {s3.get('employment_type')}")
        print(f"    desc_len={s3['desc_len']:,}")
        print(f"    sample: {s3['sample']!r}")
    print()

    # Verdict
    best = max(
        (s for s in (s1, s2, s3) if s.get("desc_len")),
        key=lambda s: s["desc_len"],
        default=None,
    )
    if best:
        print(f"WINNER: {best['strategy']} ({best['desc_len']:,} chars)")
    else:
        print("WINNER: none — all strategies failed.")


if __name__ == "__main__":
    main()
