"""Daemon lifecycle: ``status`` and ``ensure_running``.

Both run the documented ``auto-mobile --daemon <command>`` CLI rather than
reimplementing PID-generation checks, start locking or socket identity recovery:
``--daemon status --json`` prints the daemon's status object, and ``--daemon start``
starts (or joins) the daemon for the caller's environment.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol

from .errors import DaemonCommandError, DaemonUnavailableError

DEFAULT_EXECUTABLE: tuple[str, ...] = ("auto-mobile",)
DEFAULT_STATUS_TIMEOUT_S = 30.0
DEFAULT_START_TIMEOUT_S = 90.0
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

    async def _run(self, args: Sequence[str], timeout: float) -> CommandResult:
        argv = [*self._executable, "--daemon", *args]
        try:
            return await self._runner.run(argv, env=self._env, cwd=self._cwd, timeout=timeout)
        except (asyncio.TimeoutError, TimeoutError) as error:
            raise DaemonCommandError(
                f"auto-mobile --daemon {' '.join(args)} did not finish within {timeout:g}s",
                command=" ".join(args),
            ) from error

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
        result = await self._run(["start"], self._remaining(deadline))
        if result.exit_code != 0:
            raise DaemonCommandError(
                f"auto-mobile --daemon start failed (exit {result.exit_code}): "
                f"{_tail(result.stderr) or _tail(result.stdout) or 'no output'}",
                command="start",
                exit_code=result.exit_code,
                stderr_tail=_tail(result.stderr),
            )
        while True:
            current = await self.status(timeout=self._remaining(deadline))
            if current.running and current.port is not None:
                return current
            if self._clock() + _STATUS_POLL_INTERVAL_S >= deadline:
                raise DaemonUnavailableError(
                    f"AutoMobile daemon did not report running within {timeout:g}s after start"
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
