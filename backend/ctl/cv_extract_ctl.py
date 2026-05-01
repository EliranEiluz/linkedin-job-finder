#!/usr/bin/env python3
"""
PDF text extraction for the wizard's CV upload step. Reads raw PDF bytes
on stdin (no JSON wrapper, no base64), shells out to pypdf, prints JSON
to stdout.

The wizard's <input type="file"> ships .pdf files here so we can give the
user real text instead of the gibberish FileReader.readAsText() produces
on a binary PDF.

Stdin: raw PDF bytes (whatever the browser uploaded — no envelope).
Stdout (always JSON, even on failure):
  { ok: true,  text: "...", pages: N, chars: M, truncated_pages: bool }
  { ok: false, error: "human-readable message" }

Caps:
  - 10 MB input — bigger PDFs get rejected before parsing.
  - 100 pages — extra pages are dropped (truncated_pages=true). 100p covers
    every plausible CV; the cap is a safety belt against pathological inputs.
"""

from __future__ import annotations

import json
import sys

MAX_BYTES = 10 * 1024 * 1024  # 10 MB
MAX_PAGES = 100


def _emit(obj: dict, code: int = 0) -> None:
    print(json.dumps(obj, ensure_ascii=False))
    sys.exit(code)


def main() -> int:
    # Read raw bytes (no decoding — stdin.buffer bypasses the text wrapper).
    try:
        data = sys.stdin.buffer.read(MAX_BYTES + 1)
    except Exception as e:  # noqa: BLE001
        _emit({"ok": False, "error": f"failed to read stdin: {e}"}, code=1)
        return 1

    if not data:
        _emit({"ok": False, "error": "no PDF bytes on stdin"}, code=1)
        return 1
    if len(data) > MAX_BYTES:
        _emit(
            {"ok": False, "error": f"PDF exceeds {MAX_BYTES // (1024 * 1024)} MB cap"},
            code=1,
        )
        return 1

    try:
        from pypdf import PdfReader
    except ImportError:
        _emit(
            {
                "ok": False,
                "error": (
                    "pypdf is not installed — run "
                    f"`{sys.executable} -m pip install -r backend/requirements.txt`"
                ),
            },
            code=1,
        )
        return 1

    import io

    try:
        reader = PdfReader(io.BytesIO(data))
    except Exception as e:  # noqa: BLE001
        _emit(
            {"ok": False, "error": f"not a valid PDF: {type(e).__name__}: {e}"},
            code=1,
        )
        return 1

    # Encrypted PDFs without an empty-string password fail extraction. We try
    # the empty password (common case for "secured but not really" PDFs from
    # macOS Preview); if that fails, surface a clear message.
    if reader.is_encrypted:
        try:
            ok = reader.decrypt("")
            if not ok:
                _emit(
                    {
                        "ok": False,
                        "error": (
                            "PDF is password-protected — open it, re-export "
                            "without a password, and try again"
                        ),
                    },
                    code=1,
                )
                return 1
        except Exception as e:  # noqa: BLE001
            _emit(
                {
                    "ok": False,
                    "error": f"PDF is encrypted and decrypt failed: {e}",
                },
                code=1,
            )
            return 1

    pages = reader.pages
    n_pages = len(pages)
    truncated = n_pages > MAX_PAGES
    parts: list[str] = []
    for i, page in enumerate(pages):
        if i >= MAX_PAGES:
            break
        try:
            parts.append(page.extract_text() or "")
        except Exception:  # noqa: BLE001
            # One bad page shouldn't kill the whole extraction. Skip it.
            parts.append("")

    text = "\n\n".join(p.strip() for p in parts if p.strip())

    if not text.strip():
        _emit(
            {
                "ok": False,
                "error": (
                    "no text extracted — this PDF is probably image-only "
                    "(scanned). Paste the text into the textarea instead."
                ),
            },
            code=1,
        )
        return 1

    _emit(
        {
            "ok": True,
            "text": text,
            "pages": min(n_pages, MAX_PAGES),
            "chars": len(text),
            "truncated_pages": truncated,
        }
    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        _emit({"ok": False, "error": f"{type(e).__name__}: {e}"}, code=1)
