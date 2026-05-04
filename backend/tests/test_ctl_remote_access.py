"""Tests for backend/ctl/remote_access_ctl.py.

The script shells to two optional CLIs (`tailscale` and `cloudflared`) and
reports a per-CLI status block. We monkeypatch shutil.which + subprocess.run
to cover the four interesting paths:

  - both CLIs installed and returning healthy JSON
  - tailscale installed, cloudflared not installed (and vice-versa)
  - neither installed
  - tailscale installed but `tailscale status --json` times out

The detectors are wrapped in their own try/except — one CLI's absence or
crash must never break the other half of the response.

Same in-process pattern as test_ctl_preflight.py: import the module, swap
`_emit` for a capturing fake, and call cmd_status() directly so we can
inspect the envelope before the real sys.exit fires.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest


def _capture_emit(monkeypatch: pytest.MonkeyPatch) -> dict:
    """Replace `_emit` so it captures the payload instead of printing/exiting.

    Raises SystemExit so the caller can `pytest.raises(SystemExit)` and
    inspect captured["obj"] afterwards.
    """
    captured: dict = {}

    def _fake_emit(obj: dict, code: int = 0) -> None:
        captured.update({"obj": obj, "code": code})
        raise SystemExit(code)

    import remote_access_ctl

    monkeypatch.setattr(remote_access_ctl, "_emit", _fake_emit)
    return captured


class _FakeProc:
    """Minimal subprocess.CompletedProcess stand-in.

    We only set the three fields the script actually reads: returncode,
    stdout, stderr. Constructing the real CompletedProcess works too but
    requires passing args/returncode positionally and adds noise.
    """

    def __init__(self, returncode: int = 0, stdout: str = "", stderr: str = "") -> None:
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


# Sample tailscale output trimmed to the fields the detector reads. Real
# `tailscale status --json` returns ~30 top-level keys; we only need Self.
_TAILSCALE_JSON = json.dumps(
    {
        "Self": {
            "HostName": "eliran-mac",
            "DNSName": "eliran-mac.tail-scale.ts.net.",
            "TailscaleIPs": ["100.64.1.2", "fd7a:115c:a1e0::1"],
        }
    }
)

_CLOUDFLARE_JSON = json.dumps(
    [
        {
            "id": "abc-123",
            "name": "linkedin-jobs",
            "status": "healthy",
            "connections": [{"id": "x"}],
        }
    ]
)


def _make_run_dispatcher(responses: dict[str, _FakeProc | Exception]):
    """Build a fake subprocess.run that branches on the first arg's basename.

    `responses` maps a CLI name (e.g. "tailscale") to either a _FakeProc
    to return or an Exception class/instance to raise. Anything not in the
    map raises FileNotFoundError so a missing key surfaces obviously.
    """

    def _fake_run(cmd, *_args, **_kwargs):
        # cmd is a list whose first entry is the absolute path to the CLI
        # (whatever shutil.which returned in the real flow); the basename
        # is what we key the dispatcher on.
        from os.path import basename

        key = basename(cmd[0]) if cmd else ""
        if key not in responses:
            raise FileNotFoundError(f"unexpected subprocess.run call: {cmd!r}")
        result = responses[key]
        if isinstance(result, Exception):
            raise result
        return result

    return _fake_run


def test_status_happy_path_both_clis_installed(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Both CLIs on PATH, both return healthy JSON. The envelope surfaces
    Tailscale's URL/hostname/IP and the cloudflared tunnel list."""
    captured = _capture_emit(monkeypatch)
    import remote_access_ctl

    # Real package.json doesn't include --host today; pin a synthetic one
    # under tmp_path so this test is independent of any future package.json
    # rewrite by another agent.
    pkg = tmp_path / "package.json"
    pkg.write_text(json.dumps({"scripts": {"dev": "vite --host"}}))
    monkeypatch.setattr(remote_access_ctl, "PACKAGE_JSON_PATH", pkg)

    monkeypatch.setattr(
        remote_access_ctl.shutil,
        "which",
        lambda name: f"/usr/local/bin/{name}",
    )
    monkeypatch.setattr(
        remote_access_ctl.subprocess,
        "run",
        _make_run_dispatcher(
            {
                "tailscale": _FakeProc(stdout=_TAILSCALE_JSON),
                "cloudflared": _FakeProc(stdout=_CLOUDFLARE_JSON),
            }
        ),
    )

    with pytest.raises(SystemExit):
        remote_access_ctl.cmd_status()
    out = captured["obj"]
    assert out["ok"] is True

    ts = out["tailscale"]
    assert ts["installed"] is True
    assert ts["running"] is True
    assert ts["hostname"] == "eliran-mac.tail-scale.ts.net"  # trailing dot stripped
    assert ts["ipv4"] == "100.64.1.2"  # ipv6 entry skipped
    assert ts["url"] == "http://eliran-mac.tail-scale.ts.net:5173"

    cf = out["cloudflare"]
    assert cf["installed"] is True
    assert cf["tunnels"] == [{"name": "linkedin-jobs", "status": "HEALTHY"}]

    assert out["vite_host_binding"]["all_interfaces"] is True


def test_status_only_tailscale_installed(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Tailscale present, cloudflared missing. Cloudflare half degrades to
    `installed: False` without breaking the tailscale half."""
    captured = _capture_emit(monkeypatch)
    import remote_access_ctl

    monkeypatch.setattr(remote_access_ctl, "PACKAGE_JSON_PATH", tmp_path / "missing.json")

    def _which(name: str) -> str | None:
        return "/usr/local/bin/tailscale" if name == "tailscale" else None

    monkeypatch.setattr(remote_access_ctl.shutil, "which", _which)
    monkeypatch.setattr(
        remote_access_ctl.subprocess,
        "run",
        _make_run_dispatcher({"tailscale": _FakeProc(stdout=_TAILSCALE_JSON)}),
    )

    with pytest.raises(SystemExit):
        remote_access_ctl.cmd_status()
    out = captured["obj"]
    assert out["tailscale"]["installed"] is True
    assert out["tailscale"]["running"] is True
    assert out["cloudflare"] == {"installed": False}
    # missing package.json → all_interfaces:false with a note
    assert out["vite_host_binding"]["all_interfaces"] is False
    assert "note" in out["vite_host_binding"]


def test_status_neither_cli_installed(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Both CLIs missing. Top-level ok still True — the panel renders the
    "Not installed" badges. Subprocess.run must NOT be called."""
    captured = _capture_emit(monkeypatch)
    import remote_access_ctl

    monkeypatch.setattr(remote_access_ctl, "PACKAGE_JSON_PATH", tmp_path / "missing.json")
    monkeypatch.setattr(remote_access_ctl.shutil, "which", lambda _name: None)

    def _no_subprocess(*_a, **_kw):
        raise AssertionError("subprocess.run should not be called when neither CLI exists")

    monkeypatch.setattr(remote_access_ctl.subprocess, "run", _no_subprocess)

    with pytest.raises(SystemExit):
        remote_access_ctl.cmd_status()
    out = captured["obj"]
    assert out["ok"] is True
    assert out["tailscale"] == {"installed": False}
    assert out["cloudflare"] == {"installed": False}


def test_status_tailscale_timeout_does_not_break_cloudflare(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """`tailscale status --json` hangs and gets killed by the 5s timeout.
    Tailscale half reports `running: False` + an `error`; cloudflared still
    runs and returns its tunnel list."""
    captured = _capture_emit(monkeypatch)
    import remote_access_ctl

    monkeypatch.setattr(remote_access_ctl, "PACKAGE_JSON_PATH", tmp_path / "missing.json")
    monkeypatch.setattr(
        remote_access_ctl.shutil,
        "which",
        lambda name: f"/usr/local/bin/{name}",
    )
    monkeypatch.setattr(
        remote_access_ctl.subprocess,
        "run",
        _make_run_dispatcher(
            {
                "tailscale": subprocess.TimeoutExpired(cmd="tailscale", timeout=5),
                "cloudflared": _FakeProc(stdout=_CLOUDFLARE_JSON),
            }
        ),
    )

    with pytest.raises(SystemExit):
        remote_access_ctl.cmd_status()
    out = captured["obj"]
    assert out["tailscale"]["installed"] is True
    assert out["tailscale"]["running"] is False
    assert "timed out" in out["tailscale"]["error"]
    # cloudflare half still reports the healthy tunnel
    assert out["cloudflare"]["installed"] is True
    assert out["cloudflare"]["tunnels"] == [{"name": "linkedin-jobs", "status": "HEALTHY"}]


def test_status_cloudflared_not_logged_in(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """cloudflared installed but `tunnel list` returns non-zero (typical
    when cert.pem is missing). The detector surfaces the stderr line so the
    panel can show "log in via `cloudflared tunnel login`" without us
    hardcoding that copy."""
    captured = _capture_emit(monkeypatch)
    import remote_access_ctl

    monkeypatch.setattr(remote_access_ctl, "PACKAGE_JSON_PATH", tmp_path / "missing.json")

    def _which(name: str) -> str | None:
        return "/usr/local/bin/cloudflared" if name == "cloudflared" else None

    monkeypatch.setattr(remote_access_ctl.shutil, "which", _which)
    monkeypatch.setattr(
        remote_access_ctl.subprocess,
        "run",
        _make_run_dispatcher(
            {
                "cloudflared": _FakeProc(
                    returncode=1,
                    stdout="",
                    stderr="please log in first via `cloudflared tunnel login`\n",
                )
            }
        ),
    )

    with pytest.raises(SystemExit):
        remote_access_ctl.cmd_status()
    out = captured["obj"]
    assert out["cloudflare"]["installed"] is True
    assert out["cloudflare"]["tunnels"] == []
    assert "log in" in out["cloudflare"]["error"]
