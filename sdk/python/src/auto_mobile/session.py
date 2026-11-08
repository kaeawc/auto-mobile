"""A bound MCP session over the daemon's HTTP endpoint (``/auto-mobile/streamable``).

The endpoint is stateless: every POST is served on its own, and the only thing that
links one request to the next is the ``x-auto-mobile-mcp-session-id`` header. A
session therefore picks its key once (a caller-supplied id or a fresh UUID) and sends
it, unchanged, on every request. Each request carries ``Authorization: Bearer <token>``
read from the daemon's token file.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import itertools
import json
import time
import uuid
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from types import TracebackType
from typing import Any

from ._version import __version__
from .errors import (
    DaemonAuthenticationError,
    DaemonUnavailableError,
    McpError,
    ProtocolError,
    SessionBindingError,
    ToolCallError,
)
from .http import HttpResponse, HttpTransport, LoopbackHttpTransport, parse_sse_messages
from .token import TokenProvider

MCP_STREAMABLE_PATH = "/auto-mobile/streamable"
MCP_SESSION_KEY_HEADER = "x-auto-mobile-mcp-session-id"
PROTOCOL_VERSION = "2025-11-25"
SUPPORTED_PROTOCOL_VERSIONS = frozenset({"2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"})
CLIENT_NAME = "auto-mobile-python-sdk"
DEVICE_ID_ARGUMENT = "deviceId"

# How long a request keeps retrying "503 + Retry-After" (daemon still starting) when the
# caller set no timeout. The daemon itself holds such a request up to 30 s first.
DEFAULT_STARTUP_RETRY_BUDGET_S = 60.0
_ERROR_EXCERPT_CHARS = 200


@dataclass(frozen=True)
class Tool:
    name: str
    description: str | None
    input_schema: Mapping[str, Any]
    annotations: Mapping[str, Any] | None = None
    meta: Mapping[str, Any] | None = None
    raw: Mapping[str, Any] = field(default_factory=dict)

    def accepts_argument(self, name: str) -> bool:
        properties = self.input_schema.get("properties")
        return isinstance(properties, dict) and name in properties


@dataclass(frozen=True)
class ToolResult:
    tool: str
    content: list[Mapping[str, Any]]
    structured_content: Any = None
    is_error: bool = False
    meta: Mapping[str, Any] | None = None

    @property
    def text(self) -> str:
        """All ``text`` content blocks joined by newlines."""
        return "\n".join(
            str(block.get("text", "")) for block in self.content if block.get("type") == "text"
        )

    def raise_for_error(self) -> ToolResult:
        """Raise :class:`ToolCallError` when the tool reported failure; otherwise return self."""
        if self.is_error:
            raise ToolCallError(self.tool, self.text)
        return self


@dataclass(frozen=True)
class ResourceContents:
    uri: str
    mime_type: str | None
    text: str | None = None
    blob: bytes | None = None
    meta: Mapping[str, Any] | None = None


PortResolver = Callable[[], Awaitable[int]]


class McpSession:
    """One AutoMobile MCP session, bound once to a session key and optionally a device."""

    def __init__(
        self,
        *,
        port_resolver: PortResolver,
        token_provider: TokenProvider,
        transport: HttpTransport | None = None,
        session_id: str | None = None,
        device_id: str | None = None,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        clock: Callable[[], float] = time.monotonic,
        startup_retry_budget_s: float = DEFAULT_STARTUP_RETRY_BUDGET_S,
    ) -> None:
        if session_id is not None and not session_id.strip():
            raise ValueError("session_id must not be blank")
        if device_id is not None and not device_id.strip():
            raise ValueError("device_id must not be blank")
        self._session_id = session_id or str(uuid.uuid4())
        self._device_id = device_id
        self._port_resolver = port_resolver
        self._token_provider = token_provider
        self._transport: HttpTransport = transport or LoopbackHttpTransport()
        self._sleep = sleep
        self._clock = clock
        self._startup_retry_budget_s = startup_retry_budget_s
        self._ids = itertools.count(1)
        self._port: int | None = None
        self._protocol_version: str | None = None
        self._server_info: Mapping[str, Any] | None = None
        self._init_lock = asyncio.Lock()
        self._tools: dict[str, Tool] | None = None
        self._closed = False

    @property
    def session_id(self) -> str:
        """The session key sent in ``x-auto-mobile-mcp-session-id``; fixed for the session."""
        return self._session_id

    @property
    def device_id(self) -> str | None:
        """The device this session is bound to, if any."""
        return self._device_id

    @property
    def protocol_version(self) -> str | None:
        return self._protocol_version

    @property
    def server_info(self) -> Mapping[str, Any] | None:
        return self._server_info

    @property
    def closed(self) -> bool:
        return self._closed

    async def __aenter__(self) -> McpSession:
        await self.initialize()
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        await self.close()

    async def close(self) -> None:
        """Close the session. Idempotent; later calls raise :class:`SessionBindingError`.

        The daemon endpoint holds no transport session, so nothing is sent. A device the
        session acquired is released by the daemon's normal idle and ownership rules.
        """
        self._closed = True

    async def initialize(self) -> None:
        """Run the MCP ``initialize`` handshake once. Called implicitly by every operation."""
        self._ensure_open()
        async with self._init_lock:
            if self._protocol_version is not None:
                return
            result = await self._request(
                "initialize",
                {
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": {"name": CLIENT_NAME, "version": __version__},
                },
                timeout=None,
                protocol_header=False,
            )
            version = result.get("protocolVersion")
            if not isinstance(version, str):
                raise ProtocolError("initialize result has no protocolVersion")
            if version not in SUPPORTED_PROTOCOL_VERSIONS:
                raise ProtocolError(
                    f"Daemon negotiated MCP protocol {version!r}; this SDK supports "
                    f"{sorted(SUPPORTED_PROTOCOL_VERSIONS)}. Update the SDK or the daemon."
                )
            info = result.get("serverInfo")
            self._server_info = info if isinstance(info, dict) else None
            self._protocol_version = version
            await self._notify("notifications/initialized")

    async def list_tools(self, *, timeout: float | None = None) -> list[Tool]:
        """Every tool the daemon offers this session, following pagination."""
        await self.initialize()
        tools: list[Tool] = []
        cursor: str | None = None
        while True:
            params: dict[str, Any] = {"cursor": cursor} if cursor else {}
            result = await self._request("tools/list", params, timeout=timeout)
            raw_tools = result.get("tools")
            if not isinstance(raw_tools, list):
                raise ProtocolError("tools/list result has no tools array")
            tools.extend(_parse_tool(item) for item in raw_tools)
            next_cursor = result.get("nextCursor")
            if not isinstance(next_cursor, str) or not next_cursor:
                break
            cursor = next_cursor
        self._tools = {tool.name: tool for tool in tools}
        return tools

    async def call_tool(
        self,
        name: str,
        arguments: Mapping[str, Any] | None = None,
        *,
        timeout: float | None = None,
    ) -> ToolResult:
        """Call any tool by name.

        With a bound device, ``deviceId`` is added for tools whose input schema declares
        it, and a call naming a different ``deviceId`` is refused before it is sent. A tool
        that runs and fails returns ``is_error=True``; protocol failures raise.
        """
        await self.initialize()
        args = dict(arguments or {})
        if self._device_id is not None:
            given = args.get(DEVICE_ID_ARGUMENT)
            if given is not None and given != self._device_id:
                raise SessionBindingError(
                    f"Session is bound to device {self._device_id!r}; refusing a call to "
                    f"{name!r} for device {given!r}. Open another session for that device."
                )
            if given is None and await self._tool_accepts(name, DEVICE_ID_ARGUMENT, timeout):
                args[DEVICE_ID_ARGUMENT] = self._device_id
        result = await self._request(
            "tools/call", {"name": name, "arguments": args}, timeout=timeout
        )
        content = result.get("content")
        if not isinstance(content, list):
            raise ProtocolError(f"tools/call result for {name!r} has no content array")
        meta = result.get("_meta")
        return ToolResult(
            tool=name,
            content=[block for block in content if isinstance(block, dict)],
            structured_content=result.get("structuredContent"),
            is_error=result.get("isError") is True,
            meta=meta if isinstance(meta, dict) else None,
        )

    async def read_resource(
        self, uri: str, *, timeout: float | None = None
    ) -> list[ResourceContents]:
        """Read one resource; ``blob`` contents are base64-decoded to bytes."""
        await self.initialize()
        result = await self._request("resources/read", {"uri": uri}, timeout=timeout)
        contents = result.get("contents")
        if not isinstance(contents, list):
            raise ProtocolError(f"resources/read result for {uri!r} has no contents array")
        return [_parse_resource_contents(item, uri) for item in contents]

    # -- internals ---------------------------------------------------------------

    def _ensure_open(self) -> None:
        if self._closed:
            raise SessionBindingError(f"Session {self._session_id} is closed")

    async def _tool_accepts(self, name: str, argument: str, timeout: float | None) -> bool:
        if self._tools is None or name not in self._tools:
            await self.list_tools(timeout=timeout)
        tool = (self._tools or {}).get(name)
        return tool is not None and tool.accepts_argument(argument)

    async def _notify(self, method: str) -> None:
        body = {"jsonrpc": "2.0", "method": method}
        response = await self._post(body, timeout=None, protocol_header=True)
        if not 200 <= response.status < 300:
            raise _http_failure(response)

    async def _request(
        self,
        method: str,
        params: Mapping[str, Any],
        *,
        timeout: float | None,
        protocol_header: bool = True,
    ) -> Mapping[str, Any]:
        self._ensure_open()
        request_id = next(self._ids)
        body = {"jsonrpc": "2.0", "id": request_id, "method": method, "params": dict(params)}
        response = await self._post(body, timeout=timeout, protocol_header=protocol_header)
        if not 200 <= response.status < 300:
            raise _http_failure(response)
        message = _select_reply(response, request_id, method)
        error = message.get("error")
        if error is not None:
            raise _mcp_error(error)
        result = message.get("result")
        if not isinstance(result, dict):
            raise ProtocolError(f"{method} reply has no result object")
        return result

    async def _post(
        self, body: Mapping[str, Any], *, timeout: float | None, protocol_header: bool
    ) -> HttpResponse:
        """POST with the daemon's retry rules; every retried request provably never ran."""
        payload = json.dumps(body, separators=(",", ":")).encode("utf-8")
        deadline = self._clock() + (
            timeout if timeout is not None else self._startup_retry_budget_s
        )
        reauthenticated = False
        reresolved = False
        while True:
            token = self._read_token()
            if token is None:
                raise DaemonAuthenticationError(
                    "No daemon HTTP token is published. Is the daemon running? "
                    "Call ensure_running() first."
                )
            headers = {
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
                "Authorization": f"Bearer {token}",
                MCP_SESSION_KEY_HEADER: self._session_id,
            }
            if protocol_header and self._protocol_version is not None:
                headers["mcp-protocol-version"] = self._protocol_version
            port = await self._resolve_port(refresh=False)
            remaining = None if timeout is None else max(deadline - self._clock(), 0.001)
            try:
                response = await self._transport.post(
                    port, MCP_STREAMABLE_PATH, headers, payload, remaining
                )
            except (ConnectionRefusedError, FileNotFoundError) as error:
                # The connection was never established, so nothing was delivered. The
                # daemon may have restarted on another port.
                if not reresolved:
                    reresolved = True
                    if await self._resolve_port(refresh=True) != port:
                        continue
                raise DaemonUnavailableError(
                    f"Could not reach the AutoMobile daemon on 127.0.0.1:{port}: {error}"
                ) from error
            except ConnectionError as error:
                # A reset or broken pipe can arrive after the request was written and run,
                # so it is never re-sent. Forget the port so the next request re-resolves it.
                self._port = None
                raise DaemonUnavailableError(
                    f"Connection to the AutoMobile daemon on 127.0.0.1:{port} was lost; "
                    f"the request may already have run: {error}"
                ) from error
            if response.status == 401:
                # A daemon restart publishes a new token: re-read the file once and retry.
                if not reauthenticated:
                    reauthenticated = True
                    continue
                raise DaemonAuthenticationError(
                    "The daemon refused the HTTP token (401). The token file may belong to "
                    "another daemon namespace; check AUTOMOBILE_AUX_SOCKET_DIR and "
                    "AUTOMOBILE_DAEMON_TOKEN_FILE_PATH."
                )
            if response.status == 503:
                retry_after = _retry_after_seconds(response)
                if retry_after is None:
                    raise DaemonUnavailableError(
                        f"AutoMobile daemon unavailable (503): {_excerpt(response.body)}"
                    )
                if self._clock() + retry_after >= deadline:
                    raise DaemonUnavailableError(
                        "AutoMobile daemon is still starting; retry later or raise the timeout"
                    )
                await self._sleep(retry_after)
                continue
            return response

    def _read_token(self) -> str | None:
        try:
            return self._token_provider.read()
        except DaemonAuthenticationError:
            raise
        except OSError as error:
            raise DaemonAuthenticationError(
                f"Could not read the daemon HTTP token: {error.strerror or error}"
            ) from error

    async def _resolve_port(self, *, refresh: bool) -> int:
        if self._port is None or refresh:
            self._port = await self._port_resolver()
        return self._port


def _parse_tool(item: Any) -> Tool:
    if not isinstance(item, dict) or not isinstance(item.get("name"), str):
        raise ProtocolError("tools/list returned a tool without a name")
    schema = item.get("inputSchema")
    description = item.get("description")
    annotations = item.get("annotations")
    meta = item.get("_meta")
    return Tool(
        name=item["name"],
        description=description if isinstance(description, str) else None,
        input_schema=schema if isinstance(schema, dict) else {},
        annotations=annotations if isinstance(annotations, dict) else None,
        meta=meta if isinstance(meta, dict) else None,
        raw=item,
    )


def _parse_resource_contents(item: Any, requested_uri: str) -> ResourceContents:
    if not isinstance(item, dict):
        raise ProtocolError(f"resources/read for {requested_uri!r} returned a non-object entry")
    uri = item.get("uri") if isinstance(item.get("uri"), str) else requested_uri
    mime_type = item.get("mimeType")
    text = item.get("text")
    blob_text = item.get("blob")
    blob: bytes | None = None
    if isinstance(blob_text, str):
        try:
            blob = base64.b64decode(blob_text, validate=True)
        except (binascii.Error, ValueError) as error:
            raise ProtocolError(f"resource {uri!r} has an invalid base64 blob") from error
    meta = item.get("_meta")
    return ResourceContents(
        uri=str(uri),
        mime_type=mime_type if isinstance(mime_type, str) else None,
        text=text if isinstance(text, str) else None,
        blob=blob,
        meta=meta if isinstance(meta, dict) else None,
    )


def _select_reply(response: HttpResponse, request_id: int, method: str) -> Mapping[str, Any]:
    content_type = (response.header("content-type") or "").lower()
    text = response.body.decode("utf-8", errors="replace")
    if content_type.startswith("text/event-stream"):
        candidates = parse_sse_messages(text)
    else:
        try:
            parsed = json.loads(text)
        except ValueError as error:
            raise ProtocolError(f"{method} reply is not JSON: {_excerpt(response.body)}") from error
        candidates = parsed if isinstance(parsed, list) else [parsed]
    for message in candidates:
        if (
            isinstance(message, dict)
            and message.get("id") == request_id
            and ("result" in message or "error" in message)
        ):
            return message
    raise ProtocolError(f"Daemon response carried no reply to {method} (id {request_id})")


def _mcp_error(error: Any) -> McpError:
    if isinstance(error, dict):
        code = error.get("code")
        message = error.get("message")
        return McpError(
            code if isinstance(code, int) else -32603,
            message if isinstance(message, str) else "Unknown error",
            error.get("data"),
        )
    return McpError(-32603, str(error))


def _http_failure(response: HttpResponse) -> Exception:
    try:
        parsed = json.loads(response.body.decode("utf-8"))
    except ValueError:
        parsed = None
    if isinstance(parsed, dict) and isinstance(parsed.get("error"), dict):
        return _mcp_error(parsed["error"])
    return ProtocolError(f"Daemon HTTP {response.status}: {_excerpt(response.body)}")


def _retry_after_seconds(response: HttpResponse) -> float | None:
    value = response.header("retry-after")
    if value is None:
        return None
    try:
        seconds = float(value)
    except ValueError:
        return None
    return seconds if seconds >= 0 else None


def _excerpt(body: bytes) -> str:
    text = body.decode("utf-8", errors="replace").strip()
    return text if len(text) <= _ERROR_EXCERPT_CHARS else text[:_ERROR_EXCERPT_CHARS] + "..."
