from __future__ import annotations

import unittest

from auto_mobile import AutoMobile, DaemonCommandError, DaemonUnavailableError
from auto_mobile.daemon import CommandResult

from .fakes import FakeClock, FakeRunner, status_result

RUNNING = {
    "running": True,
    "pid": 42,
    "port": 3001,
    "socketPath": "/tmp/s.sock",
    "version": "0.0.90",
}


def client(runner: FakeRunner, clock: FakeClock | None = None, **kwargs: object) -> AutoMobile:
    clock = clock or FakeClock()
    return AutoMobile(runner=runner, sleep=clock.sleep, clock=clock, **kwargs)  # type: ignore[arg-type]


class StatusTest(unittest.IsolatedAsyncioTestCase):
    async def test_parses_status_json(self) -> None:
        runner = FakeRunner()
        runner.queue("status", status_result(**RUNNING))
        status = await client(runner, executable=["npx", "-y", "@kaeawc/auto-mobile"]).status()
        self.assertTrue(status.running)
        self.assertEqual((status.pid, status.port, status.version), (42, 3001, "0.0.90"))
        self.assertEqual(
            runner.calls, [["npx", "-y", "@kaeawc/auto-mobile", "--daemon", "status", "--json"]]
        )

    async def test_env_overrides_reach_the_command(self) -> None:
        runner = FakeRunner()
        runner.queue("status", status_result(running=False))
        await client(runner, env={"AUTOMOBILE_AUX_SOCKET_DIR": "/tmp/lane"}).status()
        self.assertEqual(runner.envs[0]["AUTOMOBILE_AUX_SOCKET_DIR"], "/tmp/lane")

    async def test_ignores_log_lines_around_the_status_object(self) -> None:
        runner = FakeRunner()
        stdout = (
            '[INFO] starting\n{"not": "last"\n{"running": false, "recovery": {"state": "failed"}}\n'
        )
        runner.queue("status", CommandResult(exit_code=1, stdout=stdout, stderr=""))
        status = await client(runner).status()
        self.assertFalse(status.running)
        self.assertFalse(status.healthy)

    async def test_no_status_object_raises_with_stderr(self) -> None:
        runner = FakeRunner()
        runner.queue("status", CommandResult(exit_code=1, stdout="", stderr="Error: boom"))
        with self.assertRaises(DaemonCommandError) as raised:
            await client(runner).status()
        self.assertEqual(raised.exception.exit_code, 1)
        self.assertIn("boom", str(raised.exception))


class EnsureRunningTest(unittest.IsolatedAsyncioTestCase):
    async def test_running_daemon_is_not_started(self) -> None:
        runner = FakeRunner()
        runner.queue("status", status_result(**RUNNING))
        status = await client(runner).ensure_running()
        self.assertEqual(status.port, 3001)
        self.assertEqual([call[-1] for call in runner.calls], ["--json"])

    async def test_starts_then_polls_until_running(self) -> None:
        runner = FakeRunner()
        runner.queue(
            "status",
            status_result(running=False),
            status_result(running=False),
            status_result(**RUNNING),
        )
        runner.queue("start", CommandResult(exit_code=0, stdout="", stderr=""))
        clock = FakeClock()
        status = await client(runner, clock).ensure_running()
        self.assertTrue(status.running)
        self.assertEqual(
            [call[2] for call in runner.calls], ["status", "start", "status", "status"]
        )
        self.assertEqual(clock.sleeps, [0.5])

    async def test_failed_start_raises(self) -> None:
        runner = FakeRunner()
        runner.queue("status", status_result(running=False))
        runner.queue("start", CommandResult(exit_code=1, stdout="", stderr="Error: port taken"))
        with self.assertRaises(DaemonCommandError) as raised:
            await client(runner).ensure_running()
        self.assertIn("port taken", str(raised.exception))

    async def test_deadline_bounds_polling(self) -> None:
        runner = FakeRunner()
        runner.queue("status", status_result(running=False))
        runner.queue("start", CommandResult(exit_code=0, stdout="", stderr=""))
        with self.assertRaises(DaemonUnavailableError):
            await client(runner).ensure_running(timeout=2)

    async def test_start_timeout_is_typed(self) -> None:
        class SlowRunner(FakeRunner):
            async def run(self, argv, *, env, cwd, timeout):  # type: ignore[no-untyped-def]
                raise TimeoutError

        with self.assertRaises(DaemonCommandError):
            await client(SlowRunner()).status()


if __name__ == "__main__":
    unittest.main()
