"""Tests for backend/ctl/cv_extract_ctl.py.

Reads raw PDF bytes on stdin, writes JSON on stdout. We hand-roll a tiny
valid PDF with pypdf so the test stays self-contained (no fixture file
on disk). Garbage bytes + empty stdin + encrypted PDF round-trips through
the CLI's JSON envelope.
"""

from __future__ import annotations

import io
from pathlib import Path

import pytest


@pytest.fixture
def tiny_pdf_bytes() -> bytes:
    """Build a minimal one-page PDF in-memory using pypdf's writer."""
    pypdf = pytest.importorskip("pypdf")
    writer = pypdf.PdfWriter()
    page = writer.add_blank_page(width=612, height=792)
    # add_blank_page returns a PageObject; merge a tiny text content
    # stream onto it so pypdf's text extractor produces real characters
    # (blank pages give back empty text and the script rejects "image-only" PDFs).
    from pypdf.generic import (  # noqa: PLC0415
        ArrayObject,
        DecodedStreamObject,
        NameObject,
        NumberObject,
    )

    content = b"BT /F1 12 Tf 72 720 Td (Hello CV World) Tj ET"
    cs = DecodedStreamObject()
    cs.set_data(content)
    cs[NameObject("/Length")] = NumberObject(len(content))

    # Attach a Helvetica font resource.
    from pypdf.generic import DictionaryObject  # noqa: PLC0415

    font = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
        }
    )
    font_ref = writer._add_object(font)
    page[NameObject("/Resources")] = DictionaryObject(
        {
            NameObject("/Font"): DictionaryObject({NameObject("/F1"): font_ref}),
        }
    )
    page[NameObject("/Contents")] = ArrayObject([writer._add_object(cs)])

    buf = io.BytesIO()
    writer.write(buf)
    return buf.getvalue()


def test_cv_extract_happy_path(run_ctl, tmp_path: Path, tiny_pdf_bytes: bytes) -> None:  # noqa: ARG001
    rc, out, _err = run_ctl("cv_extract_ctl.py", [], stdin_payload=tiny_pdf_bytes)
    assert rc == 0
    assert out["ok"] is True
    assert "Hello CV World" in out["text"]
    assert out["pages"] == 1
    assert out["chars"] > 0
    assert out["truncated_pages"] is False


def test_cv_extract_empty_stdin(run_ctl, tmp_path: Path) -> None:  # noqa: ARG001
    rc, out, _err = run_ctl("cv_extract_ctl.py", [], stdin_payload=b"")
    assert rc == 1
    assert out["ok"] is False
    assert "no PDF bytes" in out["error"]


def test_cv_extract_garbage_bytes(run_ctl, tmp_path: Path) -> None:  # noqa: ARG001
    rc, out, _err = run_ctl(
        "cv_extract_ctl.py", [], stdin_payload=b"this is definitely not a PDF\xff\xfe\x00"
    )
    assert rc == 1
    assert out["ok"] is False
    assert "not a valid PDF" in out["error"]


def test_cv_extract_oversized_input(run_ctl, tmp_path: Path) -> None:  # noqa: ARG001
    """Cap is 10 MB. A blob >10 MB should be refused before parsing."""
    big = b"X" * (10 * 1024 * 1024 + 100)
    rc, out, _err = run_ctl("cv_extract_ctl.py", [], stdin_payload=big, timeout=30)
    assert rc == 1
    assert "MB cap" in out["error"]


def test_cv_extract_image_only_pdf(run_ctl, tmp_path: Path) -> None:  # noqa: ARG001
    """A PDF with no text content (e.g. a scan) should fail with the
    'image-only' message. pypdf's blank page returns "" from extract_text."""
    pypdf = pytest.importorskip("pypdf")
    writer = pypdf.PdfWriter()
    writer.add_blank_page(width=612, height=792)
    buf = io.BytesIO()
    writer.write(buf)
    rc, out, _err = run_ctl("cv_extract_ctl.py", [], stdin_payload=buf.getvalue())
    assert rc == 1
    assert "image-only" in out["error"]
