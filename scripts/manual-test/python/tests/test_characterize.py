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
                "--only", "two-clients-exit-stack-non-lifo", "--timeout-seconds", "30", "--out-dir", tmp],
                capture_output=True, text=True, timeout=60)
            self.assertEqual(result.returncode, 0, result.stderr)
            value = json.loads(result.stdout)
            self.assertIn(md.version("mcp"), value["identity"])
            self.assertEqual(len(value["rows"]), 3)
            major = int(md.version("mcp").split(".")[0])
            for row in value["rows"]:
                self.assertIn(row["outcome"], ("CLOSE_OK", "CLOSE_RAISED", "CLOSE_HANG"))
                self.assertEqual(row["expected"], list(ORDERINGS[row["ordering"]].expected[major]))
                self.assertIn(row["outcome"], row["expected"])

    def test_default_deadline_and_single_reap_on_timeout(self) -> None:
        import contextlib
        import io
        from unittest.mock import Mock, patch
        import characterize_close
        with tempdir() as tmp:
            row = {'ordering': 'normal', 'outcome': 'CLOSE_OK', 'leaves': [], 'closeMs': 0}
            with patch.object(sys, 'argv', ['characterize_close.py', '--only', 'normal', '--out-dir', tmp]), patch('characterize_close.measure', return_value=row) as measure, contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(characterize_close.main(), 0)
            self.assertEqual(measure.call_args.args[2], 30)
            process = Mock()
            process.communicate.side_effect = [subprocess.TimeoutExpired('child', 30), ('', '')]
            with patch('characterize_close.subprocess.Popen', return_value=process), patch('characterize_close.reap_recorded_children') as reap:
                result = characterize_close.measure('normal', Path(tmp)/'ordering', 30)
            self.assertEqual(result['outcome'], 'CLOSE_HANG')
            reap.assert_called_once()

    def test_documentation_uses_own_measurements_for_every_ordering(self) -> None:
        from tests.support import ROOT
        section = (ROOT/'docs/design-docs/manual-test-harness.md').read_text().split('## Python MCP SDK stdio clients')[1]
        self.assertNotIn("driver's fake-server probes", section)
        self.assertIn('pydantic 2.14.1', ' '.join(section.split()))
        self.assertIn('timing dependent', ' '.join(section.split()))
        rows = [tuple(cell.strip() for cell in line.split('|')[1:-1]) for line in section.splitlines() if line.startswith('|')]
        measurements = {row[0]: row for row in rows if row[0] in ORDERINGS}
        self.assertEqual(set(measurements), set(ORDERINGS))
        for name, row in measurements.items():
            self.assertEqual(len(row), 5)
            self.assertIn(row[1], ORDERINGS[name].expected[2])
            self.assertIn(row[2], ORDERINGS[name].expected[1])
            self.assertEqual(row[4], ORDERINGS[name].avoidable_by)
