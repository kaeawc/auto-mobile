from __future__ import annotations
import asyncio
import contextlib
import io
import json
import subprocess
import tempfile
from pathlib import Path
from typing import Any
from mcp_harness.client import Options, Summary, run_client
from mcp_harness.evidence import Evidence
from mcp_harness.launch import fake_launch
from mcp_harness.script import parse_script

ROOT = Path(__file__).resolve().parents[4]
SCRATCH = ROOT / "scratch/pyharness"
SCRATCH.mkdir(parents=True, exist_ok=True)

def tempdir() -> tempfile.TemporaryDirectory[str]:
    return tempfile.TemporaryDirectory(dir=SCRATCH, prefix="tests-")

def guard_ok(args: Any, **kwargs: Any) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(args, 0, '{"ok":true}\n', '')

def call(tool: str, **arguments: Any) -> dict[str, Any]:
    return {"op": "call", "tool": tool, "arguments": arguments}

def run_fake(directory: Path, steps: list[dict[str, Any]], env: dict[str, str] | None = None,
             mode: str = "normal", options: Options | None = None, **extras: Any) -> tuple[Summary, list[dict[str, Any]], list[dict[str, Any]]]:
    path = directory / "steps.json"
    path.write_text(json.dumps({"steps": steps}))
    script = parse_script({"steps": steps}, {}, path)
    events: list[dict[str, Any]] = []
    evidence = Evidence(directory, "A")
    try:
        with contextlib.redirect_stderr(io.StringIO()):
            result = asyncio.run(run_client(fake_launch(env or {}), script, evidence,
                                           (options or Options(mode, 20000, 100, 20000, 20000, 60000)), events.append, **extras))
    finally:
        evidence.close()
    records = [json.loads(s) for s in (directory / "A.jsonl").read_text().splitlines()]
    return result, records, events
