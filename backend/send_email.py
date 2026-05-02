#!/usr/bin/env python3
# DEPRECATED — moved to send_digest.py; will be removed in a future release.
#
# This module is kept as a thin re-export shim so any external tooling that
# still does `from backend.send_email import build_digest_html` (or runs
# `python3 backend/send_email.py`) keeps working through the rename. New
# callers should import from `backend.send_digest` directly.

from __future__ import annotations

import sys

from backend.send_digest import (  # noqa: F401  (re-export surface)
    DIGEST_FILE,
    NEW_IDS_FILE,
    RESULTS_FILE,
    build_digest_html,
    dispatch_digest,
    enabled_channels,
    main,
    send_via_email,
    send_via_telegram,
    write_digest_html,
)

if __name__ == "__main__":
    sys.exit(main())
