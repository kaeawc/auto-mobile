from __future__ import annotations
import sys
from dataclasses import dataclass
from pathlib import Path
from mcp import StdioServerParameters

@dataclass(frozen=True)
class LaunchSpec:
    command: str
    args: list[str]
    env: dict[str, str]

    def parameters(self) -> StdioServerParameters:
        return StdioServerParameters(command=self.command, args=self.args, env=self.env)

def fake_launch(env: dict[str, str]) -> LaunchSpec:
    return LaunchSpec(sys.executable, [str(Path(__file__).resolve().parents[1] / "fake_mcp_server.py")], env)
