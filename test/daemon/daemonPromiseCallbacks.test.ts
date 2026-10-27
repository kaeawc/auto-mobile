import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Daemon } from "../../src/daemon/daemon";
import { DaemonState } from "../../src/daemon/daemonState";
import type {
  HttpBodyRequest,
  McpIngressRequest,
  McpIngressTransport,
} from "../../src/daemon/daemonHttpIngress";
import type { McpHttpResponseLike } from "../../src/daemon/statelessMcpHttpEndpoint";
import { executionTracker } from "../../src/daemon/executionTracker";
import { logger } from "../../src/utils/logger";
import { FakeTimer } from "../fakes/FakeTimer";

class FakeMcpRequest extends EventEmitter implements McpIngressRequest, HttpBodyRequest {
  readonly method = "POST";
  readonly headers = {};

  destroy(): this {
    return this;
  }
}

class FakeResponse extends EventEmitter implements McpHttpResponseLike {
  headersSent = false;
  writableEnded = false;
  destroyed = false;
  writeHead(): this {
    this.headersSent = true;
    return this;
  }
  write(): boolean {
    return true;
  }
  end(): this {
    this.writableEnded = true;
    return this;
  }
}

/** One request's transport: its response stays open until the response closes. */
class FakeTransport implements McpIngressTransport {
  closed = 0;
  private markStarted!: () => void;
  readonly started = new Promise<void>((resolve) => {
    this.markStarted = resolve;
  });

  async start(): Promise<void> {}

  async send(): Promise<void> {}

  async handleRequest(): Promise<void> {
    this.markStarted();
  }

  async close(): Promise<void> {
    this.closed += 1;
  }
}

describe("daemon stateless MCP request close rejection ownership", () => {
  let timer: FakeTimer;
  let internals: Daemon["testHooks"];
  let transport: FakeTransport;
  let warnings: ReturnType<typeof spyOn<typeof logger, "warn">>;
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => {
    unhandled.push(error);
  };

  beforeEach(() => {
    timer = new FakeTimer();
    // Construct only: no daemon startup, sockets, devices, or real timers.
    internals = new Daemon({}, { timer }).testHooks;
    transport = new FakeTransport();
    internals.httpIngress.setMcpTransportFactory(() => transport);
    internals.httpIngress.setMcpRequestServerFactory(() => ({
      connect: async () => {},
      close: async () => {},
    }));
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

  async function openRequest(): Promise<FakeResponse> {
    const res = new FakeResponse();
    await internals.httpIngress.mcpHttpEndpoint.handle(
      new FakeMcpRequest(),
      res,
      undefined,
      () => {},
    );
    await transport.started;
    return res;
  }

  test("a response close logs a cancellation rejection without an unhandled rejection", async () => {
    const error = new Error("cancel rejected");
    const cancel = spyOn(executionTracker, "cancelSessionExecutions").mockRejectedValue(error);
    try {
      const res = await openRequest();
      expect(res.emit("close")).toBeTrue();
      for (let turn = 0; turn < 8; turn++) {
        await timer.advanceTimersByTimeAsync(0);
      }
      expect(warnings).toHaveBeenCalledWith(
        "Stateless MCP request close failed: cancel rejected",
        error,
      );
      // The request is untracked and its transport closed even though cancellation failed.
      expect(internals.httpIngress.mcpHttpEndpoint.inFlightCount).toBe(0);
      expect(transport.closed).toBe(1);
    } finally {
      cancel.mockRestore();
    }
  });

  test("a request's transport closes only after its cancellation finishes", async () => {
    let complete!: (count: number) => void;
    const cancellation = new Promise<number>((resolve) => {
      complete = resolve;
    });
    const cancel = spyOn(executionTracker, "cancelSessionExecutions").mockReturnValue(cancellation);
    try {
      const res = await openRequest();
      res.emit("finish");
      res.emit("close");
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(cancel.mock.calls[0]![1]).toBe("streamable_http_onclose");
      expect(transport.closed).toBe(0);
      complete(0);
      for (let turn = 0; turn < 8; turn++) {
        await timer.advanceTimersByTimeAsync(0);
      }
      expect(transport.closed).toBe(1);
      expect(internals.httpIngress.mcpHttpEndpoint.inFlightCount).toBe(0);
    } finally {
      cancel.mockRestore();
    }
  });
});
