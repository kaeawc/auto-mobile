import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import { executionTracker } from "../../src/server/executionTracker";
import { logger } from "../../src/utils/logger";
import { FakeTimer } from "../fakes/FakeTimer";

interface CallbackInternals {
  configureHttpTransportCallbacks(transport: StreamableHTTPServerTransport): void;
  transports: Map<string, StreamableHTTPServerTransport>;
  activeHttpRequests: Map<string, number>;
  handleHttpTransportError(sessionId: string, error: Error): void;
}

class FakeTransport {
  sessionId = "callback-session";
  onclose?: () => void;
  onerror?: (error: Error) => void;
}

describe("daemon transport callback rejection ownership", () => {
  let timer: FakeTimer;
  let internals: CallbackInternals;
  let transport: FakeTransport;
  let warnings: ReturnType<typeof spyOn<typeof logger, "warn">>;
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => {
    unhandled.push(error);
  };

  beforeEach(() => {
    timer = new FakeTimer();
    // Construct only: no daemon startup, sockets, devices, or real timers.
    internals = new Daemon({}, undefined, timer) as unknown as CallbackInternals;
    transport = new FakeTransport();
    internals.configureHttpTransportCallbacks(
      transport as unknown as StreamableHTTPServerTransport,
    );
    internals.transports.set(
      transport.sessionId,
      transport as unknown as StreamableHTTPServerTransport,
    );
    internals.activeHttpRequests.set(transport.sessionId, 1);
    warnings = spyOn(logger, "warn").mockImplementation(() => {});
    unhandled.length = 0;
    process.on("unhandledRejection", onUnhandled);
  });
  afterEach(async () => {
    for (let i = 0; i < 8; i++) {
      await timer.advanceTimersByTimeAsync(0);
    }
    process.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
    warnings.mockRestore();
    timer.reset();
    // Constructing a Daemon initializes the process-wide DaemonState; do not leak it to later files.
    DaemonState.getInstance().reset();
  });

  test("onclose logs cancellation rejection without an unhandled rejection", async () => {
    const error = new Error("cancel rejected");
    const cancel = spyOn(executionTracker, "cancelSessionExecutions").mockRejectedValue(error);
    try {
      expect(transport.onclose!()).toBeUndefined();
      await timer.advanceTimersByTimeAsync(0);
      expect(warnings).toHaveBeenCalledWith(
        "HTTP transport close callback failed: cancel rejected",
        error,
      );
      expect(internals.activeHttpRequests.has(transport.sessionId)).toBeFalse();
      // Preserve the existing sequence: transport deletion follows successful cancellation.
      expect(internals.transports.has(transport.sessionId)).toBeTrue();
    } finally {
      cancel.mockRestore();
    }
  });

  test("onclose still deletes transport only after cancellation finishes", async () => {
    let complete!: (count: number) => void;
    const cancellation = new Promise<number>((resolve) => {
      complete = resolve;
    });
    const cancel = spyOn(executionTracker, "cancelSessionExecutions").mockReturnValue(cancellation);
    try {
      transport.onclose!();
      expect(cancel).toHaveBeenCalledWith(transport.sessionId, "streamable_http_onclose");
      expect(internals.activeHttpRequests.has(transport.sessionId)).toBeFalse();
      expect(internals.transports.has(transport.sessionId)).toBeTrue();
      complete(1);
      await timer.advanceTimersByTimeAsync(0);
      expect(internals.transports.has(transport.sessionId)).toBeFalse();
    } finally {
      cancel.mockRestore();
    }
  });

  test("onerror warns if the transport-error handler rejects and preserves synchronous dispatch", async () => {
    const error = new Error("handler failed");
    const handle = spyOn(internals, "handleHttpTransportError").mockImplementation(() => {
      throw error;
    });
    const reported = new Error("transport error");
    try {
      expect(transport.onerror!(reported)).toBeUndefined();
      expect(handle).toHaveBeenCalledWith(transport.sessionId, reported);
      await timer.advanceTimersByTimeAsync(0);
      expect(warnings).toHaveBeenCalledWith(
        "HTTP transport error callback failed: handler failed",
        error,
      );
    } finally {
      handle.mockRestore();
    }
  });
});
