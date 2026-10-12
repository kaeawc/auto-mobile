from __future__ import annotations
import json
import unittest
from pathlib import Path
from unittest.mock import Mock
from mcp_harness.evidence import Evidence
from tests.support import tempdir

class EvidenceTests(unittest.TestCase):
    def test_request_response_records_fsync_each_time(self) -> None:
        with tempdir() as tmp:
            fsync = Mock()
            evidence = Evidence(Path(tmp), "A", fsync=fsync)
            try:
                for index in range(10):
                    evidence.record("request" if index % 2 == 0 else "response")
                    self.assertEqual(fsync.call_count, index + 1)
                    self.assertEqual(len((Path(tmp)/"A.jsonl").read_text().splitlines()), index + 1)
            finally:
                evidence.close()
            self.assertEqual(fsync.call_count, 11)

    def test_notifications_flush_each_record_and_fsync_every_hundred_then_close(self) -> None:
        with tempdir() as tmp:
            fsync = Mock()
            evidence = Evidence(Path(tmp), "A", fsync=fsync)
            try:
                for index in range(250):
                    evidence.record("notification", index=index)
                    self.assertEqual(fsync.call_count, (index + 1) // 100)
                    records = (Path(tmp)/"A.jsonl").read_text().splitlines()
                    self.assertEqual(len(records), index + 1)
                    self.assertEqual(json.loads(records[-1])["index"], index)
            finally:
                evidence.close()
            self.assertEqual(fsync.call_count, 3)
            evidence.close()
            self.assertEqual(fsync.call_count, 3)
