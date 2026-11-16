from __future__ import annotations

import json
import os
import tempfile
import unittest

from auto_mobile import AutoMobile, DaemonCommandError, DaemonUnavailableError
from auto_mobile.daemon import CommandResult

from .fakes import FakeClock, FakeRunner, status_result

RUNNING = {"running": True, "pid": 7, "port": 3002, "version": "0.0.95"}
OK = CommandResult(exit_code=0, stdout="", stderr="")

REPORT = {
    "timestamp": "2026-11-15T00:00:00.000Z",
    "version": "0.0.95",
    "platform": "linux",
    "arch": "x64",
    "system": {"checks": [{"name": "Node", "status": "pass", "message": "v24", "value": "24"}]},
    "android": {
        "checks": [
            {
                "name": "ADB",
                "status": "fail",
                "message": "adb not found",
                "recommendation": "Install platform-tools",
            }
        ]
    },
    "autoMobile": {"checks": [{"name": "Daemon", "status": "warn", "message": "not running"}]},
    "summary": {"total": 3, "passed": 1, "warnings": 1, "failed": 1, "skipped": 0},
    "recommendations": ["Install platform-tools"],
}


def client(runner: FakeRunner, clock: FakeClock | None = None) -> AutoMobile:
    clock = clock or FakeClock()
    return AutoMobile(runner=runner, sleep=clock.sleep, clock=clock)


def doctor_result(payload: object, exit_code: int = 1, prefix: str = "") -> CommandResult:
    return CommandResult(
        exit_code=exit_code, stdout=prefix + json.dumps(payload, indent=2) + "\n", stderr=""
    )


class RestartTest(unittest.IsolatedAsyncioTestCase):
    async def test_restarts_then_polls_until_running(self) -> None:
        runner = FakeRunner()
        runner.queue("restart", OK)
        runner.queue("status", status_result(running=False), status_result(**RUNNING))
        clock = FakeClock()
        status = await client(runner, clock).restart()
        self.assertEqual(status.port, 3002)
        self.assertEqual([call[2] for call in runner.calls], ["restart", "status", "status"])
        self.assertEqual(clock.sleeps, [0.5])

    async def test_failed_restart_raises_with_stderr(self) -> None:
        runner = FakeRunner()
        runner.queue("restart", CommandResult(exit_code=1, stdout="", stderr="Error: held"))
        with self.assertRaises(DaemonCommandError) as raised:
            await client(runner).restart()
        self.assertEqual((raised.exception.command, raised.exception.exit_code), ("restart", 1))
        self.assertIn("held", str(raised.exception))

    async def test_deadline_bounds_polling(self) -> None:
        runner = FakeRunner()
        runner.queue("restart", OK)
        runner.queue("status", status_result(running=False))
        with self.assertRaises(DaemonUnavailableError):
            await client(runner).restart(timeout=2)


class ShutdownTest(unittest.IsolatedAsyncioTestCase):
    async def test_stops_and_returns_stopped_status(self) -> None:
        runner = FakeRunner()
        runner.queue("stop", OK)
        runner.queue("status", status_result(running=False))
        status = await client(runner).shutdown()
        self.assertFalse(status.running)
        self.assertEqual([call[2] for call in runner.calls], ["stop", "status"])

    async def test_still_running_after_stop_raises(self) -> None:
        runner = FakeRunner()
        runner.queue("stop", OK)
        runner.queue("status", status_result(**RUNNING))
        with self.assertRaises(DaemonUnavailableError) as raised:
            await client(runner).shutdown()
        self.assertIn("pid 7", str(raised.exception))

    async def test_failed_stop_raises(self) -> None:
        runner = FakeRunner()
        runner.queue("stop", CommandResult(exit_code=1, stdout="", stderr="Error: not ours"))
        with self.assertRaises(DaemonCommandError) as raised:
            await client(runner).shutdown()
        self.assertEqual(raised.exception.command, "stop")


class DoctorTest(unittest.IsolatedAsyncioTestCase):
    async def test_parses_report_and_returns_failures(self) -> None:
        runner = FakeRunner()
        runner.queue("doctor", doctor_result(REPORT, prefix="[INFO] loading\n"))
        report = await client(runner).doctor(android=True)
        self.assertEqual(runner.calls, [["auto-mobile", "--cli", "doctor", "--json", "--android"]])
        self.assertFalse(report.ok)
        self.assertEqual((report.passed, report.warnings, report.failed), (1, 1, 1))
        self.assertEqual(list(report.sections), ["system", "android", "autoMobile"])
        adb = report.sections["android"][0]
        self.assertEqual((adb.name, adb.status), ("ADB", "fail"))
        self.assertEqual(adb.recommendation, "Install platform-tools")
        self.assertEqual(report.checks[0].value, "24")
        self.assertEqual(report.recommendations, ("Install platform-tools",))
        self.assertEqual(report.version, "0.0.95")

    async def test_ios_filter_flag(self) -> None:
        runner = FakeRunner()
        runner.queue("doctor", doctor_result(REPORT, exit_code=0))
        await client(runner).doctor(ios=True)
        self.assertEqual(runner.calls[0][-1], "--ios")

    async def test_reads_spilled_report(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "doctor.json")
            with open(path, "w", encoding="utf-8") as handle:
                json.dump(REPORT, handle)
            envelope = {"truncated": False, "bytes": 70000, "artifact": {"path": path}}
            runner = FakeRunner()
            runner.queue("doctor", doctor_result(envelope))
            report = await client(runner).doctor()
        self.assertEqual(report.failed, 1)

    async def test_no_report_raises_with_stderr(self) -> None:
        runner = FakeRunner()
        runner.queue("doctor", CommandResult(exit_code=1, stdout="", stderr="Error: bad flag"))
        with self.assertRaises(DaemonCommandError) as raised:
            await client(runner).doctor()
        self.assertEqual(raised.exception.command, "doctor --json")
        self.assertIn("bad flag", str(raised.exception))

    async def test_unreadable_spill_raises(self) -> None:
        envelope = {"truncated": False, "artifact": {"path": "/nonexistent/doctor.json"}}
        runner = FakeRunner()
        runner.queue("doctor", doctor_result(envelope))
        with self.assertRaises(DaemonCommandError):
            await client(runner).doctor()


if __name__ == "__main__":
    unittest.main()
