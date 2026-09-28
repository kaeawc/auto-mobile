import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, test } from "bun:test";
import { FakeTimer } from "../fakes/FakeTimer";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonHandoffInterruptionError } from "../../src/daemon/daemonHandoffInterruption";
import { DaemonState } from "../../src/daemon/daemonState";
import { executionTracker } from "../../src/server/executionTracker";

interface ClosableTransport {
  close(): Promise<void>;
}

interface DaemonHttpSessionInternals {
  acceptingHttpSessions: boolean;
  transports: Map<string, ClosableTransport>;
  registerHttpTransport(sessionId: string, transport: ClosableTransport): boolean;
  socketServer: { quiesce(): Promise<void> } | null;
  quiesceProvisioningIngress(): Promise<void>;
  interruptProvisioningForShutdown(): Promise<void>;
  handleHttpTransportError(sessionId: string, error: Error): void;
  beginHttpRequest(sessionId: string): void;
  endHttpRequest(sessionId: string): void;
  readHttpBody(
    req: IncomingMessage,
  ): Promise<{ ok: true; body: string } | { ok: false; status: number; error: string }>;
}

class FakeRequest extends EventEmitter {
  destroyed = false;

  destroy(): this {
    this.destroyed = true;
    this.emit("close");
    return this;
  }
}

class FakeTransport implements ClosableTransport {
  closeCalls = 0;
  onclose?: () => void;

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.onclose?.();
  }
}

describe("Daemon HTTP session shutdown", () => {
  afterEach(() => {
    if (DaemonState.getInstance().isInitialized()) {
      DaemonState.getInstance().reset();
    }
  });

  test("rejects and closes a transport initialized after HTTP admission is quiesced", async () => {
    const daemon = new Daemon({});
    const internals = daemon as unknown as DaemonHttpSessionInternals;
    const transport = new FakeTransport();
    internals.acceptingHttpSessions = false;

    expect(internals.registerHttpTransport("late-session", transport)).toBeFalse();
    await Promise.resolve();

    expect(transport.closeCalls).toBe(1);
    expect(internals.transports.has("late-session")).toBeFalse();
  });

  test("keeps an admitted transport available for shutdown cleanup", () => {
    const daemon = new Daemon({});
    const internals = daemon as unknown as DaemonHttpSessionInternals;
    const transport = new FakeTransport();
    internals.acceptingHttpSessions = true;

    expect(internals.registerHttpTransport("active-session", transport)).toBeTrue();
    expect(internals.transports.get("active-session")).toBe(transport);
    expect(transport.closeCalls).toBe(0);
  });

  test("reaps an idle HTTP session by closing its transport", async () => {
    const timer = new FakeTimer();
    const daemon = new Daemon({}, undefined, timer);
    const internals = daemon as unknown as DaemonHttpSessionInternals;
    const transport = new FakeTransport();
    internals.acceptingHttpSessions = true;
    transport.onclose = () => {
      internals.transports.delete("idle-session");
    };
    internals.registerHttpTransport("idle-session", transport);
    timer.advanceTime(30 * 60_000);
    await Promise.resolve();
    expect(transport.closeCalls).toBe(1);
    expect(internals.transports.size).toBe(0);
  });

  test("idle reaper waits until an active HTTP request finishes", async () => {
    const timer = new FakeTimer();
    const daemon = new Daemon({}, undefined, timer);
    const internals = daemon as unknown as DaemonHttpSessionInternals;
    const transport = new FakeTransport();
    internals.acceptingHttpSessions = true;
    internals.registerHttpTransport("busy-session", transport);
    internals.beginHttpRequest("busy-session");
    timer.advanceTime(30 * 60_000);
    expect(transport.closeCalls).toBe(0);
    internals.endHttpRequest("busy-session");
    timer.advanceTime(30 * 60_000);
    await Promise.resolve();
    expect(transport.closeCalls).toBe(1);
  });

  test("a recoverable HTTP transport error does not evict its session", () => {
    const daemon = new Daemon({});
    const internals = daemon as unknown as DaemonHttpSessionInternals;
    const transport = new FakeTransport();
    internals.acceptingHttpSessions = true;
    internals.registerHttpTransport("recoverable-session", transport);
    internals.handleHttpTransportError("recoverable-session", new Error("write after abort"));
    expect(internals.transports.get("recoverable-session")).toBe(transport);
    expect(transport.closeCalls).toBe(0);
  });

  test("HTTP body read preserves UTF-8 split across data events", async () => {
    const daemon = new Daemon({}, undefined, new FakeTimer());
    const internals = daemon as unknown as DaemonHttpSessionInternals;
    const req = new FakeRequest();
    const read = internals.readHttpBody(req as unknown as IncomingMessage);
    const body = Buffer.from('{"text":"日"}');
    const split = body.indexOf(Buffer.from("日")) + 1;
    req.emit("data", body.subarray(0, split));
    req.emit("data", body.subarray(split));
    req.emit("end");
    expect(await read).toEqual({ ok: true, body: '{"text":"日"}' });
  });

  test("HTTP body read settles when upload closes without end", async () => {
    const daemon = new Daemon({}, undefined, new FakeTimer());
    const internals = daemon as unknown as DaemonHttpSessionInternals;
    const req = new FakeRequest();
    const read = internals.readHttpBody(req as unknown as IncomingMessage);
    req.emit("data", Buffer.from("partial"));
    req.emit("close");
    expect(await read).toEqual({ ok: false, status: 400, error: "Request closed" });
  });

  test.each(["aborted", "error"])("HTTP body read settles on %s", async (event) => {
    const daemon = new Daemon({}, undefined, new FakeTimer());
    const internals = daemon as unknown as DaemonHttpSessionInternals;
    const req = new FakeRequest();
    const read = internals.readHttpBody(req as unknown as IncomingMessage);
    req.emit(event, event === "error" ? new Error("connection reset") : undefined);
    const result = await read;
    expect(result.ok).toBeFalse();
    expect(req.listenerCount("data")).toBe(0);
  });

  test("HTTP body read times out a stalled upload", async () => {
    const timer = new FakeTimer();
    const daemon = new Daemon({}, undefined, timer);
    const internals = daemon as unknown as DaemonHttpSessionInternals;
    const req = new FakeRequest();
    const read = internals.readHttpBody(req as unknown as IncomingMessage);
    timer.advanceTime(60_000);
    expect(await read).toEqual({ ok: false, status: 408, error: "Request body timed out" });
    expect(req.destroyed).toBeTrue();
  });

  test("interrupts and drains provisioning before the sequential shutdown stages", async () => {
    const daemon = new Daemon({});
    const internals = daemon as unknown as DaemonHttpSessionInternals;
    const execution = executionTracker.startExecution("provisionDevice", "provision-session");
    execution.abortController.signal.addEventListener(
      "abort",
      () => executionTracker.endExecution(execution.id),
      { once: true },
    );

    await internals.interruptProvisioningForShutdown();

    expect(execution.abortController.signal.reason).toBeInstanceOf(DaemonHandoffInterruptionError);
    expect(
      executionTracker.hasActiveToolExecution("provisionDevice", { scope: "global" }),
    ).toBeFalse();
  });

  test("closes HTTP and control-socket provisioning ingress before cancellation", async () => {
    const daemon = new Daemon({});
    const internals = daemon as unknown as DaemonHttpSessionInternals;
    let quiesced = false;
    internals.acceptingHttpSessions = true;
    internals.socketServer = {
      async quiesce() {
        quiesced = true;
      },
    };

    await internals.quiesceProvisioningIngress();

    expect(internals.acceptingHttpSessions).toBeFalse();
    expect(quiesced).toBeTrue();
  });
});
