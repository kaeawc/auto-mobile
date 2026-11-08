"""End-to-end through the real loopback transport against a fake daemon endpoint."""

from __future__ import annotations

import unittest

from auto_mobile import AutoMobile, DaemonAuthenticationError, DaemonUnavailableError

from .fakes import FakeClock, FakeDaemonServer, FakeRunner, FakeTokens, status_result


class FakeDaemonTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.server = await FakeDaemonServer("tok").__aenter__()
        self.runner = FakeRunner()
        self.runner.queue("status", status_result(running=True, pid=1, port=self.server.port))
        self.clock = FakeClock()

    async def asyncTearDown(self) -> None:
        await self.server.__aexit__()

    def client(self, token: str = "tok") -> AutoMobile:
        return AutoMobile(
            runner=self.runner,
            token_provider=FakeTokens(token),
            sleep=self.clock.sleep,
        )

    async def test_session_over_chunked_sse(self) -> None:
        async with self.client().session(session_id="s1", device_id="emulator-5554") as session:
            tools = await session.list_tools()
            result = await session.call_tool("observe")
            resource = await session.read_resource("automobile:x")
        self.assertEqual(len(tools), 2)
        self.assertEqual(result.text, '{"deviceId": "emulator-5554"}')
        self.assertEqual(resource[0].blob, b"\x89PNG")
        hosts = {headers["host"] for headers, _ in self.server.requests}
        self.assertEqual(hosts, {f"127.0.0.1:{self.server.port}"})
        self.assertEqual(
            {h["x-auto-mobile-mcp-session-id"] for h, _ in self.server.requests}, {"s1"}
        )

    async def test_plain_json_replies(self) -> None:
        self.server.use_sse = False
        async with self.client().session() as session:
            self.assertEqual(len(await session.list_tools()), 2)

    async def test_startup_503_is_retried(self) -> None:
        self.server.starting = 2
        async with self.client().session() as session:
            await session.list_tools()
        self.assertEqual(self.clock.sleeps, [1.0, 1.0])

    async def test_wrong_token_is_refused(self) -> None:
        with self.assertRaises(DaemonAuthenticationError):
            await self.client(token="wrong").session().initialize()

    async def test_stopped_daemon_is_unavailable(self) -> None:
        runner = FakeRunner()
        runner.queue("status", status_result(running=False))
        client = AutoMobile(runner=runner, token_provider=FakeTokens("tok"))
        with self.assertRaises(DaemonUnavailableError):
            await client.session().initialize()


if __name__ == "__main__":
    unittest.main()
