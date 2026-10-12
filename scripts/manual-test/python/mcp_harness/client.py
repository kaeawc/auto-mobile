"""One lifetime. SDK contexts are always entered and exited in the owning task."""
from __future__ import annotations
import asyncio
import inspect
import os
import signal
import sys
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Protocol
import anyio
from anyio.abc import Process
from mcp import ClientSession
from mcp.client.stdio import stdio_client
from .close_result import CloseResult, classify_close, exception_json
from .evidence import Evidence
from .launch import LaunchSpec
from .script import Script, UsageError

_CAPTURE_LOCK = asyncio.Lock()
_CAPTURE_LOOP: asyncio.AbstractEventLoop | None = None

@dataclass(frozen=True)
class Options:
    close_mode: str = "normal"
    server_exit_wait_ms: float = 5000
    mid_call_delay_ms: float = 200
    step_timeout_ms: float = 60000
    close_timeout_ms: float = 30000

class Choreography(Protocol):
    async def initialized(self) -> None: ...
    async def before_close(self) -> bool: ...
    def closed(self) -> None: ...

@dataclass
class Summary:
    client: str
    steps_ok: int = 0
    steps_failed: int = 0
    first_step_failure: dict[str, Any] | None = None
    retried_attempts: int = 0
    close: CloseResult = field(default_factory=lambda: classify_close(None, 0))
    server_exit_code: int | None = None
    usage_error: str | None = None

    @property
    def exit_code(self) -> int:
        return 2 if self.usage_error else 3 if self.close.status != "CLOSE_OK" else 1 if self.steps_failed else 0

    def json(self) -> dict[str, Any]:
        return {"client": self.client, "stepsOk": self.steps_ok, "stepsFailed": self.steps_failed,
                "firstStepFailure": self.first_step_failure, "retriedAttempts": self.retried_attempts,
                "close": self.close.json(), "serverExitCode": self.server_exit_code,
                "exitCode": self.exit_code, "usageError": self.usage_error}

class Capture:
    def __init__(self) -> None:
        self.process: Process | None = None

    async def enter(self, transport: Any) -> Any:
        global _CAPTURE_LOCK, _CAPTURE_LOOP
        loop = asyncio.get_running_loop()
        if _CAPTURE_LOOP is not loop:
            _CAPTURE_LOOP, _CAPTURE_LOCK = loop, asyncio.Lock()
        async with _CAPTURE_LOCK:
            original = anyio.open_process
            async def wrapped(*args: Any, **kwargs: Any) -> Process:
                process = await original(*args, **kwargs)
                self.process = process
                return process
            anyio.open_process = wrapped
            try:
                return await transport.__aenter__()
            finally:
                anyio.open_process = original

    def signal(self, sig: int) -> None:
        if self.process is None:
            raise UsageError("SDK process capture failed; cannot signal an uncaptured child")
        # A retained process handle and returncode prevent signaling an already reaped/reused pid.
        if self.process.returncode is None:
            try:
                os.kill(self.process.pid, sig)
            except ProcessLookupError:
                pass  # A child may exit between checking its handle and signaling it.

    async def wait(self, evidence: Evidence, timeout_ms: float) -> None:
        if self.process is None:
            raise UsageError("SDK process capture failed; cannot wait for an uncaptured child")
        started = time.monotonic()
        try:
            if timeout_ms == 0 and self.process.returncode is None:
                evidence.record("server-exit", timedOut=True, code=None, elapsedMs=0)
                return
            await asyncio.wait_for(self.process.wait(), timeout_ms / 1000)
            evidence.record("server-exit", code=self.process.returncode, elapsedMs=(time.monotonic()-started)*1000)
        except asyncio.TimeoutError:
            evidence.record("server-exit", timedOut=True, code=self.process.returncode,
                            elapsedMs=(time.monotonic()-started)*1000)

async def run_step(session: ClientSession, step: dict[str, Any], index: int, evidence: Evidence,
                   options: Options, summary: Summary, emit: Callable[[dict[str, Any]], None],
                   in_flight: bool = False) -> dict[str, Any]:
    started = time.monotonic()
    error: str | None = None
    attempts = 0
    ok = False
    for attempt in range(1, step.get("retries", 0) + 2):
        attempts = attempt
        evidence.record("request", index=index, attempt=attempt, step=step, inFlightAtClose=in_flight)
        try:
            async def request() -> Any:
                if step["op"] == "call":
                    return await session.call_tool(step["tool"], step["arguments"])
                if step["op"] == "read":
                    return await session.read_resource(step["uri"])
                if step["op"] == "listTools":
                    return await session.list_tools()
                await asyncio.sleep(step["ms"] / 1000)
                return None
            result = await asyncio.wait_for(request(), step.get("timeoutMs", options.step_timeout_ms) / 1000)
            payload = result.model_dump(mode="json", by_alias=True) if result is not None else None
            ok = not bool(payload.get("isError", False)) if isinstance(payload, dict) else True
            error = None if ok else str(payload)
            evidence.record("response", index=index, attempt=attempt, response=payload, ok=ok,
                            inFlightAtClose=in_flight)
        except BaseException as exc:
            error = f"{type(exc).__name__}: {exc}"
            evidence.record("exception", index=index, attempt=attempt, exception=exception_json(exc),
                            inFlightAtClose=in_flight)
            if isinstance(exc, (asyncio.CancelledError, KeyboardInterrupt, SystemExit)):
                break
        if ok or attempt > step.get("retries", 0):
            break
        await asyncio.sleep(step.get("retryDelayMs", 250) / 1000)
    event = {"client": summary.client, "event": "step", "index": index, "op": step["op"],
             "label": step.get("label"), "ok": ok, "attempts": attempts,
             "elapsedMs": (time.monotonic()-started)*1000, "error": error[:300] if error else None}
    summary.steps_ok += int(ok)
    summary.steps_failed += int(not ok)
    summary.retried_attempts += max(0, attempts - 1)
    if not ok and summary.first_step_failure is None:
        summary.first_step_failure = event
    emit(event)
    return event

async def run_client(launch: LaunchSpec, script: Script, evidence: Evidence, options: Options,
                     emit: Callable[[dict[str, Any]], None], choreography: Choreography | None = None,
                     session_gap_ms: float = 0, cancel_in_flight: bool = False,
                     application_error: bool = False, cancel_caller: bool = False) -> Summary:
    summary = Summary(evidence.name)
    capture = Capture()
    evidence.identity(launch, options.close_mode, script.path)
    transport = stdio_client(launch.parameters(), errlog := Evidence.open_private(
        evidence.directory / f"{evidence.name}.server.stderr.log"))
    session: ClientSession | None = None
    transport_entered = session_entered = False
    pending: asyncio.Task[dict[str, Any]] | None = None
    close_exc: BaseException | None = None
    close_start = time.monotonic()
    timed_out = False
    async def message_handler(message: Any) -> None:
        inner = getattr(message, "root", message)
        if hasattr(inner, "model_dump"):
            evidence.record("notification", notification=inner.model_dump(mode="json", by_alias=True))
    try:
        streams = await capture.enter(transport)
        transport_entered = True
        evidence.started = time.monotonic()
        evidence.record("spawn", pid=capture.process.pid if capture.process else None,
                        command=launch.command, args=launch.args, envKeys=sorted(launch.env))
        if capture.process is None and options.close_mode != "normal":
            raise UsageError("SDK process capture failed; this close mode needs the spawned child handle")
        kwargs: dict[str, Any] = {}
        if "message_handler" in inspect.signature(ClientSession).parameters:
            kwargs["message_handler"] = message_handler
        session = ClientSession(*streams, **kwargs)
        await session.__aenter__()
        session_entered = True
        initialized = await asyncio.wait_for(session.initialize(), options.step_timeout_ms / 1000)
        evidence.record("initialize", response=initialized.model_dump(mode="json", by_alias=True))
        if choreography:
            await choreography.initialized()
        last = max((i for i, s in enumerate(script.steps) if s["op"] in ("call", "read")), default=-1)
        for index, step in enumerate(script.steps):
            if options.close_mode == "mid-call" and index == last:
                pending = asyncio.create_task(run_step(session, step, index, evidence, options, summary, emit, True))
                if cancel_caller:
                    owner = asyncio.current_task()
                    asyncio.get_running_loop().call_later(options.mid_call_delay_ms / 2000, owner.cancel)
                await asyncio.sleep(options.mid_call_delay_ms / 1000)
                if cancel_in_flight:
                    pending.cancel()
                    await pending
                break
            await run_step(session, step, index, evidence, options, summary, emit)
        if application_error:
            raise ValueError("Injected earlier application exception")
        if choreography and await choreography.before_close():
            for index, step in enumerate(script.after_peer_closed, len(script.steps)):
                await run_step(session, step, index, evidence, options, summary, emit)
        if options.close_mode == "after-server-exit":
            assert capture.process is not None
            if capture.process.stdin:
                await capture.process.stdin.aclose()
            await capture.wait(evidence, options.server_exit_wait_ms)
        elif options.close_mode in ("sigterm-server", "kill-server"):
            capture.signal(signal.SIGTERM if options.close_mode == "sigterm-server" else signal.SIGKILL)
            await capture.wait(evidence, options.server_exit_wait_ms)
    except UsageError as exc:
        summary.usage_error = str(exc)
        print(f"error: {exc}", file=sys.stderr)
    except BaseException as exc:
        # Original application/initialization error remains distinct from context cleanup.
        failure = {"class": type(exc).__name__, "message": str(exc)}
        evidence.record("exception", phase="application", exception=exception_json(exc))
        summary.steps_failed += 1
        if summary.first_step_failure is None:
            summary.first_step_failure = failure
    finally:
        close_start = time.monotonic()
        evidence.record("close-start")
        def deadline() -> None:
            nonlocal timed_out
            timed_out = True
            capture.signal(signal.SIGKILL) if capture.process else None
            owner.cancel() if owner else None
        owner = asyncio.current_task()
        timer = asyncio.get_running_loop().call_later(options.close_timeout_ms / 1000, deadline)
        try:
            # Never use wait_for for __aexit__: that would close scopes in a different task.
            if session_entered and session is not None:
                try:
                    await session.__aexit__(None, None, None)
                except BaseException as exc:
                    close_exc = exc
            if session_gap_ms:
                await asyncio.sleep(session_gap_ms / 1000)
        except BaseException as exc:
            close_exc = exc
        finally:
            if transport_entered:
                try:
                    await transport.__aexit__(None, None, None)
                except BaseException as exc:
                    close_exc = BaseExceptionGroup("session and transport cleanup", [close_exc, exc]) if close_exc else exc
            timer.cancel()
        summary.close = classify_close(close_exc, (time.monotonic()-close_start)*1000, timed_out)
        if summary.close.traceback:
            print(summary.close.traceback, file=sys.stderr, end="")
        if capture.process:
            if capture.process.returncode is None:
                capture.signal(signal.SIGKILL)
                await capture.wait(evidence, 1000)
            summary.server_exit_code = capture.process.returncode
            evidence.record("server-exit", code=summary.server_exit_code, phase="after-close")
        evidence.record("close", **summary.close.json())
        emit({"client": summary.client, "event": "close", **summary.close.json()})
        if choreography:
            choreography.closed()
        if pending and not pending.done():
            try:
                await asyncio.wait_for(pending, 3)
            except BaseException as exc:
                evidence.record("exception", phase="in-flight-wait", inFlightAtClose=True,
                                exception=exception_json(exc))
        errlog.close()
    return summary
