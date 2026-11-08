from __future__ import annotations

import unittest
from typing import Any

from auto_mobile import (
    DaemonAuthenticationError,
    DaemonUnavailableError,
    McpError,
    McpSession,
    ProtocolError,
    SessionBindingError,
    ToolCallError,
)
from auto_mobile.http import HttpResponse

from .fakes import (
    FakeClock,
    FakeTokens,
    FakeTransport,
    Sent,
    json_response,
    mcp_reply,
    sse_response,
)


def daemon(sent: Sent) -> HttpResponse:
    reply = mcp_reply(sent.body)
    if reply is None:
        return HttpResponse(status=202, headers={}, body=b"")
    return sse_response({"jsonrpc": "2.0", "method": "notifications/progress", "params": {}}, reply)


class Harness:
    def __init__(
        self,
        handler: Any = daemon,
        tokens: FakeTokens | None = None,
        ports: list[int] | None = None,
    ) -> None:
        self.transport = FakeTransport(handler)
        self.tokens = tokens or FakeTokens("tok")
        self.ports = ports or [3000]
        self.port_lookups = 0
        self.clock = FakeClock()

    async def port(self) -> int:
        self.port_lookups += 1
        return self.ports.pop(0) if len(self.ports) > 1 else self.ports[0]

    def session(self, **kwargs: Any) -> McpSession:
        return McpSession(
            port_resolver=self.port,
            token_provider=self.tokens,
            transport=self.transport,
            sleep=self.clock.sleep,
            clock=self.clock,
            **kwargs,
        )


class BindingTest(unittest.IsolatedAsyncioTestCase):
    async def test_initializes_once_and_sends_the_bound_session_key_on_every_request(self) -> None:
        h = Harness()
        async with h.session(session_id="sess-1") as session:
            await session.list_tools()
            await session.call_tool("listDevices")
        methods = [s.body.get("method") for s in h.transport.sent]
        self.assertEqual(
            methods, ["initialize", "notifications/initialized", "tools/list", "tools/call"]
        )
        for sent in h.transport.sent:
            self.assertEqual(sent.headers["x-auto-mobile-mcp-session-id"], "sess-1")
            self.assertEqual(sent.headers["Authorization"], "Bearer tok")
            self.assertEqual(sent.path, "/auto-mobile/streamable")
            self.assertEqual(sent.port, 3000)
        self.assertNotIn("mcp-protocol-version", h.transport.sent[0].headers)
        self.assertEqual(h.transport.sent[2].headers["mcp-protocol-version"], "2025-11-25")
        self.assertEqual(session.server_info, {"name": "AutoMobile", "version": "0.0.90"})

    async def test_generates_a_session_id_when_none_is_given(self) -> None:
        a, b = Harness().session(), Harness().session()
        self.assertTrue(a.session_id)
        self.assertNotEqual(a.session_id, b.session_id)

    async def test_bound_device_is_added_only_where_the_schema_accepts_it(self) -> None:
        h = Harness()
        async with h.session(device_id="emulator-5554") as session:
            observed = await session.call_tool("observe")
            listed = await session.call_tool("listDevices")
        self.assertEqual(observed.text, '{"deviceId": "emulator-5554"}')
        self.assertEqual(listed.text, "{}")

    async def test_call_for_another_device_is_refused_before_sending(self) -> None:
        h = Harness()
        async with h.session(device_id="emulator-5554") as session:
            sent_before = len(h.transport.sent)
            with self.assertRaises(SessionBindingError):
                await session.call_tool("observe", {"deviceId": "emulator-5556"})
            self.assertEqual(len(h.transport.sent), sent_before)

    async def test_closed_session_refuses_calls(self) -> None:
        h = Harness()
        session = h.session()
        await session.close()
        with self.assertRaises(SessionBindingError):
            await session.list_tools()

    def test_blank_ids_are_rejected(self) -> None:
        with self.assertRaises(ValueError):
            Harness().session(session_id=" ")
        with self.assertRaises(ValueError):
            Harness().session(device_id="")


class ResultTest(unittest.IsolatedAsyncioTestCase):
    async def test_list_tools_parses_schemas(self) -> None:
        async with Harness().session() as session:
            tools = await session.list_tools()
        self.assertEqual([t.name for t in tools], ["observe", "listDevices"])
        self.assertTrue(tools[0].accepts_argument("deviceId"))

    async def test_list_tools_follows_pagination(self) -> None:
        def paged(sent: Sent) -> HttpResponse:
            body = sent.body
            if body.get("method") == "tools/list":
                cursor = body["params"].get("cursor")
                page = (
                    {"tools": [{"name": "b"}]}
                    if cursor
                    else {"tools": [{"name": "a"}], "nextCursor": "p2"}
                )
                return json_response({"jsonrpc": "2.0", "id": body["id"], "result": page})
            return daemon(sent)

        async with Harness(paged).session() as session:
            self.assertEqual([t.name for t in await session.list_tools()], ["a", "b"])

    async def test_read_resource_decodes_blobs(self) -> None:
        async with Harness().session() as session:
            contents = await session.read_resource("automobile:devices/x/screenshot")
        self.assertEqual(contents[0].mime_type, "image/png")
        self.assertEqual(contents[0].blob, b"\x89PNG")

    async def test_json_rpc_error_raises_mcp_error(self) -> None:
        async with Harness().session() as session:
            with self.assertRaises(McpError) as raised:
                await session.call_tool("boom")
        self.assertEqual(raised.exception.code, -32602)

    async def test_tool_failure_is_a_result_until_raised(self) -> None:
        def failing(sent: Sent) -> HttpResponse:
            if sent.body.get("method") == "tools/call":
                result = {"content": [{"type": "text", "text": "no device"}], "isError": True}
                return json_response({"jsonrpc": "2.0", "id": sent.body["id"], "result": result})
            return daemon(sent)

        async with Harness(failing).session() as session:
            result = await session.call_tool("listDevices")
        self.assertTrue(result.is_error)
        with self.assertRaises(ToolCallError):
            result.raise_for_error()

    async def test_unsupported_protocol_version_is_refused(self) -> None:
        def future(sent: Sent) -> HttpResponse:
            result = {"protocolVersion": "2099-01-01", "capabilities": {}}
            return json_response({"jsonrpc": "2.0", "id": sent.body["id"], "result": result})

        with self.assertRaises(ProtocolError):
            await Harness(future).session().initialize()

    async def test_stream_without_a_reply_is_a_protocol_error(self) -> None:
        def silent(sent: Sent) -> HttpResponse:
            return sse_response({"jsonrpc": "2.0", "method": "notifications/progress"})

        with self.assertRaises(ProtocolError):
            await Harness(silent).session().initialize()


class RetryTest(unittest.IsolatedAsyncioTestCase):
    async def test_401_rereads_the_token_once(self) -> None:
        def auth(sent: Sent) -> HttpResponse:
            if sent.headers["Authorization"] != "Bearer new":
                return json_response({"error": "Unauthorized"}, status=401)
            return daemon(sent)

        h = Harness(auth, tokens=FakeTokens("old", "new"))
        async with h.session():
            pass
        self.assertEqual(h.transport.sent[1].headers["Authorization"], "Bearer new")

    async def test_persistent_401_raises_without_leaking_the_token(self) -> None:
        h = Harness(
            lambda sent: json_response({"error": "Unauthorized"}, status=401),
            tokens=FakeTokens("secret"),
        )
        with self.assertRaises(DaemonAuthenticationError) as raised:
            await h.session().initialize()
        self.assertNotIn("secret", str(raised.exception))
        self.assertEqual(len(h.transport.sent), 2)

    async def test_missing_token_raises(self) -> None:
        with self.assertRaises(DaemonAuthenticationError):
            await Harness(tokens=FakeTokens(None)).session().initialize()

    async def test_503_with_retry_after_is_retried(self) -> None:
        attempts = {"n": 0}

        def starting(sent: Sent) -> HttpResponse:
            attempts["n"] += 1
            if attempts["n"] <= 2:
                return json_response(
                    {"error": "Daemon is still starting"}, status=503, **{"Retry-After": "1"}
                )
            return daemon(sent)

        h = Harness(starting)
        async with h.session():
            pass
        self.assertEqual(h.clock.sleeps, [1.0, 1.0])

    async def test_503_without_retry_after_is_not_retried(self) -> None:
        h = Harness(lambda sent: json_response({"error": "Daemon is shutting down"}, status=503))
        with self.assertRaises(DaemonUnavailableError):
            await h.session().initialize()
        self.assertEqual(len(h.transport.sent), 1)

    async def test_startup_retries_stop_at_the_deadline(self) -> None:
        h = Harness(lambda sent: json_response({}, status=503, **{"Retry-After": "1"}))
        with self.assertRaises(DaemonUnavailableError):
            await h.session().call_tool("listDevices", timeout=3)

    async def test_refused_connection_reresolves_the_port_once(self) -> None:
        h = Harness(ports=[3000, 3002])
        h.transport.failures.append(ConnectionRefusedError())
        async with h.session():
            pass
        self.assertEqual([s.port for s in h.transport.sent], [3000, 3002, 3002])

    async def test_refused_connection_on_the_same_port_raises(self) -> None:
        h = Harness()
        h.transport.failures.append(ConnectionRefusedError())
        with self.assertRaises(DaemonUnavailableError):
            await h.session().initialize()


if __name__ == "__main__":
    unittest.main()
