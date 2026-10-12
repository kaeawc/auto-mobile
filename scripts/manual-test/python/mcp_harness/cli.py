from __future__ import annotations
import argparse
import asyncio
import json
import math
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Awaitable, Callable
from .client import Options, Summary, run_client
from .close_result import worst_exit
from .evidence import Evidence
from .guard import GuardRefusal, Runner, check_calls, resolve_launch
from .launch import LaunchSpec, fake_launch
from .script import Script, UsageError, load_script

MODES = ("normal", "after-server-exit", "mid-call", "sigterm-server", "kill-server")

def nonnegative(value: str) -> float:
    number = float(value)
    if not math.isfinite(number) or number < 0:
        raise argparse.ArgumentTypeError("must be finite and nonnegative")
    return number

def parser(two: bool = False) -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(allow_abbrev=False, description="Private-daemon-only official Python MCP stdio harness")
    launch = p.add_mutually_exclusive_group(required=True)
    launch.add_argument("--batch-dir")
    launch.add_argument("--fake-server", action="store_true")
    p.add_argument("--daemon")
    p.add_argument("--fake-env", action="append", default=[])
    p.add_argument("--out-dir", required=True)
    p.add_argument("--allow-selector", action="store_true")
    for flag, default in (("server-exit-wait-ms", 5000), ("mid-call-delay-ms", 200),
                          ("step-timeout-ms", 60000), ("close-timeout-ms", 30000)):
        p.add_argument("--" + flag, type=nonnegative, default=default)
    if two:
        p.add_argument("--script")
        p.add_argument("--script-a")
        p.add_argument("--script-b")
        p.add_argument("--var-a", action="append", default=[])
        p.add_argument("--var-b", action="append", default=[])
        p.add_argument("--lifetimes", type=int, default=1)
        p.add_argument("--close-order", choices=("a-first", "b-first", "simultaneous"), default="a-first")
        p.add_argument("--stagger-ms", type=nonnegative, default=0)
        for name in ("a", "b"):
            p.add_argument("--close-mode-" + name, choices=MODES, default="normal")
    else:
        p.add_argument("--script", required=True)
        p.add_argument("--var", action="append", default=[])
        p.add_argument("--name", default="A")
        p.add_argument("--close-mode", choices=MODES, default="normal")
    return p

def assignments(values: list[str]) -> dict[str, str]:
    result: dict[str, str] = {}
    for value in values:
        key, sep, text = value.partition("=")
        if not sep or not key or "\x00" in value:
            raise UsageError("Assignments must be nonempty k=v without NUL")
        result[key] = text
    return result

def validate_args(args: argparse.Namespace, two: bool = False) -> None:
    if not Path(args.out_dir).is_absolute():
        raise UsageError("--out-dir must be absolute")
    if args.batch_dir:
        if not args.daemon or args.fake_env:
            raise UsageError("--batch-dir requires --daemon and forbids --fake-env")
    elif args.daemon:
        raise UsageError("--daemon requires --batch-dir")
    if two:
        if bool(args.script) == bool(args.script_a or args.script_b) or (not args.script and not (args.script_a and args.script_b)):
            raise UsageError("Use --script OR both --script-a and --script-b")
        if args.lifetimes < 1:
            raise UsageError("--lifetimes must be positive")
    elif not re.fullmatch(r"[A-Za-z0-9_-]+", args.name):
        raise UsageError("--name must contain only letters, digits, underscore or hyphen")
    assignments(args.fake_env)

def options(args: argparse.Namespace, mode: str) -> Options:
    return Options(mode, args.server_exit_wait_ms, args.mid_call_delay_ms, args.step_timeout_ms, args.close_timeout_ms)

def prepare(args: argparse.Namespace, two: bool, runner: Runner) -> tuple[LaunchSpec, list[Script]]:
    validate_args(args, two)
    if two:
        scripts = [load_script(Path(args.script or args.script_a), assignments(args.var_a)),
                   load_script(Path(args.script or args.script_b), assignments(args.var_b))]
        modes = [args.close_mode_a, args.close_mode_b]
    else:
        scripts = [load_script(Path(args.script), assignments(args.var))]
        modes = [args.close_mode]
    for script, mode in zip(scripts, modes):
        if mode == "mid-call" and not any(s["op"] in ("call", "read") for s in script.steps):
            raise UsageError("mid-call requires a call or read step")
    if args.fake_server:
        check_calls(scripts, args.allow_selector, runner)
        return fake_launch(assignments(args.fake_env)), scripts
    return resolve_launch(args.batch_dir, args.daemon, scripts, args.allow_selector, runner), scripts

def emit(value: dict[str, Any]) -> None:
    print(json.dumps(value, ensure_ascii=False), flush=True)

async def one(args: argparse.Namespace, launch: LaunchSpec, script: Script) -> int:
    evidence = Evidence(Path(args.out_dir), args.name)
    try:
        result = await run_client(launch, script, evidence, options(args, args.close_mode), emit)
        emit({"event": "summary", **result.json()})
        return result.exit_code
    finally:
        evidence.close()

class Pair:
    def __init__(self, order: str, stagger_ms: float) -> None:
        self.order, self.stagger_ms = order, stagger_ms
        self.ready = [asyncio.Event(), asyncio.Event()]
        self.done = [asyncio.Event(), asyncio.Event()]
        self.barrier = [asyncio.Event(), asyncio.Event()]

    def participant(self, index: int) -> Participant:
        return Participant(self, index)

class Participant:
    def __init__(self, pair: Pair, index: int) -> None:
        self.pair, self.index = pair, index

    async def initialized(self) -> None:
        self.pair.ready[self.index].set()
        await self.pair.ready[1-self.index].wait()

    async def before_close(self) -> bool:
        p, i = self.pair, self.index
        if p.order == "simultaneous":
            p.barrier[i].set()
            await p.barrier[1-i].wait()
            # Both resume from the same barrier tick; B alone receives the requested offset.
            await asyncio.sleep(p.stagger_ms / 1000 if i == 1 else 0)
            return False
        first = 0 if p.order == "a-first" else 1
        if i == first:
            return False
        await p.done[first].wait()
        await asyncio.sleep(p.stagger_ms / 1000)
        return True

    def closed(self) -> None:
        p, i = self.pair, self.index
        p.ready[i].set()
        p.barrier[i].set()
        p.done[i].set()

async def two(args: argparse.Namespace, launch: LaunchSpec, scripts: list[Script]) -> int:
    rows: list[dict[str, Any]] = []
    for lifetime in range(1, args.lifetimes + 1):
        directory = Path(args.out_dir) / f"lifetime-{lifetime:03d}"
        pair = Pair(args.close_order, args.stagger_ms)
        async def client(index: int) -> Summary:
            evidence = Evidence(directory, "AB"[index])
            try:
                return await run_client(launch, scripts[index], evidence,
                                        options(args, (args.close_mode_a, args.close_mode_b)[index]),
                                        emit, pair.participant(index))
            finally:
                evidence.close()
        results = await asyncio.gather(asyncio.create_task(client(0)), asyncio.create_task(client(1)))
        rows.extend({"lifetime": lifetime, **r.json()} for r in results)
    print("lifetime client steps-ok/total retries close classification leaves close-ms server-exit", flush=True)
    for row in rows:
        close = row["close"]
        print(f'{row["lifetime"]} {row["client"]} {row["stepsOk"]}/{row["stepsOk"]+row["stepsFailed"]} '
              f'{row["retriedAttempts"]} {close["status"]} {close["classification"]} '
              f'{",".join(close["leaves"]) or "-"} {close["elapsedMs"]:.1f} {row["serverExitCode"]}', flush=True)
    code = worst_exit([r["exitCode"] for r in rows])
    emit({"event": "summary", "lifetimes": args.lifetimes, "clients": rows, "exitCode": code})
    return code

def main(argv: list[str] | None = None, *, is_two: bool = False, runner: Runner = subprocess.run,
         run: Callable[[Awaitable[int]], int] = asyncio.run) -> int:
    p = parser(is_two)
    args = p.parse_args(argv)
    try:
        launch, scripts = prepare(args, is_two, runner)
        return run(two(args, launch, scripts) if is_two else one(args, launch, scripts[0]))
    except (UsageError, GuardRefusal, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
