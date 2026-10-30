import { createHarnessServer } from "../helpers/UnixSocketServerHarness";
import { UnixSocketServerHarness } from "../helpers/UnixSocketServerHarness";
import { createFakeDaemonState } from "../helpers/inputSocketHarness";
import { FakeSocket } from "../../fakes/FakeNetServer";
import type { Socket } from "node:net";
import { describe, expect, it } from "bun:test";
import { FailuresStreamSocketServer } from "../../../src/daemon/failuresStreamSocketServer";
import { BaseSocketServer } from "../../../src/daemon/socketServer/BaseSocketServer";
import { RequestResponseSocketServer } from "../../../src/daemon/socketServer/RequestResponseSocketServer";
import {
  AUX_SOCKET_MAX_FRAME_BYTES,
  CONTROL_SOCKET_MAX_FRAME_BYTES,
  FAILURES_STREAM_MAX_FRAME_BYTES,
} from "../../../src/daemon/wire/LineFramer";
import type {
  SocketRequest,
  SocketResponse,
} from "../../../src/daemon/socketServer/SocketServerTypes";
import { FakeFailuresStreamRepository } from "../../fakes/FakeFailuresStreamRepository";
import { FakeTimer } from "../../fakes/FakeTimer";

const LIMIT = 64;

/** Socket double that flushes writes immediately and records destruction. */
class FlushingSocket extends FakeSocket<unknown> {}

/** Socket whose writes are recorded but never flushed: the peer is not reading. */
class UnflushedSocket extends FakeSocket<unknown> {
  write(data: string | Buffer): boolean {
    return super.write(data);
  }
}

/** Control socket server with a tiny inbound frame limit. */
class SmallFrameControlServer extends UnixSocketServerHarness {
  protected readonly maxInboundFrameBytes = LIMIT;
}

class FailuresStreamHarness extends FailuresStreamSocketServer {
  attach(socket: Socket): void {
    this.handleConnection(socket);
  }
}

class RawServer extends BaseSocketServer {
  readonly lines: string[] = [];
  protected readonly maxFrameBytes = LIMIT;

  constructor() {
    super("/fake/raw.sock", new FakeTimer(), "Raw", { idleTimeoutMs: 0 });
  }

  attach(socket: Socket): void {
    this.handleConnection(socket);
  }

  protected async processLine(_socket: Socket, line: string): Promise<void> {
    this.lines.push(line);
  }
}

interface Echo extends SocketRequest {
  value?: string;
}

interface EchoResponse extends SocketResponse {
  value?: string;
}

class EchoServer extends RequestResponseSocketServer<Echo, EchoResponse> {
  protected readonly maxFrameBytes = LIMIT;

  constructor() {
    super("/fake/echo.sock", new FakeTimer(), "Echo");
  }

  attach(socket: Socket): void {
    this.handleConnection(socket);
  }

  protected async handleRequest(request: Echo): Promise<EchoResponse> {
    return { id: request.id, success: true, value: request.value };
  }

  protected createErrorResponse(id: string | undefined, error: string): EchoResponse {
    return { id, success: false, error };
  }
}

const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
};

describe("auxiliary socket inbound frame limit", () => {
  it("destroys a base-server connection that never sends a newline", () => {
    const server = new RawServer();
    const socket = new FlushingSocket();
    server.attach(socket);

    for (let sent = 0; sent <= LIMIT && !socket.destroyed; sent += 8) {
      socket.emit("data", Buffer.from("aaaaaaaa"));
    }

    expect(socket.destroyed).toBe(true);
    expect(server.lines).toEqual([]);
  });

  it("answers an over-limit request/response frame with a structured error, then destroys", async () => {
    const server = new EchoServer();
    const socket = new FlushingSocket();
    server.attach(socket);

    socket.emit("data", Buffer.from(`{"id":"1","value":"${"x".repeat(LIMIT * 2)}"}\n`));
    await flushMicrotasks();

    expect(socket.responses).toEqual([
      { success: false, error: "Invalid request: frame too large" },
    ]);
    expect(socket.destroyed).toBe(true);
  });

  it("leaves a sibling connection unaffected when one connection overflows", async () => {
    const server = new EchoServer();
    const bad = new FlushingSocket();
    const good = new FlushingSocket();
    server.attach(bad);
    server.attach(good);

    bad.emit("data", Buffer.from("x".repeat(LIMIT + 1)));
    good.emit("data", Buffer.from('{"id":"7","value":"hi"}\n'));
    await flushMicrotasks();

    expect(bad.destroyed).toBe(true);
    expect(good.destroyed).toBe(false);
    expect(good.responses).toEqual([{ id: "7", success: true, value: "hi" }]);
  });

  it("still serves a frame at the limit", async () => {
    const server = new EchoServer();
    const socket = new FlushingSocket();
    server.attach(socket);
    const prefix = '{"id":"1","value":"';
    const suffix = '"}';
    const value = "y".repeat(LIMIT - prefix.length - suffix.length);

    socket.emit("data", Buffer.from(`${prefix}${value}${suffix}\n`));
    await flushMicrotasks();

    expect(socket.destroyed).toBe(false);
    expect(socket.responses).toEqual([{ id: "1", success: true, value }]);
  });
});

describe("control socket inbound frame limit", () => {
  function connect(socket: Socket): UnixSocketServerHarness {
    const server = new SmallFrameControlServer("unused", createFakeDaemonState(), new FakeTimer());
    server.allowRequests();
    // Frame handling is under test, not request routing: a complete frame is answered by no one.
    server.requestHandler = async () => undefined;
    server.connect(socket);
    return server;
  }

  it("answers an over-limit frame with a structured error and destroys the socket", () => {
    const socket = new FlushingSocket();
    connect(socket);

    // No newline, ever: the peer streams until the daemon refuses.
    for (let sent = 0; sent < 20 && !socket.destroyed; sent++) {
      socket.emit("data", Buffer.from("z".repeat(16)));
    }

    expect(socket.destroyed).toBe(true);
    const frames = socket.responses;
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      id: null,
      success: false,
      error: "Invalid request: frame too large",
      code: -32600,
    });
  });

  it("ignores bytes that arrive after the overflow while the reply is unflushed", () => {
    const socket = new UnflushedSocket();
    connect(socket);

    socket.emit("data", Buffer.from("z".repeat(LIMIT + 1)));
    socket.emit("data", Buffer.from("z".repeat(LIMIT)));
    socket.emit("data", Buffer.from("{}\n"));

    expect(socket.writes).toHaveLength(1);
  });

  it("keeps serving frames below the limit", () => {
    const socket = new FlushingSocket();
    connect(socket);

    socket.emit("data", Buffer.from('{"id":"h1","type":"mcp_request","method":"bogus"'));
    socket.emit("data", Buffer.from("}\n"));

    expect(socket.destroyed).toBe(false);
  });
});

describe("per-server inbound frame limits", () => {
  it("keeps the control socket at the HTTP body cap and auxiliary sockets at 1 MiB", () => {
    expect(CONTROL_SOCKET_MAX_FRAME_BYTES).toBe(256 * 1024 * 1024);
    expect(AUX_SOCKET_MAX_FRAME_BYTES).toBe(1024 * 1024);
    expect(FAILURES_STREAM_MAX_FRAME_BYTES).toBeGreaterThan(AUX_SOCKET_MAX_FRAME_BYTES);
    const control = createHarnessServer("unused", undefined, new FakeTimer());
    expect(control.inboundFrameLimit).toBe(CONTROL_SOCKET_MAX_FRAME_BYTES);
  });

  it("accepts a failures-stream acknowledge frame larger than the 1 MiB default", async () => {
    const repository = new FakeFailuresStreamRepository();
    const socket = new FlushingSocket();
    const authorizedSessions: Array<string | undefined> = [];
    const server = new FailuresStreamHarness("/fake/failures.sock", new FakeTimer(), repository, {
      authenticator: {
        authorize({ sessionUuid }) {
          authorizedSessions.push(sessionUuid);
        },
      },
    });
    server.attach(socket);
    const ids = Array.from({ length: 250_000 }, (_, index) => index);
    const frame = JSON.stringify({
      id: "1",
      command: "acknowledge",
      sessionUuid: "frame-test-session",
      notificationIds: ids,
    });
    expect(Buffer.byteLength(frame)).toBeGreaterThan(AUX_SOCKET_MAX_FRAME_BYTES);

    socket.emit("data", Buffer.from(`${frame}\n`));
    await flushMicrotasks();

    expect(socket.destroyed).toBe(false);
    expect(repository.acknowledgedIds).toHaveLength(ids.length);
    expect(authorizedSessions).toEqual(["frame-test-session"]);
    expect(socket.responses).toEqual([{ success: true, acknowledgedCount: ids.length }]);
  });

  it("rejects a failures-stream frame over its own 8 MiB limit", async () => {
    const socket = new FlushingSocket();
    const server = new FailuresStreamHarness(
      "/fake/failures.sock",
      new FakeTimer(),
      new FakeFailuresStreamRepository(),
    );
    server.attach(socket);

    socket.emit("data", Buffer.alloc(FAILURES_STREAM_MAX_FRAME_BYTES + 1, 0x61));
    await flushMicrotasks();

    expect(socket.destroyed).toBe(true);
    expect(socket.responses).toEqual([
      { success: false, error: "Invalid request: frame too large" },
    ]);
  });
});
