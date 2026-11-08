"""Minimal async HTTP/1.1 POST client for the daemon's loopback MCP endpoint.

Only what the daemon endpoint needs: one POST per connection (``Connection: close``),
``Content-Length`` or chunked responses, and a bounded body. Cancelling the awaiting
task closes the connection, which the daemon treats as the request being abandoned.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Protocol

from .errors import ProtocolError

MAX_RESPONSE_BYTES = 256 * 1024 * 1024
_MAX_HEADER_LINES = 200


@dataclass(frozen=True)
class HttpResponse:
    status: int
    headers: Mapping[str, str]
    body: bytes

    def header(self, name: str) -> str | None:
        return self.headers.get(name.lower())


class HttpTransport(Protocol):
    """Sends one POST to ``http://127.0.0.1:<port><path>``. Tests substitute a fake."""

    async def post(
        self,
        port: int,
        path: str,
        headers: Mapping[str, str],
        body: bytes,
        timeout: float | None,
    ) -> HttpResponse: ...


class LoopbackHttpTransport:
    """The production transport: plain HTTP to the IPv4 loopback address."""

    host = "127.0.0.1"

    async def post(
        self,
        port: int,
        path: str,
        headers: Mapping[str, str],
        body: bytes,
        timeout: float | None,
    ) -> HttpResponse:
        return await asyncio.wait_for(self._exchange(port, path, headers, body), timeout)

    async def _exchange(
        self, port: int, path: str, headers: Mapping[str, str], body: bytes
    ) -> HttpResponse:
        reader, writer = await asyncio.open_connection(self.host, port)
        try:
            head = [f"POST {path} HTTP/1.1", f"Host: {self.host}:{port}"]
            head += [f"{name}: {value}" for name, value in headers.items()]
            head += [f"Content-Length: {len(body)}", "Connection: close", "", ""]
            writer.write("\r\n".join(head).encode("latin-1") + body)
            await writer.drain()
            return await read_response(reader)
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except (ConnectionError, OSError):
                # The peer may already have reset a closed connection; nothing is left to flush.
                pass


async def read_response(reader: asyncio.StreamReader) -> HttpResponse:
    """Parse one HTTP/1.1 response from ``reader``."""
    status_line = (await reader.readline()).decode("latin-1").rstrip("\r\n")
    parts = status_line.split(" ", 2)
    if len(parts) < 2 or not parts[0].startswith("HTTP/") or not parts[1].isdigit():
        raise ProtocolError(f"Malformed HTTP status line from daemon: {status_line[:80]!r}")
    status = int(parts[1])
    headers: dict[str, str] = {}
    for _ in range(_MAX_HEADER_LINES):
        line = (await reader.readline()).decode("latin-1").rstrip("\r\n")
        if not line:
            break
        name, _, value = line.partition(":")
        headers[name.strip().lower()] = value.strip()
    else:
        raise ProtocolError("Daemon HTTP response has too many header lines")

    if "chunked" in headers.get("transfer-encoding", "").lower():
        body = await _read_chunked(reader)
    elif "content-length" in headers:
        length = int(headers["content-length"])
        if length > MAX_RESPONSE_BYTES:
            raise ProtocolError(f"Daemon HTTP response too large: {length} bytes")
        body = await reader.readexactly(length)
    else:
        body = await reader.read(MAX_RESPONSE_BYTES + 1)
        if len(body) > MAX_RESPONSE_BYTES:
            raise ProtocolError("Daemon HTTP response too large")
    return HttpResponse(status=status, headers=headers, body=body)


async def _read_chunked(reader: asyncio.StreamReader) -> bytes:
    chunks: list[bytes] = []
    total = 0
    while True:
        size_line = (await reader.readline()).decode("latin-1").strip()
        if not size_line:
            raise ProtocolError("Daemon HTTP chunked response ended early")
        size = int(size_line.split(";", 1)[0], 16)
        if size == 0:
            # Discard optional trailers up to the terminating blank line.
            while (await reader.readline()).strip():
                pass
            return b"".join(chunks)
        total += size
        if total > MAX_RESPONSE_BYTES:
            raise ProtocolError("Daemon HTTP response too large")
        chunks.append(await reader.readexactly(size))
        await reader.readexactly(2)


def parse_sse_messages(body: str) -> list[Any]:
    """The JSON payloads of a ``text/event-stream`` body, one per event with data."""
    messages: list[Any] = []
    data_lines: list[str] = []

    def flush() -> None:
        if data_lines:
            payload = "\n".join(data_lines)
            data_lines.clear()
            if payload.strip():
                try:
                    messages.append(json.loads(payload))
                except ValueError as error:
                    raise ProtocolError("Daemon event stream carried non-JSON data") from error

    for raw_line in body.splitlines():
        if raw_line == "":
            flush()
        elif raw_line.startswith(":"):
            continue  # keepalive comment
        elif raw_line.startswith("data:"):
            value = raw_line[5:]
            data_lines.append(value[1:] if value.startswith(" ") else value)
    flush()
    return messages
