"""Bounded fake stdio server using the installed SDK's server API."""
from __future__ import annotations
import argparse
import asyncio
import json
import os
import signal
import threading
import time
from typing import Any
try:
    from mcp.server.fastmcp import FastMCP
except ImportError:
    from mcp.server.mcpserver import MCPServer as FastMCP

server = FastMCP("python-harness-fake")
NOTE = b'{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n'
counts: dict[str, int] = {}
if os.environ.get("FAKE_IGNORE_SIGTERM") == "1":
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
# A hard self-expiry also bounds sync tools and ignored EOF/SIGTERM.
expiry = threading.Timer(60, lambda: os._exit(0))
expiry.daemon = True
expiry.start()

def later(delay_ms: int, action: Any) -> None:
    timer = threading.Timer(max(0, delay_ms) / 1000, action)
    timer.daemon = True
    timer.start()

def spam(interval_ms: int, count: int) -> None:
    deadline = time.monotonic() + 60
    for _ in range(max(0, count)):
        if time.monotonic() >= deadline:
            return
        try:
            os.write(1, NOTE)
        except OSError:
            return
        if interval_ms > 0:
            time.sleep(interval_ms / 1000)

@server.tool()
def startDevice(platform: str, deviceId: str) -> dict[str, str]:
    return {"platform": platform, "deviceId": deviceId, "sessionUuid": "fake-session"}

@server.tool()
def echo(text: str) -> str:
    return text

@server.tool()
def pid() -> int:
    return os.getpid()

@server.tool()
def slow(seconds: float = 0.3) -> str:
    time.sleep(min(60, max(0, seconds)))
    return "slow done"

@server.tool()
def hang(seconds: float = 60) -> str:
    time.sleep(min(60, max(0, seconds)))
    return "hang done"

@server.tool()
def exit_now(code: int = 0) -> str:
    os._exit(code)

@server.tool()
def exit_after_reply(delay_ms: int = 50, code: int = 0) -> str:
    later(delay_ms, lambda: os._exit(code))
    return "exiting"

@server.tool()
def close_stdout_after_reply(delay_ms: int = 50) -> str:
    later(delay_ms, lambda: os.close(1))
    return "closing stdout"

@server.tool()
async def notify_spam(interval_ms: int = 2, count: int = 2000, start_delay_ms: int = 20) -> str:
    # Let the SDK send the tool reply before a zero-interval producer floods stdout.
    asyncio.get_running_loop().call_later(
        max(0, start_delay_ms) / 1000,
        lambda: threading.Thread(target=spam, args=(interval_ms, count), daemon=True).start())
    return "spamming"

@server.tool()
def flaky(key: str, fail_times: int = 1) -> str:
    counts[key] = counts.get(key, 0) + 1
    if counts[key] <= fail_times:
        raise ValueError(f"flaky {key} attempt {counts[key]}")
    return f"ok {key} attempt {counts[key]}"

@server.tool()
def sendKeys(commands: list[dict[str, Any]], device: str = "") -> dict[str, Any]:
    return {"commands": commands, "device": device}

@server.tool()
def observe(deviceId: str = "", device: str = "") -> dict[str, str]:
    return {"deviceId": deviceId, "device": device, "status": "fake editor focused"}

@server.resource("automobile:devices/booted")
def booted() -> str:
    return "fake device booted"

@server.resource("fake://status")
def status() -> str:
    return "ready"

if __name__ == "__main__":
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument("--advertise-session", type=json.loads)
    args = parser.parse_args()
    if args.advertise_session is not None:
        if not isinstance(args.advertise_session, dict):
            parser.error("--advertise-session requires a JSON object")
        # Preserve the installed SDK's normal capability calculation and add the
        # same experimental key used by the broker proxy at initialize.
        original_capabilities = server._mcp_server.get_capabilities
        def capabilities(*positional: Any, **keyword: Any) -> Any:
            result = original_capabilities(*positional, **keyword)
            result.experimental = dict(result.experimental or {})
            result.experimental["automobile/session"] = args.advertise_session
            return result
        server._mcp_server.get_capabilities = capabilities
    try:
        server.run()
    finally:
        on_eof = os.environ.get("FAKE_ON_EOF", "exit")
        if on_eof.startswith("write-then-exit:"):
            spam(10, int(on_eof.split(":", 1)[1]))
        elif on_eof == "ignore":
            time.sleep(60)
        if on_eof != "exit":
            os._exit(0)
