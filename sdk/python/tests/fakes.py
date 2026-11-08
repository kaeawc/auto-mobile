"""Test doubles: a fake ``auto-mobile`` CLI runner, an in-memory HTTP transport, a fake
clock, and a fake daemon HTTP endpoint served on a real loopback socket."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from auto_mobile.daemon import CommandResult
from auto_mobile.http import HttpResponse


class FakeClock:
    def __init__(self) -> None:
        self.now = 0.0
        self.sleeps: list[float] = []

    def __call__(self) -> float:
        return self.now

    async def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


@dataclass
class FakeRunner:
    """Answers ``--daemon <command>`` from queued results, recording every argv."""

    responses: dict[str, list[CommandResult]] = field(default_factory=dict)
    calls: list[list[str]] = field(default_factory=list)
    envs: list[Mapping[str, str]] = field(default_factory=list)

    def queue(self, command: str, *results: CommandResult) -> None:
        self.responses.setdefault(command, []).extend(results)

    async def run(
        self,
        argv: Sequence[str],
        *,
        env: Mapping[str, str],
        cwd: str | None,
        timeout: float,
    ) -> CommandResult:
        self.calls.append(list(argv))
        self.envs.append(env)
        command = argv[list(argv).index("--daemon") + 1]
        queue = self.responses.get(command) or []
        if not queue:
            raise AssertionError(f"unexpected command {list(argv)}")
        return queue.pop(0) if len(queue) > 1 else queue[0]


def status_result(**fields: Any) -> CommandResult:
    return CommandResult(exit_code=0, stdout=json.dumps(fields) + "\n", stderr="")


def json_response(payload: Any, status: int = 200, **headers: str) -> HttpResponse:
    merged = {"content-type": "application/json", **{k.lower(): v for k, v in headers.items()}}
    return HttpResponse(status=status, headers=merged, body=json.dumps(payload).encode())


def sse_response(*messages: Any) -> HttpResponse:
    body = ": keepalive\n\n" + "".join(
        f"event: message\ndata: {json.dumps(m)}\n\n" for m in messages
    )
    return HttpResponse(
        status=200, headers={"content-type": "text/event-stream"}, body=body.encode()
    )


@dataclass
class Sent:
    port: int
    path: str
    headers: Mapping[str, str]
    body: Any


class FakeTransport:
    """Hands each POST to ``handler`` (or a queued exception) and records it."""

    def __init__(self, handler: Callable[[Sent], HttpResponse]) -> None:
        self.handler = handler
        self.sent: list[Sent] = []
        self.failures: list[BaseException] = []

    async def post(
        self,
        port: int,
        path: str,
        headers: Mapping[str, str],
        body: bytes,
        timeout: float | None,
    ) -> HttpResponse:
        sent = Sent(port, path, dict(headers), json.loads(body))
        self.sent.append(sent)
        if self.failures:
            raise self.failures.pop(0)
        return self.handler(sent)


class FakeTokens:
    def __init__(self, *tokens: str | None) -> None:
        self.tokens = list(tokens)
        self.reads = 0

    def read(self) -> str | None:
        self.reads += 1
        return self.tokens.pop(0) if len(self.tokens) > 1 else self.tokens[0]


TOOLS = [
    {
        "name": "observe",
        "description": "Observe the screen",
        "inputSchema": {"type": "object", "properties": {"deviceId": {"type": "string"}}},
    },
    {"name": "listDevices", "inputSchema": {"type": "object", "properties": {}}},
]


def mcp_reply(request: Mapping[str, Any]) -> Any:
    """The fake daemon's JSON-RPC result for one request (None for notifications)."""
    method = request.get("method")
    if "id" not in request:
        return None
    if method == "initialize":
        result: Any = {
            "protocolVersion": "2025-11-25",
            "capabilities": {"tools": {}, "resources": {}},
            "serverInfo": {"name": "AutoMobile", "version": "0.0.90"},
        }
    elif method == "tools/list":
        result = {"tools": TOOLS}
    elif method == "tools/call":
        params = request["params"]
        if params["name"] == "boom":
            return {
                "jsonrpc": "2.0",
                "id": request["id"],
                "error": {"code": -32602, "message": "Unknown tool: boom"},
            }
        result = {"content": [{"type": "text", "text": json.dumps(params["arguments"])}]}
    elif method == "resources/read":
        result = {
            "contents": [
                {"uri": request["params"]["uri"], "mimeType": "image/png", "blob": "iVBORw=="}
            ]
        }
    else:
        return {
            "jsonrpc": "2.0",
            "id": request["id"],
            "error": {"code": -32601, "message": "Method not found"},
        }
    return {"jsonrpc": "2.0", "id": request["id"], "result": result}


class FakeDaemonServer:
    """A loopback HTTP server that speaks the daemon endpoint's contract.

    It enforces the bearer token, answers ``503 + Retry-After`` while ``starting`` is
    positive, and replies to POSTs with chunked SSE (as the daemon does) or JSON.
    """

    def __init__(self, token: str) -> None:
        self.token = token
        self.starting = 0
        self.use_sse = True
        self.requests: list[tuple[Mapping[str, str], Any]] = []
        self._server: asyncio.base_events.Server | None = None
        self.port = 0

    async def __aenter__(self) -> FakeDaemonServer:
        self._server = await asyncio.start_server(self._handle, "127.0.0.1", 0)
        self.port = self._server.sockets[0].getsockname()[1]
        return self

    async def __aexit__(self, *_: object) -> None:
        assert self._server is not None
        self._server.close()
        await self._server.wait_closed()

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            request_line = await reader.readline()
            headers: dict[str, str] = {}
            while True:
                line = (await reader.readline()).decode().rstrip("\r\n")
                if not line:
                    break
                name, _, value = line.partition(":")
                headers[name.strip().lower()] = value.strip()
            body = await reader.readexactly(int(headers.get("content-length", "0")))
            assert request_line.startswith(b"POST /auto-mobile/streamable HTTP/1.1")
            message = json.loads(body)
            self.requests.append((headers, message))
            writer.write(self._respond(headers, message))
            await writer.drain()
        finally:
            writer.close()

    def _respond(self, headers: Mapping[str, str], message: Any) -> bytes:
        if headers.get("authorization") != f"Bearer {self.token}":
            return _raw(401, b'{"error":"Unauthorized"}', {"WWW-Authenticate": "Bearer"})
        if self.starting > 0:
            self.starting -= 1
            return _raw(503, b'{"error":"Daemon is still starting"}', {"Retry-After": "1"})
        reply = mcp_reply(message)
        if reply is None:
            return _raw(202, b"", {})
        if not self.use_sse:
            return _raw(200, json.dumps(reply).encode(), {"Content-Type": "application/json"})
        events = f": keepalive\n\nevent: message\ndata: {json.dumps(reply)}\n\n".encode()
        chunks = [events[:7], events[7:]]
        encoded = b"".join(b"%x\r\n%s\r\n" % (len(c), c) for c in chunks) + b"0\r\n\r\n"
        return (
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n"
            b"Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n" + encoded
        )


def _raw(status: int, body: bytes, headers: Mapping[str, str]) -> bytes:
    head = [f"HTTP/1.1 {status} X", f"Content-Length: {len(body)}", "Connection: close"]
    head += [f"{k}: {v}" for k, v in headers.items()]
    return ("\r\n".join(head) + "\r\n\r\n").encode() + body
