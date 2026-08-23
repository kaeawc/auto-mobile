import { describe, it, expect, beforeEach } from "bun:test";
import { Socket } from "node:net";
import { RequestResponseSocketServer } from "../../../src/daemon/socketServer/RequestResponseSocketServer";
import { SocketRequest, SocketResponse } from "../../../src/daemon/socketServer/SocketServerTypes";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeSocket } from "../../fakes/FakeNetServer";

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
  async startFake(): Promise<void> {
    (this as any).server = { listening: true };
  }

  /**
   * Simulate a client sending a line
   */
  async simulateLine(socket: FakeSocket, line: string): Promise<void> {
    await (this as any).processLine(socket as unknown as Socket, line);
    // Wait for pending promise to complete
    const pending = (this as any).pendingBySocket.get(socket);
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

  protected async handleRequest(request: TestRequest): Promise<TestResponse> {
    if (request.id === "1") {
      this.order.push("req1-start");
      await this.gate;
      this.order.push("req1-end");
    } else {
      this.order.push("req2-start");
      this.order.push("req2-end");
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

    const messages = socket.getWrittenMessages<TestResponse>();
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe("1");
    expect(messages[0].success).toBe(true);
    expect(messages[0].result).toBe(10);
  });

  it("handles invalid JSON gracefully", async () => {
    await server.simulateLine(socket, "not valid json{{{");

    const messages = socket.getWrittenMessages<TestResponse>();
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

    const messages = socket.getWrittenMessages<TestResponse>();
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
    void (sequencer as any).processLine(
      seqSocket as unknown as Socket,
      JSON.stringify({ id: "1", action: "noop" }),
    );
    void (sequencer as any).processLine(
      seqSocket as unknown as Socket,
      JSON.stringify({ id: "2", action: "noop" }),
    );

    // The first handler has started and is now blocked on its gate. If the class
    // ran handlers concurrently, req2 would already have run here.
    await flushMicrotasks();
    expect(sequencer.order).toEqual(["req1-start"]);

    // Releasing the gate lets the first finish, and only then may the second run.
    sequencer.release();
    await (sequencer as any).pendingBySocket.get(seqSocket);

    expect(sequencer.order).toEqual(["req1-start", "req1-end", "req2-start", "req2-end"]);
  });

  it("stores last request for verification", async () => {
    const request: TestRequest = { id: "test-id", action: "echo", value: 100 };
    await server.simulateLine(socket, JSON.stringify(request));

    expect(server.lastRequest).toEqual(request);
  });

  it("handles unknown actions with error response", async () => {
    const request: TestRequest = { id: "3", action: "unknown" };
    await server.simulateLine(socket, JSON.stringify(request));

    const messages = socket.getWrittenMessages<TestResponse>();
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
