from __future__ import annotations
import unittest
import anyio
from mcp_harness.close_result import classify_close, worst_exit

class CloseTests(unittest.TestCase):
    def test_none_and_transport_leaves(self) -> None:
        self.assertEqual(classify_close(None, 1).status, "CLOSE_OK")
        for exc in (anyio.BrokenResourceError(), anyio.ClosedResourceError(), anyio.EndOfStream(),
                    BrokenPipeError(), ConnectionResetError(), ExceptionGroup("nested", [ExceptionGroup("inner", [anyio.BrokenResourceError()])])):
            result = classify_close(exc, 2)
            self.assertEqual(result.classification, "transport-broken")
            self.assertEqual(result.status, "CLOSE_RAISED")
            self.assertTrue(result.traceback)
        result = classify_close(ExceptionGroup("mixed", [ValueError("first"), ExceptionGroup("inner", [anyio.BrokenResourceError(), OSError("last")])]), 3)
        self.assertEqual(result.leaves, ["builtins.ValueError", "anyio.BrokenResourceError", "builtins.OSError"])

    def test_other_classes_timeout_and_precedence(self) -> None:
        for exc, expected in ((RuntimeError("Attempted to exit cancel scope in a different task"), "cancel-scope-misuse"),
                              (ProcessLookupError(), "server-gone"), (ValueError(), "other")):
            self.assertEqual(classify_close(exc, 1).classification, expected)
        self.assertEqual(classify_close(None, 500, True).status, "CLOSE_HANG")
        self.assertEqual(classify_close(None, 500, True).classification, "timeout")
        self.assertEqual(worst_exit([1, 3, 2, 0]), 2)
        self.assertEqual(worst_exit([1, 3, 0]), 3)
