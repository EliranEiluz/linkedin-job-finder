#!/usr/bin/env python3
"""
Build a polished HTML digest of the latest LinkedIn job-search results,
write it to digest.html, and (when env vars are set) fan it out to every
configured notification channel — currently SMTP email and Telegram.

Required env vars per channel (a channel is "enabled" only when all its
vars are set; otherwise it's silently skipped):

  Email (SMTP):
    SMTP_HOST   e.g. smtp.gmail.com
    SMTP_PORT   e.g. 587 (default 587; 465 auto-enables SMTPS)
    SMTP_USER   sender address
    SMTP_PASS   app password
    EMAIL_TO    recipient address (defaults to SMTP_USER)
    SMTP_USE_SSL=1   force SMTPS on a non-465 port

  Telegram:
    TELEGRAM_BOT_TOKEN   from @BotFather
    TELEGRAM_CHAT_ID     numeric or @channelusername

Usage:
  python send_digest.py                      # write digest + dispatch to enabled channels
  python send_digest.py --save-only          # write digest only; no channel dispatch
  python send_digest.py --all-today          # ignore new_ids.json, use today's
  python send_digest.py --dry-run            # print HTML to stdout
"""

from __future__ import annotations

import json
import os
import smtplib
import ssl
import sys
from argparse import ArgumentParser
from datetime import datetime
from email.message import EmailMessage
from html import escape
from pathlib import Path
from typing import Any

# State files live at the project ROOT (one level up from backend/).
HERE = Path(__file__).parent
ROOT = HERE.parent
RESULTS_FILE = ROOT / "results.json"
NEW_IDS_FILE = ROOT / "new_ids.json"
DIGEST_FILE = ROOT / "digest.html"

# Telegram caps a single sendMessage at 4096 chars (UTF-16 code units, but the
# practical safe ceiling is 4096 chars). We send a short summary instead of
# trying to chunk the digest — chunking ruins the HTML structure and floods
# the chat with N+1 messages, which is worse than a one-line pointer.
TELEGRAM_MAX_CHARS = 4096

# Hard timeout for the Telegram HTTPS round-trip. Mirrors the SMTP timeout
# so all channels share a similar SLA.
TELEGRAM_TIMEOUT_S = 30

# Channels we know about. Kept as a single source of truth so new channels
# only get added in one place.
KNOWN_CHANNELS = ("email", "telegram")

# ---------- DESIGN TOKENS ----------
# All inline-styled because every email client (especially Gmail and Outlook)
# strips or rewrites <style> in unpredictable ways. Keep colors minimal.
COLOR = {
    "bg": "#0f1115",  # page bg (dark) — used for outer wrapper only
    "card": "#ffffff",
    "border": "#e5e7eb",
    "muted": "#6b7280",
    "text": "#111827",
    "subtle": "#f3f4f6",
    "brand": "#4338ca",  # indigo
    "good": "#059669",  # emerald
    "good_bg": "#ecfdf5",
    "ok": "#b45309",  # amber
    "ok_bg": "#fffbeb",
    "skip": "#6b7280",
    "skip_bg": "#f3f4f6",
    "priority": "#dc2626",  # red
    "priority_bg": "#fef2f2",
    "chip_bg": "#f3f4f6",
    "chip_text": "#374151",
}

FONT_STACK = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif"


# ---------- DATA ----------


def _load_json(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text())
    except Exception:
        return default


def _select_jobs(args) -> list[dict]:
    results = _load_json(RESULTS_FILE, [])
    if args.all_today:
        today = datetime.now().date().isoformat()
        jobs = [j for j in results if str(j.get("found_at", "")).startswith(today)]
    else:
        new_ids = set(_load_json(NEW_IDS_FILE, []))
        if not new_ids:
            today = datetime.now().date().isoformat()
            jobs = [j for j in results if str(j.get("found_at", "")).startswith(today)]
        else:
            jobs = [j for j in results if j["id"] in new_ids]
    # Drop skipped — they shouldn't surface in the digest.
    return [j for j in jobs if j.get("fit") != "skip"]


# ---------- RENDERING ----------


def _chip(label: str, fg: str | None = None, bg: str | None = None) -> str:
    fg = fg or COLOR["chip_text"]
    bg = bg or COLOR["chip_bg"]
    return (
        f'<span style="display:inline-block;padding:2px 9px;margin:0 4px 4px 0;'
        f"border-radius:999px;background:{bg};color:{fg};font-size:11px;"
        f"font-weight:600;letter-spacing:0.02em;line-height:18px;"
        f'white-space:nowrap">{escape(label)}</span>'
    )


def _score_badge(score: int | None, fit: str | None) -> str:
    if score is None and not fit:
        return ""
    fit = fit or ""
    fg = COLOR.get(fit, COLOR["muted"])
    bg = COLOR.get(f"{fit}_bg", COLOR["subtle"])
    icon = {"good": "✓", "ok": "~", "skip": "✗"}.get(fit, "·")
    s = f"{score}/10" if score is not None else fit
    return (
        f'<span style="display:inline-block;padding:6px 12px;border-radius:8px;'
        f"background:{bg};color:{fg};font-weight:700;font-size:13px;"
        f'border:1px solid {fg}33;white-space:nowrap">'
        f"{icon}&nbsp;{escape(str(s))}</span>"
    )


def _section_header(title: str, count: int, accent: str) -> str:
    return (
        f'<div style="margin:32px 0 12px;padding-bottom:8px;'
        f'border-bottom:2px solid {accent}">'
        f'<span style="font-size:14px;font-weight:700;color:{accent};'
        f'text-transform:uppercase;letter-spacing:0.08em">'
        f"{escape(title)}</span>"
        f'<span style="margin-left:8px;color:{COLOR["muted"]};'
        f'font-size:13px;font-weight:500">'
        f"{count}</span></div>"
    )


def _render_job_card(j: dict) -> str:
    title = escape(j.get("title", "(no title)"))
    company = escape(j.get("company", ""))
    location = escape(j.get("location", ""))
    url = escape(j.get("url", "#"))
    fit = j.get("fit")
    score = j.get("score")
    is_priority = j.get("priority")
    scored_by = j.get("scored_by", "")
    query = j.get("query", "")
    msc = j.get("msc_required")

    # Top-left chips: priority + msc + query source
    top_chips = []
    if is_priority:
        top_chips.append(_chip("🔥 PRIORITY", COLOR["priority"], COLOR["priority_bg"]))
    if msc:
        top_chips.append(_chip("MSc valued"))
    if query:
        top_chips.append(_chip(f"matched: {query}"))

    # Reasons / signals
    reasons = j.get("fit_reasons", []) or []
    # Strip leading +/- markers from regex fallback for cleaner display.
    cleaned_reasons = [r.lstrip("+-").strip() for r in reasons if r.strip()]
    reasons_html = ""
    if cleaned_reasons:
        items = "".join(
            f'<li style="margin:4px 0;color:{COLOR["text"]};font-size:13px;'
            f'line-height:1.45">{escape(r)}</li>'
            for r in cleaned_reasons[:6]
        )
        reasons_html = (
            f'<ul style="margin:10px 0 0;padding:0 0 0 18px;color:{COLOR["text"]}">{items}</ul>'
        )

    # Footer chip showing scoring source. Uses the active LLM provider name
    # rather than hardcoding any single vendor in the user-visible blurb.
    source_label = {
        "regex": "regex fallback (no description)",
        "title-filter": "title pre-filter",
    }.get(scored_by, f"scored by {scored_by}" if scored_by else "unscored")

    border_color = COLOR["priority"] if is_priority else COLOR["border"]
    border_width = "2px" if is_priority else "1px"

    return f'''
<table role="presentation" cellpadding="0" cellspacing="0" border="0"
       width="100%" style="margin:0 0 14px;border-collapse:separate;
       border-radius:12px;background:{COLOR["card"]};
       border:{border_width} solid {border_color};
       box-shadow:0 1px 2px rgba(15,23,42,0.04)">
  <tr><td style="padding:18px 20px">

    <!-- header row: title left, score right -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td style="vertical-align:top">
          <a href="{url}" style="text-decoration:none;color:{COLOR["text"]};
             font-size:17px;font-weight:700;line-height:1.3">{title}</a>
          <div style="margin-top:4px;color:{COLOR["muted"]};font-size:13px">
            <span style="font-weight:600;color:{COLOR["text"]}">{company}</span>
            {" · " + location if location else ""}
          </div>
        </td>
        <td style="vertical-align:top;text-align:right;padding-left:12px;width:90px">
          {_score_badge(score, fit)}
        </td>
      </tr>
    </table>

    <!-- chips -->
    {('<div style="margin-top:12px">' + "".join(top_chips) + "</div>") if top_chips else ""}

    <!-- reasons -->
    {reasons_html}

    <!-- footer: open link + source -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
           style="margin-top:14px;border-top:1px solid {COLOR["subtle"]};padding-top:10px">
      <tr>
        <td style="vertical-align:middle">
          <a href="{url}" style="display:inline-block;padding:6px 12px;
             background:{COLOR["brand"]};color:#fff;text-decoration:none;
             border-radius:6px;font-size:12px;font-weight:600">
             Open on LinkedIn →
          </a>
        </td>
        <td style="vertical-align:middle;text-align:right;color:{COLOR["muted"]};
                   font-size:11px;font-style:italic">
          {escape(source_label)}
        </td>
      </tr>
    </table>

  </td></tr>
</table>
'''


def build_digest_html(jobs: list[dict], generated_at: datetime | None = None) -> str:
    generated_at = generated_at or datetime.now()
    timestamp = generated_at.strftime("%a %b %d, %Y · %H:%M")

    priority = [j for j in jobs if j.get("priority")]
    non_pri = [j for j in jobs if not j.get("priority")]
    good = [j for j in non_pri if j.get("fit") == "good"]
    ok = [j for j in non_pri if j.get("fit") == "ok"]
    other = [j for j in non_pri if j.get("fit") not in ("good", "ok", "skip")]

    # Sort each section by score desc.
    def _by_score(group):
        return sorted(group, key=lambda x: -(x.get("score") or 0))

    priority = _by_score(priority)
    good = _by_score(good)
    ok = _by_score(ok)

    total = len(jobs)
    summary_chips = "".join(
        [
            _chip(f"{len(priority)} 🔥 priority", COLOR["priority"], COLOR["priority_bg"])
            if priority
            else "",
            _chip(f"{len(good)} ✓ good", COLOR["good"], COLOR["good_bg"]) if good else "",
            _chip(f"{len(ok)} ~ ok", COLOR["ok"], COLOR["ok_bg"]) if ok else "",
            _chip(f"{len(other)} unscored") if other else "",
        ]
    )

    sections_html = []
    if priority:
        sections_html.append(
            _section_header("🔥 Priority companies", len(priority), COLOR["priority"])
        )
        sections_html.extend(_render_job_card(j) for j in priority)
    if good:
        sections_html.append(_section_header("✓ Good fit", len(good), COLOR["good"]))
        sections_html.extend(_render_job_card(j) for j in good)
    if ok:
        sections_html.append(_section_header("~ OK fit", len(ok), COLOR["ok"]))
        sections_html.extend(_render_job_card(j) for j in ok)
    if other:
        sections_html.append(_section_header("Unscored", len(other), COLOR["muted"]))
        sections_html.extend(_render_job_card(j) for j in other)

    if not jobs:
        body_html = f"""
<div style="padding:60px 20px;text-align:center;color:{COLOR["muted"]};
            font-size:15px">
  <div style="font-size:48px;margin-bottom:12px">🦗</div>
  No new jobs since the last run.
</div>"""
    else:
        body_html = "".join(sections_html)

    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>LinkedIn Job Digest — {escape(timestamp)}</title>
</head>
<body style="margin:0;padding:0;background:#f6f7fb;font-family:{FONT_STACK};
             color:{COLOR["text"]};-webkit-font-smoothing:antialiased">

<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
       style="background:#f6f7fb;padding:32px 16px">
  <tr><td align="center">

    <table role="presentation" cellpadding="0" cellspacing="0" border="0"
           width="700" style="max-width:700px;width:100%">

      <!-- HEADER -->
      <tr><td style="padding:0 4px 24px">
        <div style="font-size:11px;font-weight:700;color:{COLOR["brand"]};
                    text-transform:uppercase;letter-spacing:0.12em">
          LinkedIn Job Digest
        </div>
        <h1 style="margin:6px 0 6px;font-size:26px;font-weight:800;
                   color:{COLOR["text"]};line-height:1.2">
          {total} new {"jobs" if total != 1 else "job"} worth a look
        </h1>
        <div style="color:{COLOR["muted"]};font-size:13px">{escape(timestamp)}</div>
        {('<div style="margin-top:14px">' + summary_chips + "</div>") if summary_chips else ""}
      </td></tr>

      <!-- BODY -->
      <tr><td>{body_html}</td></tr>

      <!-- FOOTER -->
      <tr><td style="padding:30px 4px 0;text-align:center;color:{COLOR["muted"]};
                     font-size:11px;line-height:1.5">
        Auto-generated by <code>~/linkedin-jobs/search.py</code>.<br>
        Skipped jobs are saved in <code>results.json</code> but excluded from this digest.<br>
        Dedup state in <code>seen_jobs.json</code>.
      </td></tr>

    </table>

  </td></tr>
</table>

</body>
</html>"""


def write_digest_html(jobs: list[dict], *, path: Path | None = None) -> Path:
    """Render the HTML digest and write it to disk. Returns the path written.

    Pure I/O wrapper around `build_digest_html`. Always overwrites — the
    digest reflects the most recent scrape, not a history. Path defaults
    to the repo-root DIGEST_FILE.
    """
    out_path = path or DIGEST_FILE
    html = build_digest_html(jobs)
    out_path.write_text(html, encoding="utf-8")
    return out_path


# ---------- CHANNEL: EMAIL ----------


def send_via_email(
    html: str,
    *,
    jobs: list[dict] | None = None,
    host: str | None = None,
    user: str | None = None,
    password: str | None = None,
    port: int | None = None,
    to_addr: str | None = None,
    use_ssl: bool | None = None,
) -> tuple[bool, str]:
    """SMTP send. Returns (ok, status_message). Pulls missing kwargs from env.

    The legacy `_send_email(html, jobs)` shape is preserved through the
    `jobs` keyword (used to populate the subject summary). Returning a
    tuple lets the dispatcher log per-channel outcomes uniformly.
    """
    host = host or os.environ.get("SMTP_HOST")
    user = user or os.environ.get("SMTP_USER")
    password = password if password is not None else os.environ.get("SMTP_PASS")
    if not (host and user and password):
        return False, "SMTP not configured (set SMTP_HOST / SMTP_USER / SMTP_PASS)"

    if port is None:
        try:
            port = int(os.environ.get("SMTP_PORT", "587"))
        except ValueError:
            return False, "SMTP_PORT is not a valid integer"
    to_addr = (to_addr or os.environ.get("EMAIL_TO") or user).strip() or user

    jobs = jobs or []
    priority_count = sum(1 for j in jobs if j.get("priority"))
    good_count = sum(1 for j in jobs if j.get("fit") == "good")
    subject = f"LinkedIn jobs — {len(jobs)} new" + (
        f" ({priority_count}🔥 {good_count}✓)" if priority_count or good_count else ""
    )

    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = user
    msg["To"] = to_addr
    msg.set_content(f"{len(jobs)} new jobs. Open in an HTML-capable client to see the digest.")
    msg.add_alternative(html, subtype="html")

    # Build an SSL context that trusts the certifi CA bundle. Python on macOS
    # often ships without the system root CAs wired into ssl.create_default_context,
    # which makes Gmail SMTP fail with CERTIFICATE_VERIFY_FAILED. Falling back
    # to certifi (already a transitive dep via requests) fixes this for any
    # Python install path.
    try:
        import certifi

        ctx = ssl.create_default_context(cafile=certifi.where())
    except Exception:
        ctx = ssl.create_default_context()

    # Implicit-SSL (port 465, SMTPS) vs. STARTTLS (port 587). iCloud, Fastmail,
    # Yahoo and many corporate hosts only accept SMTPS — silently fail with the
    # STARTTLS-only path. Explicit opt-in via SMTP_USE_SSL=1, OR auto-enable
    # when port == 465 (the IANA SMTPS port).
    if use_ssl is None:
        use_ssl = (
            os.environ.get("SMTP_USE_SSL", "").strip().lower() in ("1", "true", "yes")
            or port == 465
        )
    try:
        if use_ssl:
            with smtplib.SMTP_SSL(host, port, timeout=30, context=ctx) as smtp:
                smtp.login(user, password)
                smtp.send_message(msg)
        else:
            with smtplib.SMTP(host, port, timeout=30) as smtp:
                smtp.ehlo()
                smtp.starttls(context=ctx)
                smtp.login(user, password)
                smtp.send_message(msg)
    except Exception as e:
        return False, f"SMTP error: {type(e).__name__}: {e}"

    return True, f"sent to {to_addr}: {subject}"


# ---------- CHANNEL: TELEGRAM ----------


def _telegram_summary_message(jobs: list[dict]) -> str:
    """Short HTML message Telegram falls back to when the digest is huge.

    Stays under TELEGRAM_MAX_CHARS by construction. Uses Telegram's HTML
    parse_mode (supports a small allow-list: <b> <i> <a> <code> <pre>).
    """
    n = len(jobs)
    if n == 0:
        return "<b>No new jobs since the last run.</b>"
    priority = sum(1 for j in jobs if j.get("priority"))
    good = sum(1 for j in jobs if j.get("fit") == "good")
    breakdown = []
    if priority:
        breakdown.append(f"{priority} priority")
    if good:
        breakdown.append(f"{good} good fit")
    suffix = f" ({', '.join(breakdown)})" if breakdown else ""
    return (
        f"<b>{n} new {'jobs' if n != 1 else 'job'} found</b>{suffix} — "
        "open the Run History tab to view the digest."
    )


def send_via_telegram(
    html_or_text: str,
    *,
    bot_token: str | None = None,
    chat_id: str | None = None,
    jobs: list[dict] | None = None,
) -> tuple[bool, str]:
    """POST to Telegram's sendMessage endpoint. Returns (ok, status_message).

    `html_or_text` may exceed 4096 chars; in that case we send a short summary
    (`_telegram_summary_message(jobs)`) instead of trying to chunk — chunking
    Telegram messages past 4096 chars yields HTML that breaks mid-tag and
    floods the chat with N+1 messages, both worse outcomes than a one-line
    pointer to the on-disk digest.

    The bot_token NEVER appears in the returned error message — Telegram
    error responses can echo the URL, so we strip the URL on failure paths.
    """
    bot_token = bot_token or os.environ.get("TELEGRAM_BOT_TOKEN", "")
    chat_id = chat_id or os.environ.get("TELEGRAM_CHAT_ID", "")
    if not bot_token or not chat_id:
        return False, "Telegram not configured (set TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)"

    text = html_or_text
    if len(text) > TELEGRAM_MAX_CHARS:
        text = _telegram_summary_message(jobs or [])
        # Defensive: if the summary itself somehow overflowed, hard-truncate.
        if len(text) > TELEGRAM_MAX_CHARS:
            text = text[: TELEGRAM_MAX_CHARS - 1] + "…"

    url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
    # Annotated explicitly because mypy infers `dict[str, object]` from the
    # mixed value types, and `requests.post(json=...)` wants a JsonType-ish
    # shape. `dict[str, Any]` accepts both.
    payload: dict[str, Any] = {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": False,
    }
    try:
        import requests

        resp = requests.post(url, json=payload, timeout=TELEGRAM_TIMEOUT_S)
    except Exception as e:
        # Sanitize: requests exceptions can include the URL (which contains
        # the bot token). Strip any substring that looks like the token.
        msg = str(e).replace(bot_token, "<redacted>")
        return False, f"Telegram request error: {type(e).__name__}: {msg}"

    if resp.status_code != 200:
        # Telegram returns JSON like {"ok": false, "error_code": 400, "description": "..."}
        body_snip = ""
        try:
            body = resp.json()
            body_snip = str(body.get("description") or body)[:200]
        except Exception:
            body_snip = (resp.text or "")[:200]
        body_snip = body_snip.replace(bot_token, "<redacted>")
        return False, f"Telegram HTTP {resp.status_code}: {body_snip}"

    return True, f"sent to chat {chat_id}"


# ---------- CHANNEL RESOLUTION + DISPATCH ----------


def enabled_channels() -> list[str]:
    """Inspect os.environ and return the subset of KNOWN_CHANNELS that have
    all their required vars set. Used by the scraper to decide what to
    fan out to without hardcoding a channel list.
    """
    out: list[str] = []
    if (
        os.environ.get("SMTP_HOST", "").strip()
        and os.environ.get("SMTP_USER", "").strip()
        and os.environ.get("SMTP_PASS", "").strip()
    ):
        out.append("email")
    if (
        os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
        and os.environ.get("TELEGRAM_CHAT_ID", "").strip()
    ):
        out.append("telegram")
    return out


def dispatch_digest(
    jobs: list[dict],
    *,
    channels: list[str],
    digest_path: Path | None = None,
) -> dict[str, tuple[bool, str]]:
    """Top-level entrypoint for the scraper.

    Always writes the digest HTML to disk (best-effort: a write failure
    surfaces as a false "digest_write" key but doesn't abort channel sends
    that don't depend on the file). Then for each channel in `channels`,
    invokes the matching sender. Returns `{channel: (ok, msg)}` so the
    caller can log per-channel outcomes.

    `channels` should typically be `enabled_channels()` — but the caller
    can pass a narrower list (e.g. for unit tests, or to suppress one
    channel temporarily).
    """
    results: dict[str, tuple[bool, str]] = {}
    html = build_digest_html(jobs)
    out_path = digest_path or DIGEST_FILE
    try:
        out_path.write_text(html, encoding="utf-8")
    except Exception as e:
        # Channel sends below can still succeed (email embeds the HTML in
        # the message body, telegram only needs the summary). Surface the
        # failure but don't abort.
        results["digest_write"] = (False, f"{type(e).__name__}: {e}")

    for ch in channels:
        if ch == "email":
            results["email"] = send_via_email(html, jobs=jobs)
        elif ch == "telegram":
            results["telegram"] = send_via_telegram(html, jobs=jobs)
        else:
            results[ch] = (False, f"unknown channel: {ch}")
    return results


# ---------- CLI ----------


def main():
    parser = ArgumentParser()
    parser.add_argument(
        "--all-today", action="store_true", help="ignore new_ids.json; include all jobs found today"
    )
    parser.add_argument(
        "--save-only", action="store_true", help="write digest.html only; do not dispatch"
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="print HTML to stdout; do not write or send"
    )
    parser.add_argument(
        "--out", default=str(DIGEST_FILE), help=f"output path (default: {DIGEST_FILE})"
    )
    args = parser.parse_args()

    jobs = _select_jobs(args)
    html = build_digest_html(jobs)

    if args.dry_run:
        print(html)
        return 0

    Path(args.out).write_text(html, encoding="utf-8")
    print(f"Wrote digest: {args.out}  ({len(jobs)} jobs)")

    if args.save_only:
        return 0

    if not jobs:
        # No need to notify on an empty digest unless explicitly requested.
        print("Nothing to send (no new jobs).")
        return 0

    channels = enabled_channels()
    if not channels:
        print(
            "No notification channels configured — skipping dispatch "
            "(set SMTP_HOST/USER/PASS for email, TELEGRAM_BOT_TOKEN/CHAT_ID for telegram)."
        )
        return 0

    overall_rc = 0
    for ch in channels:
        if ch == "email":
            ok, msg = send_via_email(html, jobs=jobs)
        elif ch == "telegram":
            ok, msg = send_via_telegram(html, jobs=jobs)
        else:
            ok, msg = False, f"unknown channel: {ch}"
        prefix = "OK" if ok else "FAIL"
        stream = sys.stdout if ok else sys.stderr
        print(f"[{prefix}] {ch}: {msg}", file=stream)
        if not ok:
            overall_rc = 3
    return overall_rc


if __name__ == "__main__":
    sys.exit(main())
