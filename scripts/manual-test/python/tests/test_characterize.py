from __future__ import annotations
import importlib.metadata as md
import json
import subprocess
import sys
import unittest
from pathlib import Path
from mcp_harness.orderings import ORDERINGS
from tests.support import tempdir

class CharacterizeTests(unittest.TestCase):
    def test_json_smoke_reports_actual_status_and_shared_expectations(self) -> None:
        with tempdir() as tmp:
            result = subprocess.run([sys.executable, str(Path(__file__).resolve().parents[1]/"characterize_close.py"),
                "--json", "--only", "normal", "--only", "server-writes-after-stdin-eof",
                "--only", "two-clients-exit-stack-non-lifo", "--only", "close-in-other-task", "--timeout-seconds", "3", "--out-dir", tmp],
                capture_output=True, text=True, timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr)
            value = json.loads(result.stdout)
            self.assertIn(md.version("mcp"), value["identity"])
            self.assertEqual(len(value["rows"]), 4)
            major = int(md.version("mcp").split(".")[0])
            for row in value["rows"]:
                self.assertIn(row["outcome"], ("CLOSE_OK", "CLOSE_RAISED", "CLOSE_HANG"))
                self.assertEqual(row["expected"], list(ORDERINGS[row["ordering"]].expected[major]))
                self.assertIn(row["outcome"], row["expected"])
