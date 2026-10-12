"""Delegate every real namespace and every device-start decision to TypeScript."""
from __future__ import annotations
import json
import subprocess
from pathlib import Path
from typing import Protocol, Sequence
from .launch import LaunchSpec
from .script import Script

class GuardRefusal(ValueError):
    """Guard unavailable or refusing; fail closed."""

class Runner(Protocol):
    def __call__(self, args: Sequence[str], *, input: str, text: bool,
                 capture_output: bool, timeout: float) -> subprocess.CompletedProcess[str]: ...

HERE = Path(__file__).resolve().parents[1]
REPO = HERE.parents[2]

def _run(args: list[str], scripts: Sequence[Script], allow_selector: bool, runner: Runner) -> dict[str, object]:
    document = {"calls": [c for s in scripts for c in s.calls()], "allowSelector": allow_selector}
    try:
        result = runner(args, input=json.dumps(document), text=True, capture_output=True, timeout=20)
        if result.returncode:
            raise GuardRefusal(result.stderr.strip() or f"Guard exited {result.returncode}")
        lines = result.stdout.splitlines()
        if len(lines) != 1:
            raise GuardRefusal("Guard must return exactly one JSON line")
        value = json.loads(lines[0])
        if not isinstance(value, dict):
            raise GuardRefusal("Guard returned a non-object")
        return value
    except (OSError, subprocess.TimeoutExpired, ValueError) as exc:
        raise GuardRefusal(str(exc)) from exc

def check_calls(scripts: Sequence[Script], allow_selector: bool, runner: Runner = subprocess.run) -> None:
    value = _run(["bun", str(HERE / "harness-guard.ts"), "check-calls"], scripts, allow_selector, runner)
    if value != {"ok": True}:
        raise GuardRefusal("check-calls did not affirm the guard")

def resolve_launch(batch_dir: str, daemon: str, scripts: Sequence[Script], allow_selector: bool,
                   runner: Runner = subprocess.run) -> LaunchSpec:
    value = _run(["bash", str(REPO / "scripts/manual-test/in-daemon-env.sh"), "--batch-dir", batch_dir,
                  "--daemon", daemon, "--", "bun", str(HERE / "harness-guard.ts"), "resolve"],
                 scripts, allow_selector, runner)
    command, args, env = value.get("command"), value.get("args"), value.get("env")
    daemon_info = value.get("daemon")
    if (not isinstance(command, str) or not command or not isinstance(args, list) or len(args) != 1
            or not all(isinstance(a, str) and a for a in args) or not isinstance(env, dict)
            or not all(isinstance(k, str) and isinstance(v, str) for k, v in env.items())
            or not isinstance(daemon_info, dict)
            or not all(isinstance(daemon_info.get(k), str) and daemon_info[k]
                       for k in ("name", "port", "socketPath", "pidFilePath"))):
        raise GuardRefusal("Guard launch is missing or has invalid command/args/env/daemon fields")
    return LaunchSpec(command, args, env)
