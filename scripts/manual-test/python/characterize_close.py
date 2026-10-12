#!/usr/bin/env python3
"""Fresh child per ordering; parent deadlines bound even invalid cancel-scope callers."""
from __future__ import annotations
import argparse
import asyncio
import importlib.metadata as md
import json
import math
import os
import signal
import subprocess
import sys
import tempfile
import time
from contextlib import AsyncExitStack
from pathlib import Path
from typing import Any
from mcp import ClientSession
from mcp.client.stdio import stdio_client
from mcp_harness.client import Capture, Options, run_client
from mcp_harness.close_result import classify_close
from mcp_harness.evidence import Evidence
from mcp_harness.launch import fake_launch
from mcp_harness.orderings import ORDERINGS
from mcp_harness.script import parse_script

def call(tool: str, **arguments: Any) -> dict[str, Any]:
    return {"op": "call", "tool": tool, "arguments": arguments}

def scenario(name: str) -> tuple[list[dict[str, Any]], dict[str, str], Options, dict[str, Any]]:
    steps, env, mode, extra = [call("echo", text="a")], {}, "normal", {}
    if name.startswith("server-exits-then"):
        steps = [call("exit_after_reply", delay_ms=20, code=0), {"op": "sleep", "ms": 200}]
        if name == "server-exits-then-call":
            steps.append(call("echo", text="after exit"))
    elif name == "server-exits-during-call":
        steps = [call("exit_now", code=7)]
    elif name in ("mid-call-cancel", "mid-call-leave-contexts", "late-response-after-leave", "caller-cancellation"):
        steps = [call("slow", seconds=0.3)] if name == "late-response-after-leave" else [call("hang", seconds=30)]
        mode = "mid-call"
        if name == "mid-call-cancel": extra["cancel_in_flight"] = True
        if name == "caller-cancellation": extra["cancel_caller"] = True
    elif name in ("sigterm-then-close", "sigkill-then-close"):
        mode = "sigterm-server" if name.startswith("sigterm") else "kill-server"
    elif name == "server-closes-stdout-then-close":
        steps = [call("close_stdout_after_reply", delay_ms=20), {"op": "sleep", "ms": 200}]
        env = {"FAKE_ON_EOF": "ignore"}
    elif name in ("server-ignores-stdin-eof", "server-ignores-eof-and-sigterm"):
        env = {"FAKE_ON_EOF": "ignore"}
        if name.endswith("sigterm"): env["FAKE_IGNORE_SIGTERM"] = "1"
    elif name in ("notification-spam-then-close", "session-closed-transport-open-spam"):
        steps = [call("notify_spam", interval_ms=0, count=1000000), {"op": "sleep", "ms": 50}]
        if name.startswith("session"): extra["session_gap_ms"] = 300
    elif name == "server-writes-after-stdin-eof":
        env = {"FAKE_ON_EOF": "write-then-exit:20"}
    elif name == "earlier-application-exception":
        extra["application_error"] = True
    return steps, env, Options(mode, 2000, 100, 3000, 8000), extra

async def misuse(name: str, directory: Path) -> dict[str, Any]:
    stacks: list[AsyncExitStack] = []
    captures: list[Capture] = []
    evidences: list[Evidence] = []
    started = time.monotonic()
    exc: BaseException | None = None
    try:
        for index in range(2 if name.startswith("two") else 1):
            evidence = Evidence(directory, f"misuse-{index}")
            evidences.append(evidence)
            capture = Capture()
            captures.append(capture)
            stack = AsyncExitStack()
            stacks.append(stack)
            transport = stdio_client(fake_launch({}).parameters())
            streams = await capture.enter(transport)
            stack.push_async_exit(transport)
            evidence.record("spawn", pid=capture.process.pid if capture.process else None)
            if capture.process:
                async def record_exit(process: Any, log: Evidence) -> None:
                    await process.wait()
                    log.record("server-exit", code=process.returncode)
                asyncio.create_task(record_exit(capture.process, evidence))
            session = await stack.enter_async_context(ClientSession(*streams))
            await session.initialize()
            await session.call_tool("echo", {"text": "a"})
        started = time.monotonic()
        for evidence in evidences:
            evidence.record("close-start")
        if name == "close-in-other-task":
            await asyncio.create_task(stacks[0].aclose())
        else:
            await stacks[0].aclose()
            await stacks[1].aclose()
    except BaseException as error:
        exc = error
    finally:
        for capture in captures:
            if capture.process:
                capture.signal(signal.SIGKILL)
        for evidence in evidences:
            evidence.close()
    return {"close": classify_close(exc, (time.monotonic()-started)*1000).json()}

async def child(name: str, directory: Path) -> dict[str, Any]:
    if name in ("two-clients-exit-stack-non-lifo", "close-in-other-task"):
        return await misuse(name, directory)
    steps, env, options, extra = scenario(name)
    path = directory / "script.json"
    path.write_text(json.dumps({"steps": steps}))
    script = parse_script({"steps": steps}, {}, path)
    async def lifetime(client_name: str, delay: float = 0) -> dict[str, Any]:
        evidence = Evidence(directory, client_name)
        try:
            if delay:
                await asyncio.sleep(delay)
            result = await run_client(fake_launch(env), script, evidence, options, lambda _: None, **extra)
            return result.json()
        finally:
            evidence.close()
    if name == "two-clients-own-tasks":
        results = await asyncio.gather(asyncio.create_task(lifetime("A")), asyncio.create_task(lifetime("B", 0.05)))
        raised = [r for r in results if r["close"]["status"] != "CLOSE_OK"]
        return (raised or results)[0]
    return await lifetime("A")

def reap_recorded_children(directory: Path) -> None:
    # Only spawn records produced by this fresh harness child, never tool-returned or guessed PIDs.
    for path in directory.glob("*.jsonl"):
        for line in path.read_text().splitlines():
            record = json.loads(line)
            pid = record.get("pid")
            if record.get("event") == "spawn" and isinstance(pid, int) and pid > 0:
                exited = any(json.loads(l).get("event") == "server-exit" and json.loads(l).get("code") is not None
                             for l in path.read_text().splitlines())
                if not exited:
                    try:
                        os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass  # This recorded fake child has already exited.

def measure(name: str, directory: Path, timeout: float) -> dict[str, Any]:
    directory.mkdir(mode=0o700)
    started = time.monotonic()
    with (directory / "child.stderr.log").open("w") as stderr:
        process = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--child", name,
                                    "--out-dir", str(directory)], stdout=subprocess.PIPE, stderr=stderr, text=True)
        try:
            stdout, _ = process.communicate(timeout=timeout)
            try:
                result = json.loads(stdout)
                close = result["close"]
            except (ValueError, KeyError, TypeError) as exc:
                close = classify_close(RuntimeError(f"Characterization child exited {process.returncode}: {exc}"),
                                       (time.monotonic()-started)*1000).json()
                result = {"close": close}
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate(timeout=2)
            reap_recorded_children(directory)
            close_started = max((json.loads(line)["monotonicAbsoluteMs"] for path in directory.glob("*.jsonl")
                                 for line in path.read_text().splitlines()
                                 if json.loads(line).get("event") == "close-start"), default=started*1000)
            close = classify_close(None, time.monotonic()*1000-close_started, True).json()
            result = {"close": close}
    reap_recorded_children(directory)
    major = int(md.version("mcp").split(".")[0])
    return {"ordering": name, "description": ORDERINGS[name].description,
            "outcome": close["status"], "leaves": close["leaves"], "closeMs": close["elapsedMs"],
            "classification": close["classification"], "expected": list(ORDERINGS[name].expected[major]),
            "matchesExpected": close["status"] in ORDERINGS[name].expected[major], "evidenceDir": str(directory),
            "firstStepFailure": result.get("firstStepFailure")}

def main() -> int:
    p = argparse.ArgumentParser(allow_abbrev=False)
    p.add_argument("--json", action="store_true")
    p.add_argument("--only", action="append", choices=list(ORDERINGS))
    p.add_argument("--child", choices=list(ORDERINGS), help=argparse.SUPPRESS)
    p.add_argument("--out-dir")
    p.add_argument("--timeout-seconds", type=float, default=12)
    args = p.parse_args()
    if args.timeout_seconds <= 0 or not math.isfinite(args.timeout_seconds):
        p.error("--timeout-seconds must be finite and positive")
    if args.out_dir and not Path(args.out_dir).is_absolute():
        p.error("--out-dir must be absolute")
    if args.child:
        async def execute() -> None:
            result = await child(args.child, Path(args.out_dir))
            print(json.dumps(result), flush=True)
            # Deliberately invalid cancel scopes may make asyncio shutdown hang. The parent
            # owns this interpreter and reaps only fake PIDs in its spawn evidence.
            os._exit(0)
        asyncio.run(execute())
        return 0
    root = Path(__file__).resolve().parents[3] / "scratch/pyharness"
    root.mkdir(parents=True, exist_ok=True)
    directory = Path(args.out_dir) if args.out_dir else Path(tempfile.mkdtemp(prefix="characterize-", dir=root))
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    identity = f"Python {sys.version.split()[0]} | mcp {md.version('mcp')} | anyio {md.version('anyio')} | pydantic {md.version('pydantic')}"
    rows = [measure(name, directory / name, args.timeout_seconds) for name in args.only or ORDERINGS]
    if args.json:
        print(json.dumps({"identity": identity, "rows": rows}))
    else:
        print(identity)
        print("| ordering | outcome | leaf exception classes | close ms |")
        print("|---|---|---|---:|")
        for row in rows:
            print(f'| {row["ordering"]} | {row["outcome"]} | {", ".join(row["leaves"]) or "—"} | {row["closeMs"]:.1f} |')
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
