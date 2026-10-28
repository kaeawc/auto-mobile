import { InputDeviceOwnedError } from "../../../src/daemon/inputDeviceOwnership";
import { SessionNoLongerOwnsDeviceError } from "../../../src/models/sessionNoLongerOwnsDevice";
import { describe, it, expect, beforeEach } from "bun:test";
import {
  RequestResponseSocketServer,
  type RequestResponseContext,
} from "../../../src/daemon/socketServer/RequestResponseSocketServer";
import { SocketRequest, SocketResponse } from "../../../src/daemon/socketServer/SocketServerTypes";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeSocket } from "../../fakes/FakeNetServer";
import { numberResultFrameSchema } from "../../helpers/wireMessageSchemas";

interface TestRequest extends SocketRequest {
  action: string;
  value?: number;
}

interface TestResponse extends SocketResponse {
  type: "test_response";
  result?: number;
}

class TestableRequestResponseServer extends RequestResponseSocketServer<TestRequest, TestResponse> {
  public lastRequest: TestRequest | null = null;
  public shouldThrow = false;
  public throwError: Error | null = null;

  constructor(timer: FakeTimer) {
    super("/fake/path/test.sock", timer, "Test");
  }

  /**
   * Start without creating real socket
   */
  async startFake(): Promise<void> {}

  /**
   * Simulate a client sending a line
   */
  async simulateLine(socket: FakeSocket, line: string): Promise<void> {
    await this.processLine(socket, line);
    // Wait for pending promise to complete
    const pending = this.pendingBySocket.get(socket);
    if (pending) {
      await pending;
    }
  }

  protected async handleRequest(request: TestRequest): Promise<TestResponse> {
    this.lastRequest = request;

    if (this.shouldThrow && this.throwError) {
      throw this.throwError;
    }

    switch (request.action) {
      case "double":
        return {
          id: request.id,
          type: "test_response",
          success: true,
          result: (request.value ?? 0) * 2,
        };
      case "echo":
        return {
          id: request.id,
          type: "test_response",
          success: true,
          result: request.value,
        };
      default:
        return {
          id: request.id,
          type: "test_response",
          success: false,
          error: `Unknown action: ${request.action}`,
        };
    }
  }

  protected createErrorResponse(id: string | undefined, error: string): TestResponse {
    return {
      id: id ?? "unknown",
      type: "test_response",
      success: false,
      error,
    };
  }
}

/**
 * Server whose first request blocks on a manually-released gate, recording an
 * ordered trace of handler entry/exit. Lets a test prove that pendingBySocket
 * serializes handlers WITHOUT the test itself awaiting the first request.
 */
class GatedSequencingServer extends RequestResponseSocketServer<TestRequest, TestResponse> {
  public readonly order: string[] = [];
  private readonly gate: Promise<void>;
  private releaseGate!: () => void;

  enqueueLine(socket: FakeSocket, line: string): Promise<void> {
    return this.processLine(socket, line);
  }

  pendingFor(socket: FakeSocket): Promise<void> | undefined {
    return this.pendingBySocket.get(socket);
  }

  constructor(timer: FakeTimer) {
    super("/fake/path/seq.sock", timer, "Seq");
    this.gate = new Promise<void>((resolve) => {
      this.releaseGate = resolve;
    });
  }

  /** Release the first request's handler so the chain can drain. */
  release(): void {
    this.releaseGate();
  }

  send(socket: FakeSocket, request: TestRequest): Promise<void> {
    return this.processLine(socket, JSON.stringify(request));
  }

  protected bypassesRequestChain(request: TestRequest): boolean {
    return request.action === "bypass";
  }

  protected async handleRequest(request: TestRequest): Promise<TestResponse> {
    if (request.id === "1") {
      this.order.push("req1-start");
      await this.gate;
      this.order.push("req1-end");
    } else {
      this.order.push(`req${request.id}-start`);
      this.order.push(`req${request.id}-end`);
    }
    return { id: request.id, type: "test_response", success: true };
  }

  protected createErrorResponse(id: string | undefined, error: string): TestResponse {
    return { id: id ?? "unknown", type: "test_response", success: false, error };
  }
}

/** Drain all currently-scheduled microtasks without advancing real time. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

describe("RequestResponseSocketServer", () => {
  let server: TestableRequestResponseServer;
  let timer: FakeTimer;
  let socket: FakeSocket;

  beforeEach(async () => {
    timer = new FakeTimer();
    timer.enableAutoAdvance();
    server = new TestableRequestResponseServer(timer);
    await server.startFake();
    socket = new FakeSocket();
  });

  it("processes valid JSON requests", async () => {
    const request: TestRequest = { id: "1", action: "double", value: 5 };
    await server.simulateLine(socket, JSON.stringify(request));

    const messages = socket.getWrittenMessages(numberResultFrameSchema);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe("1");
    expect(messages[0].success).toBe(true);
    expect(messages[0].result).toBe(10);
  });

  it("handles invalid JSON gracefully", async () => {
    await server.simulateLine(socket, "not valid json{{{");

    const messages = socket.getWrittenMessages(numberResultFrameSchema);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe("unknown");
    expect(messages[0].success).toBe(false);
    expect(messages[0].error).toBe("Invalid JSON");
  });

  it("handles handler errors gracefully", async () => {
    server.shouldThrow = true;
    server.throwError = new Error("Handler failed");

    const request: TestRequest = { id: "2", action: "double", value: 5 };
    await server.simulateLine(socket, JSON.stringify(request));

    const messages = socket.getWrittenMessages(numberResultFrameSchema);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe("2");
    expect(messages[0].success).toBe(false);
    expect(messages[0].error).toBe("Handler failed");
  });

  it("does not start the second request's handler until the first completes", async () => {
    const sequencer = new GatedSequencingServer(timer);
    const seqSocket = new FakeSocket();

    // Fire both requests WITHOUT awaiting the first. pendingBySocket — not the
    // test — must be what serializes them. processLine returns immediately after
    // chaining onto the per-socket promise, so both are queued back-to-back.
    void sequencer.enqueueLine(seqSocket, JSON.stringify({ id: "1", action: "noop" }));
    void sequencer.enqueueLine(seqSocket, JSON.stringify({ id: "2", action: "noop" }));

    // The first handler has started and is now blocked on its gate. If the class
    // ran handlers concurrently, req2 would already have run here.
    await flushMicrotasks();
    expect(sequencer.order).toEqual(["req1-start"]);

    // Releasing the gate lets the first finish, and only then may the second run.
    sequencer.release();
    await sequencer.pendingFor(seqSocket);

    expect(sequencer.order).toEqual(["req1-start", "req1-end", "req2-start", "req2-end"]);
  });

  it("answers a bypass request during a gated request without delaying later queued requests", async () => {
    const sequencer = new GatedSequencingServer(timer);
    const seqSocket = new FakeSocket();

    await sequencer.send(seqSocket, { id: "1", action: "noop" });
    await flushMicrotasks();
    await sequencer.send(seqSocket, { id: "2", action: "noop" });
    await sequencer.send(seqSocket, { id: "stop", action: "bypass" });
    await sequencer.send(seqSocket, { id: "3", action: "noop" });
    await flushMicrotasks();

    expect(
      seqSocket.getWrittenMessages(numberResultFrameSchema).map((message) => message.id),
    ).toEqual(["stop"]);
    expect(sequencer.order).toEqual(["req1-start", "reqstop-start", "reqstop-end"]);

    sequencer.release();
    await flushMicrotasks();
    expect(
      seqSocket.getWrittenMessages(numberResultFrameSchema).map((message) => message.id),
    ).toEqual(["stop", "1", "2", "3"]);
    expect(sequencer.order).toEqual([
      "req1-start",
      "reqstop-start",
      "reqstop-end",
      "req1-end",
      "req2-start",
      "req2-end",
      "req3-start",
      "req3-end",
    ]);
  });

  it("stores last request for verification", async () => {
    const request: TestRequest = { id: "test-id", action: "echo", value: 100 };
    await server.simulateLine(socket, JSON.stringify(request));

    expect(server.lastRequest).toEqual(request);
  });

  it("handles unknown actions with error response", async () => {
    const request: TestRequest = { id: "3", action: "unknown" };
    await server.simulateLine(socket, JSON.stringify(request));

    const messages = socket.getWrittenMessages(numberResultFrameSchema);
    expect(messages).toHaveLength(1);
    expect(messages[0].success).toBe(false);
    expect(messages[0].error).toBe("Unknown action: unknown");
  });

  it("does not write to destroyed sockets", async () => {
    socket.destroy();

    const request: TestRequest = { id: "1", action: "double", value: 5 };
    // This should not throw
    await server.simulateLine(socket, JSON.stringify(request));

    // No messages should be written (socket was destroyed)
    expect(socket.getWrittenData()).toHaveLength(0);
  });
});

it.each([
  new InputDeviceOwnedError("capture", "emu", "live"),
  new SessionNoLongerOwnsDeviceError("live", "emu"),
  new Error("ordinary error"),
])("preserves only stream ownership refusal fields on response frames: %s", async (error) => {
  const server = new TestableRequestResponseServer(new FakeTimer());
  server.shouldThrow = true;
  server.throwError = error;
  const socket = new FakeSocket();
  await server.simulateLine(socket, JSON.stringify({ id: "ownership", action: "echo" }));
  const response = socket.getWrittenMessages(numberResultFrameSchema)[0];
  expect(response).toMatchObject({ success: false, error: error.message });
  if (error instanceof InputDeviceOwnedError || error instanceof SessionNoLongerOwnsDeviceError) {
    expect(response).toMatchObject({ code: error.code, retryable: false, deviceId: "emu" });
  } else {
    expect(response).not.toHaveProperty("code");
    expect(response).not.toHaveProperty("retryable");
  }
});

/** Server whose handler parks on a gate and records the per-request signal it was given. */
class SignalProbeServer extends RequestResponseSocketServer<TestRequest, TestResponse> {
  public signals: Array<AbortSignal | undefined> = [];
  private releases: Array<() => void> = [];

  constructor() {
    super("/fake/path/signal.sock", new FakeTimer(), "Signal");
  }

  send(socket: FakeSocket, request: TestRequest): Promise<void> {
    return this.processLine(socket, JSON.stringify(request));
  }

  finish(): void {
    for (const release of this.releases.splice(0)) {
      release();
    }
  }

  protected bypassesRequestChain(request: TestRequest): boolean {
    return request.action === "bypass";
  }

  settled(socket: FakeSocket): Promise<void> | undefined {
    return this.pendingBySocket.get(socket);
  }

  protected async handleRequest(
    request: TestRequest,
    context?: RequestResponseContext,
  ): Promise<TestResponse> {
    this.signals.push(context?.signal);
    await new Promise<void>((resolve) => {
      this.releases.push(resolve);
    });
    return { id: request.id, type: "test_response", success: true };
  }

  protected createErrorResponse(id: string | undefined, error: string): TestResponse {
    return { id: id ?? "unknown", type: "test_response", success: false, error };
  }
}

describe("per-request client-gone signal (#11817)", () => {
  it("aborts the handler's signal when the client socket closes mid-request", async () => {
    const server = new SignalProbeServer();
    const socket = new FakeSocket();
    const pending = server.send(socket, { id: "1", action: "echo" });
    await Promise.resolve();
    const signal = server.signals[0];
    expect(signal?.aborted).toBe(false);

    socket.emit("close");

    expect(signal?.aborted).toBe(true);
    server.finish();
    await pending;
  });

  it("starts a queued request's signal aborted when its client disconnected while queued", async () => {
    const server = new SignalProbeServer();
    const socket = new FakeSocket();
    void server.send(socket, { id: "1", action: "echo" });
    void server.send(socket, { id: "2", action: "echo" });
    await Promise.resolve();
    expect(server.signals).toHaveLength(1);

    socket.destroy();
    socket.emit("close");
    server.finish();
    for (let turn = 0; turn < 20 && server.signals.length < 2; turn++) {
      await Promise.resolve();
    }

    expect(server.signals).toHaveLength(2);
    expect(server.signals[1]?.aborted).toBe(true);
    server.finish();
    await server.settled(socket);
  });

  it("does not abort a finished request's signal", async () => {
    const server = new SignalProbeServer();
    const socket = new FakeSocket();
    const pending = server.send(socket, { id: "1", action: "echo" });
    await Promise.resolve();

    server.finish();
    await pending;
    await server.settled(socket);

    socket.emit("close");
    expect(server.signals[0]?.aborted).toBe(false);
  });

  it("uses one close listener per socket however many requests are pipelined", async () => {
    const server = new SignalProbeServer();
    const socket = new FakeSocket();
    const baseline = socket.listenerCount("close");
    for (let id = 1; id <= 12; id++) {
      void server.send(socket, { id: String(id), action: "bypass" });
    }
    for (let turn = 0; turn < 20 && server.signals.length < 12; turn++) {
      await Promise.resolve();
    }
    expect(server.signals).toHaveLength(12);
    expect(socket.listenerCount("close")).toBe(baseline + 1);

    socket.emit("close");

    expect(server.signals.every((signal) => signal?.aborted)).toBe(true);
    server.finish();
  });
});
