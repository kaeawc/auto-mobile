from __future__ import annotations
import importlib.metadata as md
import json
import stat
import unittest
from pathlib import Path
from characterize_close import scenario
from mcp_harness.orderings import ORDERINGS
from mcp_harness.client import Options
from unittest.mock import patch
from tests.support import call, run_fake, tempdir

class FakeClientTests(unittest.TestCase):
    def test_requests_full_responses_permissions_and_retry(self) -> None:
        with tempdir() as tmp:
            result, records, events = run_fake(Path(tmp), [call("echo", text="full\nresponse"),
                {**call("flaky", key="k", fail_times=2), "retries": 2, "retryDelayMs": 0},
                {"op": "listTools"}, {"op": "read", "uri": "fake://status"}])
            self.assertEqual(result.exit_code, 0)
            self.assertEqual(result.close.status, "CLOSE_OK")
            requests = [r for r in records if r["event"] == "request"]
            responses = [r for r in records if r["event"] == "response"]
            self.assertEqual(len(requests), 6)
            self.assertEqual(len(responses), 6)
            self.assertEqual([r["attempt"] for r in requests], [1, 1, 2, 3, 1, 1])
            self.assertEqual(responses[0]["response"]["content"][0]["text"], "full\nresponse")
            self.assertEqual(events[1]["attempts"], 3)
            self.assertEqual(result.retried_attempts, 2)
            self.assertEqual(stat.S_IMODE((Path(tmp)/"A.jsonl").stat().st_mode), 0o600)
            identity = json.loads((Path(tmp)/"A.identity.json").read_text())
            self.assertIn("scriptSha256", identity)
            self.assertNotIn("env", identity)
            self.assertEqual([r["seq"] for r in records], list(range(1, len(records)+1)))
            for request in requests:
                response = next(r for r in responses if (r["index"], r["attempt"]) == (request["index"], request["attempt"]))
                self.assertLess(request["seq"], response["seq"])

    def test_failed_step_kept_separate_from_close(self) -> None:
        with tempdir() as tmp:
            result, records, _ = run_fake(Path(tmp), [call("flaky", key="fail", fail_times=10)])
            self.assertEqual(result.exit_code, 1)
            self.assertEqual(result.steps_failed, 1)
            self.assertIsNotNone(result.first_step_failure)
            self.assertEqual(result.close.status, "CLOSE_OK")

    def test_all_close_modes_and_sdk_specific_races(self) -> None:
        major = int(md.version("mcp").split(".")[0])
        cases = [name for name in ORDERINGS if name not in ("two-clients-own-tasks", "two-clients-exit-stack-non-lifo", "close-in-other-task", "earlier-application-exception", "caller-cancellation")]
        for name in cases:
            with self.subTest(name=name), tempdir() as tmp:
                steps, env, options, extra = scenario(name)
                result, records, _ = run_fake(Path(tmp), steps, env, options.close_mode, **extra)
                self.assertIn(result.close.status, ORDERINGS[name].expected[major])
                self.assertTrue(any(r["event"] == "server-exit" for r in records))
                if name in ("notification-spam-then-close", "session-closed-transport-open-spam"):
                    self.assertEqual(result.steps_failed, 0, result.json())
                if name == "late-response-after-leave":
                    self.assertTrue(any(r.get("inFlightAtClose") for r in records))
                if major == 1 and name in ("late-response-after-leave", "notification-spam-then-close", "server-writes-after-stdin-eof", "session-closed-transport-open-spam"):
                    self.assertEqual(result.exit_code, 3)
                    self.assertEqual(result.close.classification, "transport-broken")
                    self.assertIn("anyio.BrokenResourceError", result.close.leaves)
        with tempdir() as tmp:
            result, records, _ = run_fake(Path(tmp), [call("echo", text="EOF")], mode="after-server-exit")
            self.assertEqual(result.exit_code, 0)
            self.assertTrue(any(r["event"] == "server-exit" and r.get("phase") is None for r in records))

    def test_application_failure_and_cancellation_retained(self) -> None:
        for extra in ({"application_error": True}, {"cancel_caller": True}):
            with tempdir() as tmp:
                result, records, _ = run_fake(Path(tmp), [call("hang", seconds=30)] if "cancel_caller" in extra else [call("echo", text="ok")],
                                              mode="mid-call" if "cancel_caller" in extra else "normal", **extra)
                self.assertIsNotNone(result.first_step_failure)
                self.assertEqual(result.close.status, "CLOSE_OK")
                self.assertTrue(any(r["event"] == "exception" and "traceback" in r["exception"] for r in records))

    def test_close_deadline_and_failed_process_capture(self) -> None:
        with tempdir() as tmp:
            result, records, _ = run_fake(Path(tmp), [call("echo", text="deadline")],
                                         {"FAKE_ON_EOF": "ignore"}, options=Options(close_timeout_ms=50))
            self.assertEqual(result.exit_code, 3)
            self.assertEqual(result.close.status, "CLOSE_HANG")
            self.assertEqual(result.close.classification, "timeout")
            self.assertEqual(result.server_exit_code, -9)
        async def uncaptured_enter(capture, transport):
            return await transport.__aenter__()
        with tempdir() as tmp, patch("mcp_harness.client.Capture.enter", uncaptured_enter):
            result, records, _ = run_fake(Path(tmp), [call("echo", text="must not send")], mode="kill-server")
            self.assertEqual(result.exit_code, 2)
            self.assertIn("capture failed", result.usage_error)
            self.assertFalse(any(r["event"] == "request" for r in records))
