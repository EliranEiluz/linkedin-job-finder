#!/usr/bin/env python3
"""
Remote-access status CLI for the Crawler Config "Access from anywhere" panel.

The panel surfaces *status only* — whether Tailscale and Cloudflare Tunnel
are installed/running, what URL Tailscale exposes, what tunnels (if any)
are configured. The user runs the actual install + auth commands in their
terminal; we never auto-install or auto-configure system tools.

One command:

  python3 remote_access_ctl.py status
      -> {
           ok: bool,
           tailscale: { installed, running?, hostname?, ipv4?, url?, error? },
           cloudflare: { installed, tunnels?: [{name, status}], error? },
           vite_host_binding: { all_interfaces: bool, note: str },
         }

Failure isolation: tailscale CLI being absent never breaks the cloudflare
half of the response and vice versa. Each detector is wrapped in a
broad-except that turns any exception into a structured `error` field.

Same JSON CLI conventions as preflight_ctl.py: read no stdin, emit one
JSON envelope on stdout, exit 0/1.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent  # backend/ctl/
ROOT = HERE.parent.parent  # project root
sys.path.insert(0, str(HERE))

from _common import emit as _emit  # noqa: E402  (sys.path shim above)

# Outer per-CLI subprocess timeout. Kept tight — these are local CLIs that
# return in <1s on a healthy machine; anything slower means the tool is
# broken and we'd rather report "error" than block the panel for 30s.
CLI_TIMEOUT_S = 5

# Default port the Vite dev server binds. The panel surfaces this as part
# of the URL it tells the user to open. Hardcoded rather than parsed out
# of vite.config.ts because the config file is 1900+ lines and parsing it
# pulls in a much larger surface area for a value that hasn't changed.
VITE_DEFAULT_PORT = 5173

# Path to ui/package.json — used by the host-binding heuristic. Computed
# once at import time so tests can monkeypatch.
PACKAGE_JSON_PATH = ROOT / "ui" / "package.json"


def _detect_tailscale() -> dict[str, Any]:
    """Return the tailscale half of the status envelope.

    Three branches:
      1. CLI not on PATH → {installed: False}
      2. CLI on PATH but `tailscale status --json` fails / times out →
         {installed: True, running: False, error: "<short>"}
      3. CLI on PATH and JSON parses → {installed: True, running: True,
         hostname, ipv4, url}
    """
    exe = shutil.which("tailscale")
    if not exe:
        return {"installed": False}

    try:
        proc = subprocess.run(
            [exe, "status", "--json"],
            capture_output=True,
            text=True,
            timeout=CLI_TIMEOUT_S,
        )
    except subprocess.TimeoutExpired:
        return {"installed": True, "running": False, "error": "tailscale status timed out"}
    except Exception as e:
        return {
            "installed": True,
            "running": False,
            "error": f"tailscale status failed: {type(e).__name__}: {e}",
        }

    if proc.returncode != 0:
        # Common case: tailscaled not running, or `tailscale up` not run yet.
        # The CLI's stderr is short and user-facing; surface a trimmed copy.
        stderr = (proc.stderr or "").strip().splitlines()
        msg = stderr[0] if stderr else f"tailscale status exited {proc.returncode}"
        return {"installed": True, "running": False, "error": msg[:200]}

    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError as e:
        return {
            "installed": True,
            "running": False,
            "error": f"tailscale status emitted non-JSON: {e}",
        }

    self_node = data.get("Self") if isinstance(data, dict) else None
    if not isinstance(self_node, dict):
        return {
            "installed": True,
            "running": False,
            "error": "tailscale status missing Self node",
        }

    # DNSName is the MagicDNS-style "host.tail-scale.ts.net." (note trailing
    # dot in some versions). HostName is the bare host. Strip the trailing
    # dot if present so the URL is paste-friendly.
    raw_dns = self_node.get("DNSName")
    dns_name = (raw_dns.rstrip(".") if isinstance(raw_dns, str) else "") or ""
    hostname = self_node.get("HostName")
    if not isinstance(hostname, str):
        hostname = ""
    ips = self_node.get("TailscaleIPs")
    ipv4 = ""
    if isinstance(ips, list):
        for ip in ips:
            if isinstance(ip, str) and ":" not in ip:  # filter out v6 entries
                ipv4 = ip
                break

    # Prefer the DNS name for the URL (works even if the v4 changes); fall
    # back to the IP if for some reason DNS isn't set up yet.
    host_for_url = dns_name or ipv4 or hostname
    url = f"http://{host_for_url}:{VITE_DEFAULT_PORT}" if host_for_url else ""

    return {
        "installed": True,
        "running": True,
        "hostname": dns_name or hostname,
        "ipv4": ipv4,
        "url": url,
    }


def _detect_cloudflare() -> dict[str, Any]:
    """Return the cloudflared half of the status envelope.

    Branches mirror tailscale: not-installed / installed-but-failing /
    installed-and-listing-tunnels. An empty tunnel list is a valid healthy
    state (`installed: True, tunnels: []`) — the user has the CLI but
    hasn't created a tunnel yet.
    """
    exe = shutil.which("cloudflared")
    if not exe:
        return {"installed": False}

    try:
        proc = subprocess.run(
            [exe, "tunnel", "list", "--output", "json"],
            capture_output=True,
            text=True,
            timeout=CLI_TIMEOUT_S,
        )
    except subprocess.TimeoutExpired:
        return {"installed": True, "error": "cloudflared tunnel list timed out"}
    except Exception as e:
        return {
            "installed": True,
            "error": f"cloudflared tunnel list failed: {type(e).__name__}: {e}",
        }

    if proc.returncode != 0:
        # Most common cause: not logged in (no cert.pem). We surface the
        # short stderr so the panel can show "log in via `cloudflared
        # tunnel login`" without us hardcoding that copy.
        stderr = (proc.stderr or "").strip().splitlines()
        msg = stderr[0] if stderr else f"cloudflared tunnel list exited {proc.returncode}"
        return {"installed": True, "error": msg[:200], "tunnels": []}

    raw = (proc.stdout or "").strip()
    if not raw:
        return {"installed": True, "tunnels": []}

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        return {"installed": True, "error": f"cloudflared emitted non-JSON: {e}", "tunnels": []}

    tunnels: list[dict[str, str]] = []
    if isinstance(data, list):
        for entry in data:
            if not isinstance(entry, dict):
                continue
            name = entry.get("name")
            status = entry.get("status")
            tunnels.append(
                {
                    "name": str(name) if isinstance(name, str) else "",
                    "status": str(status).upper() if isinstance(status, str) else "UNKNOWN",
                }
            )

    return {"installed": True, "tunnels": tunnels}


# Match `server: { host: true }` or `server: { host: '0.0.0.0' }` etc.
# Permissive: we only care that the user opted into all-interfaces somewhere.
_VITE_HOST_RE = re.compile(
    r"server\s*:\s*\{[^}]*\bhost\s*:\s*(?:true|['\"](?:0\.0\.0\.0|true)['\"])",
    re.MULTILINE | re.DOTALL,
)


def _vite_config_has_host_true() -> bool:
    """Return True iff ui/vite.config.ts sets server.host to a value that
    binds vite to all interfaces. False on any read/parse failure.

    Path is derived from PACKAGE_JSON_PATH at call time so that tests
    monkeypatching PACKAGE_JSON_PATH also redirect this lookup.
    """
    try:
        text = (PACKAGE_JSON_PATH.parent / "vite.config.ts").read_text()
    except OSError:
        return False
    return bool(_VITE_HOST_RE.search(text))


def _dev_script_has_host_flag() -> bool:
    """Return True iff ui/package.json's `dev` script passes --host."""
    try:
        pkg = json.loads(PACKAGE_JSON_PATH.read_text())
    except (json.JSONDecodeError, OSError):
        return False
    scripts = pkg.get("scripts") if isinstance(pkg, dict) else None
    dev_script = scripts.get("dev") if isinstance(scripts, dict) else None
    return isinstance(dev_script, str) and "--host" in dev_script


def _detect_vite_host_binding() -> dict[str, Any]:
    """Best-effort heuristic on whether vite binds to all interfaces.

    Two equivalent ways the user can opt in:
      1. `server: { host: true }` (or `'0.0.0.0'`) in ui/vite.config.ts
         — this repo's default.
      2. `--host` flag in ui/package.json's `dev` script.

    Either is sufficient. The vite.config.ts approach is preferred because
    it's the project default; the `--host` flag is a per-invocation override
    forks may use.
    """
    via_config = _vite_config_has_host_true()
    via_script = _dev_script_has_host_flag()
    if via_config or via_script:
        source = (
            "ui/vite.config.ts sets server.host"
            if via_config
            else "ui/package.json `dev` script includes --host"
        )
        return {
            "all_interfaces": True,
            "note": f"{source}; vite binds to all interfaces.",
        }
    return {
        "all_interfaces": False,
        "note": (
            "Neither ui/vite.config.ts (server.host) nor ui/package.json "
            "(`dev` script --host) opts vite into all-interfaces binding. "
            "Vite defaults to 127.0.0.1; remote devices will not reach it. "
            "Add `server: { host: true }` to vite.config.ts."
        ),
    }


def cmd_status() -> None:
    """Emit the combined remote-access status envelope.

    Each detector is isolated — an exception in one half never blocks the
    other half from reporting. The top-level `ok` flag is True as long as
    we successfully *ran* the detectors; whether the user has any of these
    set up is an answer the panel renders, not a top-level failure.
    """
    try:
        tailscale = _detect_tailscale()
    except Exception as e:
        tailscale = {"installed": False, "error": f"detector crashed: {type(e).__name__}: {e}"}
    try:
        cloudflare = _detect_cloudflare()
    except Exception as e:
        cloudflare = {"installed": False, "error": f"detector crashed: {type(e).__name__}: {e}"}
    try:
        host_binding = _detect_vite_host_binding()
    except Exception as e:
        host_binding = {
            "all_interfaces": False,
            "note": f"detector crashed: {type(e).__name__}: {e}",
        }

    _emit(
        {
            "ok": True,
            "tailscale": tailscale,
            "cloudflare": cloudflare,
            "vite_host_binding": host_binding,
        }
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd")
    sub.add_parser("status")
    args = parser.parse_args()
    if args.cmd == "status":
        cmd_status()
    parser.print_help()
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as e:
        _emit({"ok": False, "error": f"{type(e).__name__}: {e}"}, code=1)
