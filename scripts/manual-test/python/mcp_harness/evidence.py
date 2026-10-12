from __future__ import annotations
import hashlib
import importlib.metadata
import json
import os
import platform
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, TextIO
from .launch import LaunchSpec

class Evidence:
    def __init__(self, directory: Path, name: str) -> None:
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.directory = directory
        self.name = name
        self.started = time.monotonic()
        self.seq = 0
        self.file = self.open_private(directory / f"{name}.jsonl")

    @staticmethod
    def open_private(path: Path, append: bool = True) -> TextIO:
        fd = os.open(path, os.O_WRONLY | (os.O_APPEND if append else os.O_TRUNC) | os.O_CREAT, 0o600)
        os.fchmod(fd, 0o600)
        return os.fdopen(fd, "a", encoding="utf-8")

    def record(self, event: str, **fields: Any) -> None:
        self.seq += 1
        now = time.monotonic()
        self.file.write(json.dumps({"seq": self.seq, "time": datetime.now(timezone.utc).isoformat(),
                                   "monotonicMs": (now - self.started) * 1000,
                                   "monotonicAbsoluteMs": now * 1000, "client": self.name,
                                   "event": event, **fields}, ensure_ascii=False) + "\n")
        self.file.flush()
        os.fsync(self.file.fileno())

    def identity(self, launch: LaunchSpec, mode: str, script_path: Path) -> None:
        value = {"python": sys.version, "platform": platform.platform(),
                 "versions": {k: importlib.metadata.version(k) for k in ("mcp", "anyio", "pydantic")},
                 "command": launch.command, "args": launch.args, "envKeys": sorted(launch.env),
                 "closeMode": mode, "scriptPath": str(script_path),
                 "scriptSha256": hashlib.sha256(script_path.read_bytes()).hexdigest()}
        path = self.directory / f"{self.name}.identity.json"
        with self.open_private(path, append=False) as f:
            f.write(json.dumps(value, indent=2) + "\n")
            f.flush()
            os.fsync(f.fileno())

    def close(self) -> None:
        self.file.close()
