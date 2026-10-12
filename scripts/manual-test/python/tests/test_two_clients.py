from __future__ import annotations
import asyncio
import contextlib
import io
import json
import unittest
from pathlib import Path
from mcp_harness.cli import parser, prepare, two
from mcp_harness.close_result import worst_exit
from tests.support import call, guard_ok, tempdir

class PairTests(unittest.TestCase):
    def test_two_lifetimes_overlap_and_peer_remains_usable(self) -> None:
        with tempdir() as tmp:
            path = Path(tmp) / "steps.json"
            path.write_text(json.dumps({"steps": [call("echo", text="overlap"), {"op": "sleep", "ms": 80}],
                                        "afterPeerClosed": [call("echo", text="after peer")]}))
            args = parser(True).parse_args(["--fake-server", "--script", str(path), "--out-dir", tmp,
                                           "--lifetimes", "2", "--close-order", "a-first", "--stagger-ms", "5"])
            launch, scripts = prepare(args, True, guard_ok)
            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout):
                code = asyncio.run(two(args, launch, scripts))
            self.assertEqual(code, 0)
            self.assertEqual(len([l for l in stdout.getvalue().splitlines() if l.startswith("1 A ") or l.startswith("1 B ") or l.startswith("2 A ") or l.startswith("2 B ")]), 4)
            for lifetime in (1, 2):
                directory = Path(tmp) / f"lifetime-{lifetime:03d}"
                a, b = [[json.loads(l) for l in (directory/f"{name}.jsonl").read_text().splitlines()] for name in "AB"]
                window = lambda rows: (rows[0]["monotonicAbsoluteMs"], next(r for r in rows if r["event"] == "close")["monotonicAbsoluteMs"])
                self.assertLess(max(window(a)[0], window(b)[0]), min(window(a)[1], window(b)[1]))
                a_close = next(r for r in a if r["event"] == "close")
                after = next(r for r in b if r["event"] == "request" and r["step"].get("arguments", {}).get("text") == "after peer")
                self.assertGreater(after["monotonicAbsoluteMs"], a_close["monotonicAbsoluteMs"])

    def test_simultaneous_and_b_first(self) -> None:
        for order in ("simultaneous", "b-first"):
            with tempdir() as tmp:
                path = Path(tmp) / "steps.json"
                path.write_text(json.dumps({"steps": [call("echo", text="x")], "afterPeerClosed": [call("echo", text="peer")] }))
                args = parser(True).parse_args(["--fake-server", "--script", str(path), "--out-dir", tmp, "--close-order", order])
                launch, scripts = prepare(args, True, guard_ok)
                with contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(asyncio.run(two(args, launch, scripts)), 0)
                rows = [[json.loads(l) for l in (Path(tmp)/"lifetime-001"/f"{name}.jsonl").read_text().splitlines()] for name in "AB"]
                self.assertTrue(all(any(r["event"] == "close" for r in records) for records in rows))
                if order == "b-first":
                    a_request = next(r for r in rows[0] if r["event"] == "request" and r["index"] == 1)
                    b_close = next(r for r in rows[1] if r["event"] == "close")
                    self.assertGreater(a_request["monotonicAbsoluteMs"], b_close["monotonicAbsoluteMs"])

    def test_precedence(self) -> None:
        self.assertEqual(worst_exit([0, 1, 3, 2]), 2)
