"""Typed exceptions raised by the AutoMobile SDK.

Every exception derives from :class:`AutoMobileError`. Messages never contain the
daemon HTTP token or an ``Authorization`` header.
"""

from __future__ import annotations

from typing import Any


class AutoMobileError(Exception):
    """Base class for every error the SDK raises."""


class DaemonCommandError(AutoMobileError):
    """An ``auto-mobile --daemon <command>`` invocation failed or printed no usable result."""

    def __init__(
        self,
        message: str,
        *,
        command: str,
        exit_code: int | None = None,
        stderr_tail: str = "",
    ) -> None:
        super().__init__(message)
        self.command = command
        self.exit_code = exit_code
        self.stderr_tail = stderr_tail


class DaemonUnavailableError(AutoMobileError):
    """The daemon is not running, not reachable, or still starting past the caller's deadline."""


class DaemonAuthenticationError(AutoMobileError):
    """The daemon refused the HTTP bearer token, even after the token file was re-read."""


class ProtocolError(AutoMobileError):
    """The daemon answered with something that is not a valid MCP / JSON-RPC reply."""


class McpError(AutoMobileError):
    """A JSON-RPC error returned by the daemon's MCP endpoint."""

    def __init__(self, code: int, message: str, data: Any = None) -> None:
        super().__init__(f"MCP error {code}: {message}")
        self.code = code
        self.rpc_message = message
        self.data = data


class ToolCallError(AutoMobileError):
    """A tool ran and reported failure (``isError: true``).

    Raised by :meth:`ToolResult.raise_for_error`.
    """

    def __init__(self, tool: str, text: str) -> None:
        super().__init__(f"Tool {tool!r} failed: {text}" if text else f"Tool {tool!r} failed")
        self.tool = tool
        self.text = text


class SessionBindingError(AutoMobileError):
    """A call conflicts with the session's binding (closed session, or another device)."""
