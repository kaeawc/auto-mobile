"""Strict step scripts; substitution happens before a launch is considered."""
from __future__ import annotations
import json
import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

class UsageError(ValueError):
    """Invalid input; nothing may be spawned."""

@dataclass(frozen=True)
class Script:
    steps: list[dict[str, Any]]
    after_peer_closed: list[dict[str, Any]]
    path: Path

    def calls(self) -> list[dict[str, Any]]:
        return [{"tool": s["tool"], "arguments": s["arguments"]}
                for s in self.steps + self.after_peer_closed if s["op"] == "call"]

_KEYS = {
    "listTools": {"op", "timeoutMs", "label"},
    "call": {"op", "tool", "arguments", "timeoutMs", "retries", "retryDelayMs", "label"},
    "read": {"op", "uri", "timeoutMs", "label"},
    "sleep": {"op", "ms", "label"},
}

def substitute(value: Any, variables: Mapping[str, str]) -> Any:
    if isinstance(value, str):
        def replace(match: re.Match[str]) -> str:
            key = match.group(1)
            if key not in variables:
                raise UsageError(f"Missing variable: {key}")
            return variables[key]
        return re.sub(r"\$\{([^}]+)\}", replace, value)
    if isinstance(value, list):
        return [substitute(v, variables) for v in value]
    if isinstance(value, dict):
        return {k: substitute(v, variables) for k, v in value.items()}
    return value

def parse_script(document: Any, variables: Mapping[str, str], path: Path = Path("<inline>")) -> Script:
    if not isinstance(document, dict) or set(document) - {"description", "steps", "afterPeerClosed"}:
        raise UsageError("Script must be an object with only description, steps, afterPeerClosed")
    if "description" in document and not isinstance(document["description"], str):
        raise UsageError("description must be a string")
    substitute(document.get("description", ""), variables)
    def steps(value: Any) -> list[dict[str, Any]]:
        if not isinstance(value, list):
            raise UsageError("steps must be an array")
        result: list[dict[str, Any]] = []
        for raw in value:
            if not isinstance(raw, dict) or not isinstance(raw.get("op"), str) or raw["op"] not in _KEYS:
                raise UsageError("Unknown or missing op")
            if set(raw) - _KEYS[raw["op"]]:
                raise UsageError("Unknown step key")
            s = substitute(raw, variables)
            for key in ("label", "tool", "uri"):
                if key in s and (not isinstance(s[key], str) or not s[key]):
                    raise UsageError(f"{key} must be a nonempty string")
            for key in ("timeoutMs", "retryDelayMs", "ms", "retries"):
                if key in s and (isinstance(s[key], bool) or not isinstance(s[key], (int, float))
                                 or not math.isfinite(s[key]) or s[key] < 0):
                    raise UsageError(f"{key} must be finite and nonnegative")
            if "retries" in s and not isinstance(s["retries"], int):
                raise UsageError("retries must be an integer")
            if s["op"] == "call" and ("tool" not in s or not isinstance(s.get("arguments"), dict)):
                raise UsageError("call requires tool and object arguments")
            if s["op"] == "read" and "uri" not in s:
                raise UsageError("read requires uri")
            if s["op"] == "sleep" and "ms" not in s:
                raise UsageError("sleep requires ms")
            result.append(s)
        return result
    return Script(steps(document.get("steps")), steps(document.get("afterPeerClosed", [])), path)

def load_script(path: Path, variables: Mapping[str, str]) -> Script:
    try:
        return parse_script(json.loads(path.read_text()), variables, path)
    except (OSError, json.JSONDecodeError) as exc:
        raise UsageError(str(exc)) from exc
