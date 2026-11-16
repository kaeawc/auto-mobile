"""Daemon lifecycle: ``status``, ``ensure_running``, ``restart``, ``shutdown`` and ``doctor``.

Each runs the documented ``auto-mobile`` CLI rather than reimplementing PID-generation
checks, start locking or socket identity recovery: ``--daemon status --json`` prints the
daemon's status object, ``--daemon start`` / ``restart`` / ``stop`` start, replace and stop
the daemon for the caller's environment, and ``--cli doctor --json`` prints the
read-only diagnostic report.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from .errors import DaemonCommandError, DaemonUnavailableError

DEFAULT_EXECUTABLE: tuple[str, ...] = ("auto-mobile",)
DEFAULT_STATUS_TIMEOUT_S = 30.0
DEFAULT_START_TIMEOUT_S = 90.0
DEFAULT_SHUTDOWN_TIMEOUT_S = 30.0
DEFAULT_DOCTOR_TIMEOUT_S = 120.0
_STATUS_POLL_INTERVAL_S = 0.5
_STDERR_TAIL_CHARS = 2000


@dataclass(frozen=True)
class CommandResult:
    exit_code: int
    stdout: str
    stderr: str


class CommandRunner(Protocol):
    """Runs one command to completion. Tests substitute a fake."""

    async def run(
        self,
        argv: Sequence[str],
        *,
        env: Mapping[str, str],
        cwd: str | None,
        timeout: float,
    ) -> CommandResult: ...


class SubprocessRunner:
    """Runs a command with :mod:`asyncio` subprocesses; kills and reaps it on timeout or cancel."""

    async def run(
        self,
        argv: Sequence[str],
        *,
        env: Mapping[str, str],
        cwd: str | None,
        timeout: float,
    ) -> CommandResult:
        try:
            process = await asyncio.create_subprocess_exec(
                *argv,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=dict(env),
                cwd=cwd,
            )
        except FileNotFoundError as error:
            raise DaemonCommandError(
                f"AutoMobile executable not found: {argv[0]!r}. Install it "
                "(npm install -g @kaeawc/auto-mobile) or pass executable=...",
                command=" ".join(argv[1:]),
            ) from error
        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout)
        except BaseException:
            # Timeout or caller cancellation: never leave the child running or unreaped.
            if process.returncode is None:
                process.kill()
            await process.wait()
            raise
        return CommandResult(
            exit_code=process.returncode if process.returncode is not None else -1,
            stdout=stdout.decode("utf-8", errors="replace"),
            stderr=stderr.decode("utf-8", errors="replace"),
        )


@dataclass(frozen=True)
class DaemonStatus:
    """The daemon's status object (``auto-mobile --daemon status --json``)."""

    running: bool
    pid: int | None = None
    port: int | None = None
    socket_path: str | None = None
    version: str | None = None
    started_at: int | None = None
    recovery: Mapping[str, Any] | None = None
    raw: Mapping[str, Any] = field(default_factory=dict)

    @property
    def healthy(self) -> bool:
        """False when the daemon is down because its identity could not be recovered."""
        return self.running or self.recovery is None

    @classmethod
    def from_json(cls, data: Mapping[str, Any]) -> DaemonStatus:
        def opt_int(key: str) -> int | None:
            value = data.get(key)
            return value if isinstance(value, int) and not isinstance(value, bool) else None

        def opt_str(key: str) -> str | None:
            value = data.get(key)
            return value if isinstance(value, str) else None

        recovery = data.get("recovery")
        return cls(
            running=data.get("running") is True,
            pid=opt_int("pid"),
            port=opt_int("port"),
            socket_path=opt_str("socketPath"),
            version=opt_str("version"),
            started_at=opt_int("startedAt"),
            recovery=recovery if isinstance(recovery, dict) else None,
            raw=dict(data),
        )


def _last_json_object(stdout: str) -> Mapping[str, Any] | None:
    """The status object: the last stdout line that parses as a JSON object."""
    for line in reversed(stdout.splitlines()):
        stripped = line.strip()
        if not stripped.startswith("{"):
            continue
        try:
            parsed = json.loads(stripped)
        except ValueError:
            continue
        if isinstance(parsed, dict):
            return parsed
    return None


@dataclass(frozen=True)
class DoctorCheck:
    """One diagnostic check: ``status`` is ``pass``, ``warn``, ``fail`` or ``skip``."""

    name: str
    status: str
    message: str
    value: str | int | float | bool | None = None
    detail: str | None = None
    recommendation: str | None = None

    @classmethod
    def from_json(cls, data: Mapping[str, Any]) -> DoctorCheck:
        value = data.get("value")
        return cls(
            name=str(data.get("name", "")),
            status=str(data.get("status", "")),
            message=str(data.get("message", "")),
            value=value if isinstance(value, (str, int, float, bool)) else None,
            detail=_opt_str(data, "detail"),
            recommendation=_opt_str(data, "recommendation"),
        )


@dataclass(frozen=True)
class DoctorReport:
    """The report printed by ``auto-mobile --cli doctor --json``.

    ``sections`` maps a section name (``system``, ``android``, ``ios``, ``autoMobile``) to
    its checks; a platform the host cannot run, or one filtered out, is absent.
    """

    version: str | None
    platform: str | None
    arch: str | None
    timestamp: str | None
    sections: Mapping[str, tuple[DoctorCheck, ...]]
    passed: int
    warnings: int
    failed: int
    skipped: int
    recommendations: tuple[str, ...]
    raw: Mapping[str, Any] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        """True when no check failed (warnings and skips do not count)."""
        return self.failed == 0

    @property
    def checks(self) -> tuple[DoctorCheck, ...]:
        """Every check, in section order."""
        return tuple(check for checks in self.sections.values() for check in checks)

    @classmethod
    def from_json(cls, data: Mapping[str, Any]) -> DoctorReport:
        sections: dict[str, tuple[DoctorCheck, ...]] = {}
        for name in ("system", "android", "ios", "autoMobile"):
            section = data.get(name)
            checks = section.get("checks") if isinstance(section, dict) else None
            if isinstance(checks, list):
                sections[name] = tuple(
                    DoctorCheck.from_json(check) for check in checks if isinstance(check, dict)
                )
        summary = data.get("summary")
        counts = summary if isinstance(summary, dict) else {}

        def count(key: str) -> int:
            value = counts.get(key)
            return value if isinstance(value, int) and not isinstance(value, bool) else 0

        recommendations = data.get("recommendations")
        return cls(
            version=_opt_str(data, "version"),
            platform=_opt_str(data, "platform"),
            arch=_opt_str(data, "arch"),
            timestamp=_opt_str(data, "timestamp"),
            sections=sections,
            passed=count("passed"),
            warnings=count("warnings"),
            failed=count("failed"),
            skipped=count("skipped"),
            recommendations=tuple(item for item in recommendations or () if isinstance(item, str))
            if isinstance(recommendations, list)
            else (),
            raw=dict(data),
        )


def _opt_str(data: Mapping[str, Any], key: str) -> str | None:
    value = data.get(key)
    return value if isinstance(value, str) else None


def _json_document(stdout: str) -> Mapping[str, Any] | None:
    """A pretty-printed JSON object on stdout, starting at the first line that opens one."""
    lines = stdout.splitlines()
    for index, line in enumerate(lines):
        if not line.startswith("{"):
            continue
        try:
            parsed = json.loads("\n".join(lines[index:]))
        except ValueError:
            continue
        if isinstance(parsed, dict):
            return parsed
    return None


def _spilled_document(envelope: Mapping[str, Any]) -> Mapping[str, Any] | None:
    """The full result an oversized CLI output was spilled to (``artifact.path``)."""
    artifact = envelope.get("artifact")
    path = artifact.get("path") if isinstance(artifact, dict) else None
    if envelope.get("truncated") is not False or not isinstance(path, str):
        return None
    try:
        parsed = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise DaemonCommandError(
            f"auto-mobile --cli doctor spilled its report to {path!r}, which could not be "
            f"read: {error}",
            command="doctor --json",
        ) from error
    return parsed if isinstance(parsed, dict) else None


def _tail(text: str) -> str:
    return text[-_STDERR_TAIL_CHARS:].strip()


class DaemonManager:
    """Queries and starts the AutoMobile daemon for one launch environment."""

    def __init__(
        self,
        *,
        executable: Sequence[str] = DEFAULT_EXECUTABLE,
        env: Mapping[str, str],
        cwd: str | None = None,
        runner: CommandRunner | None = None,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if not executable:
            raise ValueError("executable must name at least one argv element")
        self._executable = tuple(executable)
        self._env = env
        self._cwd = cwd
        self._runner: CommandRunner = runner or SubprocessRunner()
        self._sleep = sleep
        self._clock = clock

    async def _run(
        self, args: Sequence[str], timeout: float, *, mode: str = "--daemon"
    ) -> CommandResult:
        argv = [*self._executable, mode, *args]
        try:
            return await self._runner.run(argv, env=self._env, cwd=self._cwd, timeout=timeout)
        except (asyncio.TimeoutError, TimeoutError) as error:
            raise DaemonCommandError(
                f"auto-mobile {mode} {' '.join(args)} did not finish within {timeout:g}s",
                command=" ".join(args),
            ) from error

    async def _run_ok(self, args: Sequence[str], timeout: float) -> None:
        """Run a ``--daemon`` lifecycle command; raise unless it exits 0."""
        result = await self._run(args, timeout)
        if result.exit_code != 0:
            raise DaemonCommandError(
                f"auto-mobile --daemon {' '.join(args)} failed (exit {result.exit_code}): "
                f"{_tail(result.stderr) or _tail(result.stdout) or 'no output'}",
                command=" ".join(args),
                exit_code=result.exit_code,
                stderr_tail=_tail(result.stderr),
            )

    async def status(self, *, timeout: float = DEFAULT_STATUS_TIMEOUT_S) -> DaemonStatus:
        """The daemon's current status. Raises :class:`DaemonCommandError` if it cannot be read."""
        result = await self._run(["status", "--json"], timeout)
        data = _last_json_object(result.stdout)
        if data is None:
            raise DaemonCommandError(
                f"auto-mobile --daemon status --json printed no status object "
                f"(exit {result.exit_code}): {_tail(result.stderr) or 'no stderr'}",
                command="status --json",
                exit_code=result.exit_code,
                stderr_tail=_tail(result.stderr),
            )
        return DaemonStatus.from_json(data)

    async def ensure_running(self, *, timeout: float = DEFAULT_START_TIMEOUT_S) -> DaemonStatus:
        """Return a running daemon's status, starting the daemon first when it is not running.

        The whole operation, including the start command and readiness polling, is bounded
        by ``timeout`` seconds.
        """
        deadline = self._clock() + timeout
        current = await self.status(timeout=self._remaining(deadline))
        if current.running and current.port is not None:
            return current
        await self._run_ok(["start"], self._remaining(deadline))
        return await self._await_running(deadline, timeout, "start")

    async def restart(self, *, timeout: float = DEFAULT_START_TIMEOUT_S) -> DaemonStatus:
        """Replace the daemon (or start one when none runs); return the new daemon's status.

        The whole operation, including the restart command and readiness polling, is
        bounded by ``timeout`` seconds.
        """
        deadline = self._clock() + timeout
        await self._run_ok(["restart"], self._remaining(deadline))
        return await self._await_running(deadline, timeout, "restart")

    async def shutdown(self, *, timeout: float = DEFAULT_SHUTDOWN_TIMEOUT_S) -> DaemonStatus:
        """Stop the daemon; return the status read afterwards (``running`` is False).

        Stopping a daemon that is not running succeeds. Raises
        :class:`DaemonUnavailableError` if the daemon still reports running afterwards.
        """
        deadline = self._clock() + timeout
        await self._run_ok(["stop"], self._remaining(deadline))
        current = await self.status(timeout=self._remaining(deadline))
        if current.running:
            raise DaemonUnavailableError(
                f"AutoMobile daemon (pid {current.pid}) still reports running after stop"
            )
        return current

    async def doctor(
        self,
        *,
        android: bool = False,
        ios: bool = False,
        timeout: float = DEFAULT_DOCTOR_TIMEOUT_S,
    ) -> DoctorReport:
        """Run the read-only ``doctor`` diagnostics; ``android`` / ``ios`` filter the checks.

        A report with failed checks is returned, not raised: read :attr:`DoctorReport.ok`.
        """
        args = ["doctor", "--json"]
        if android:
            args.append("--android")
        if ios:
            args.append("--ios")
        result = await self._run(args, timeout, mode="--cli")
        data = _json_document(result.stdout)
        if data is not None and "summary" not in data:
            data = _spilled_document(data)
        if data is None:
            raise DaemonCommandError(
                f"auto-mobile --cli doctor --json printed no report "
                f"(exit {result.exit_code}): {_tail(result.stderr) or 'no stderr'}",
                command="doctor --json",
                exit_code=result.exit_code,
                stderr_tail=_tail(result.stderr),
            )
        return DoctorReport.from_json(data)

    async def _await_running(self, deadline: float, timeout: float, action: str) -> DaemonStatus:
        while True:
            current = await self.status(timeout=self._remaining(deadline))
            if current.running and current.port is not None:
                return current
            if self._clock() + _STATUS_POLL_INTERVAL_S >= deadline:
                raise DaemonUnavailableError(
                    f"AutoMobile daemon did not report running within {timeout:g}s after {action}"
                )
            await self._sleep(_STATUS_POLL_INTERVAL_S)

    def _remaining(self, deadline: float) -> float:
        remaining = deadline - self._clock()
        if remaining <= 0:
            raise DaemonUnavailableError("Deadline expired before the daemon became available")
        return remaining


def launch_environment(overrides: Mapping[str, str] | None) -> dict[str, str]:
    """The daemon launch environment: this process's environment plus explicit overrides."""
    merged = dict(os.environ)
    if overrides:
        merged.update(overrides)
    return merged
