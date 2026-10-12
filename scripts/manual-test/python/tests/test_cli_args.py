from __future__ import annotations
import contextlib
import io
import unittest
from mcp_harness.cli import parser, validate_args
from mcp_harness.script import UsageError

class CliTests(unittest.TestCase):
    def test_launch_and_forbidden_flags_both_clis(self) -> None:
        for two in (False, True):
            base = ["--script", "steps.json", "--out-dir", "/evidence"]
            for tail in ([], ["--fake-server", "--batch-dir", "/batch"],
                         *[["--fake-server", flag, "x"] for flag in ("--server", "--command", "--socket", "--port")],
                         ["--fake-server", "--close-mode-b" if two else "--close-mode", "bogus"]):
                with self.subTest(two=two, tail=tail), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as caught:
                    parser(two).parse_args(base + tail)
                self.assertEqual(caught.exception.code, 2)
            for tail in (["--batch-dir", "/batch"], ["--fake-server", "--daemon", "1"],
                         ["--batch-dir", "/batch", "--daemon", "1", "--fake-env", "FAKE_ON_EOF=ignore"]):
                with self.assertRaises(UsageError):
                    validate_args(parser(two).parse_args(base + tail), two)
            with self.assertRaises(UsageError):
                validate_args(parser(two).parse_args(["--fake-server", "--script", "s", "--out-dir", "relative"]), two)

    def test_two_script_xor_and_modes(self) -> None:
        p = parser(True)
        base = ["--fake-server", "--out-dir", "/evidence"]
        for flags in ([], ["--script-a", "a"], ["--script-b", "b"],
                      ["--script", "s", "--script-a", "a", "--script-b", "b"]):
            with self.assertRaises(UsageError):
                validate_args(p.parse_args(base + flags), True)
        for flags in (["--script", "s"], ["--script-a", "a", "--script-b", "b"]):
            validate_args(p.parse_args(base + flags), True)
        for mode in ("normal", "mid-call", "kill-server", "sigterm-server", "after-server-exit"):
            validate_args(parser().parse_args(base + ["--script", "s", "--close-mode", mode]))
