"""Python SDK for AutoMobile: daemon lifecycle, diagnostics and bound MCP sessions."""

from ._version import __version__
from .client import AutoMobile
from .daemon import (
    CommandResult,
    CommandRunner,
    DaemonManager,
    DaemonStatus,
    DoctorCheck,
    DoctorReport,
    SubprocessRunner,
)
from .errors import (
    AutoMobileError,
    DaemonAuthenticationError,
    DaemonCommandError,
    DaemonUnavailableError,
    McpError,
    ProtocolError,
    SessionBindingError,
    ToolCallError,
)
from .http import HttpResponse, HttpTransport, LoopbackHttpTransport
from .session import McpSession, ResourceContents, Tool, ToolResult
from .token import FileTokenProvider, TokenProvider, UnsafeTokenFileError

__all__ = [
    "AutoMobile",
    "AutoMobileError",
    "CommandResult",
    "CommandRunner",
    "DaemonAuthenticationError",
    "DaemonCommandError",
    "DaemonManager",
    "DaemonStatus",
    "DaemonUnavailableError",
    "DoctorCheck",
    "DoctorReport",
    "FileTokenProvider",
    "HttpResponse",
    "HttpTransport",
    "LoopbackHttpTransport",
    "McpError",
    "McpSession",
    "ProtocolError",
    "ResourceContents",
    "SessionBindingError",
    "SubprocessRunner",
    "TokenProvider",
    "Tool",
    "ToolCallError",
    "ToolResult",
    "UnsafeTokenFileError",
    "__version__",
]
