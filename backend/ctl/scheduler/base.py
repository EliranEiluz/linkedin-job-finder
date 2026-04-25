"""Scheduler ABC + status dataclass shared by all OS backends."""
from __future__ import annotations

import abc
from dataclasses import dataclass, field


@dataclass
class SchedulerStatus:
    """Snapshot of the scheduler's state. Returned by `Scheduler.status()`
    in a future revision; today the CLI in `scheduler_ctl.py` builds the
    status JSON itself by combining backend methods + state-file reads."""
    installed: bool
    loaded: bool
    interval_seconds: int | None
    interval_label: str | None
    mode: str | None
    last_run: str | None
    next_run_estimate: str | None
    log_tail: str
    backend: str
    native_id: str
    last_exit_status: int | None
    errors: list[str] = field(default_factory=list)


class Scheduler(abc.ABC):
    """OS-specific scheduler backend. Concrete subclasses translate the
    abstract operations (install/uninstall/reload/etc.) into the host's
    native scheduler primitives — launchd, systemd-user, schtasks."""

    LABEL: str = "com.linkedinjobs"

    @property
    @abc.abstractmethod
    def backend_name(self) -> str:
        """Short identifier for telemetry/UI display
        (e.g. "launchd", "systemd-user", "schtasks")."""

    @property
    @abc.abstractmethod
    def native_id(self) -> str:
        """OS-native artifact identifier — plist path / unit name / task name.
        Surfaced in the status JSON so the UI can show "launchd plist at X"
        without TypeScript branching per OS."""

    @abc.abstractmethod
    def install(self, interval_seconds: int, mode: str, run_command: list[str]) -> None:
        """Idempotent register. Replaces any prior registration under LABEL.
        `run_command` is what the scheduler actually invokes — typically
        `["/path/to/run.sh"]` (Stage 1-3) or `[python, "/path/to/run.py"]`
        (Stage 4+). Backends are agnostic to the command structure."""

    @abc.abstractmethod
    def uninstall(self) -> None:
        """Remove all registration. Idempotent — succeeds if nothing was
        installed."""

    @abc.abstractmethod
    def reload(self, interval_seconds: int, mode: str, run_command: list[str]) -> None:
        """Atomic unload + re-register with new params. Raises if the
        scheduler isn't currently installed."""

    @abc.abstractmethod
    def is_installed(self) -> bool:
        """True if the scheduler artifact (plist/unit/task) exists, even if
        not currently active/loaded."""

    @abc.abstractmethod
    def is_loaded(self) -> bool:
        """True if the scheduler is registered AND active (loaded into
        launchctl, enabled timer, scheduled task)."""

    @abc.abstractmethod
    def last_exit_status(self) -> int | None:
        """Last completed run's exit code, or None if not available."""

    @abc.abstractmethod
    def installed_state(self) -> tuple[int | None, str | None]:
        """Best-effort read of (interval_seconds, mode) FROM the live install.
        The CLI uses this to verify what's actually scheduled vs what
        scheduler_state.json claims. Returns (None, None) if not installed."""
