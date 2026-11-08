"""The top-level :class:`AutoMobile` client."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence

from .daemon import (
    DEFAULT_EXECUTABLE,
    DEFAULT_START_TIMEOUT_S,
    DEFAULT_STATUS_TIMEOUT_S,
    CommandRunner,
    DaemonManager,
    DaemonStatus,
    launch_environment,
)
from .errors import DaemonUnavailableError
from .http import HttpTransport
from .session import McpSession
from .token import FileTokenProvider, TokenProvider


class AutoMobile:
    """Entry point: daemon ``status`` / ``ensure_running`` and bound MCP sessions.

    ``env`` entries are layered over this process's environment and form the daemon
    launch environment: the same variables (``AUTOMOBILE_AUX_SOCKET_DIR``,
    ``AUTOMOBILE_DAEMON_*_PATH``) select which daemon is queried, started and reached.
    """

    def __init__(
        self,
        *,
        executable: Sequence[str] = DEFAULT_EXECUTABLE,
        env: Mapping[str, str] | None = None,
        cwd: str | None = None,
        runner: CommandRunner | None = None,
        transport: HttpTransport | None = None,
        token_provider: TokenProvider | None = None,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._env = launch_environment(env)
        self._daemon = DaemonManager(
            executable=executable,
            env=self._env,
            cwd=cwd,
            runner=runner,
            sleep=sleep,
            clock=clock,
        )
        self._transport = transport
        self._token_provider = token_provider or FileTokenProvider(self._env, cwd)
        self._sleep = sleep
        self._clock = clock

    async def status(self, *, timeout: float = DEFAULT_STATUS_TIMEOUT_S) -> DaemonStatus:
        """The daemon's status; ``running`` is False when no daemon is up."""
        return await self._daemon.status(timeout=timeout)

    async def ensure_running(self, *, timeout: float = DEFAULT_START_TIMEOUT_S) -> DaemonStatus:
        """Start the daemon unless it is already running; return its status."""
        return await self._daemon.ensure_running(timeout=timeout)

    def session(self, *, session_id: str | None = None, device_id: str | None = None) -> McpSession:
        """A new MCP session bound to ``session_id`` (a fresh UUID by default).

        Use it as ``async with client.session() as session:``. The daemon must already
        be running (see :meth:`ensure_running`); its HTTP port is read from ``status``.
        """
        return McpSession(
            port_resolver=self._running_port,
            token_provider=self._token_provider,
            transport=self._transport,
            session_id=session_id,
            device_id=device_id,
            sleep=self._sleep,
            clock=self._clock,
        )

    async def _running_port(self) -> int:
        status = await self.status()
        if not status.running or status.port is None:
            raise DaemonUnavailableError(
                "The AutoMobile daemon is not running; call ensure_running() first"
            )
        return status.port
