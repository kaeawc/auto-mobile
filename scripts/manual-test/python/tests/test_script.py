from __future__ import annotations
import unittest
from mcp_harness.script import UsageError, parse_script

class ScriptTests(unittest.TestCase):
    def test_valid_nested_substitution_and_guard_calls(self) -> None:
        script = parse_script({"description": "valid", "steps": [
            {"op": "listTools"}, {"op": "sleep", "ms": 0}, {"op": "read", "uri": "fake://status"},
            {"op": "call", "tool": "echo", "arguments": {"nested": [{"device": "${deviceId}"}]}}],
            "afterPeerClosed": [{"op": "call", "tool": "echo", "arguments": {"text": "${deviceId}"}}]}, {"deviceId": "serial"})
        self.assertEqual(script.steps[3]["arguments"]["nested"][0]["device"], "serial")
        self.assertEqual(len(script.calls()), 2)

    def test_rejects_each_invalid_shape(self) -> None:
        bad = [{"op": "nope"}, {"op": "listTools", "unknown": True},
               {"op": "call", "tool": "echo", "arguments": {"text": "${missing}"}},
               {"op": "call", "tool": "echo", "arguments": []}, {"op": "sleep", "ms": -1},
               {"op": "sleep", "ms": True}, {"op": "call", "tool": "echo", "arguments": {}, "retries": 0.5},
               {"op": "read"}, {"op": "sleep"}, {"op": "call", "arguments": {}},
               {"op": "listTools", "timeoutMs": float("inf")}]
        for step in bad:
            with self.subTest(step=step), self.assertRaises(UsageError):
                parse_script({"steps": [step]}, {})
        for script in ({"steps": [], "unknown": 1}, {"steps": {}}, [], {"steps": [], "description": 2}, {"steps": [], "description": "${missing}"}):
            with self.assertRaises(UsageError):
                parse_script(script, {})
