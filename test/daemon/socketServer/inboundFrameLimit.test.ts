import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { describe, expect, it } from "bun:test";
import {
  FailuresStreamSocketServer,
  type FailuresStreamRepository,
} from "../../../src/daemon/failuresStreamSocketServer";
import { UnixSocketServer } from "../../../src/daemon/socketServer";
import { BaseSocketServer } from "../../../src/daemon/socketServer/BaseSocketServer";
import { RequestResponseSocketServer } from "../../../src/daemon/socketServer/RequestResponseSocketServer";
import {
  AUX_SOCKET_MAX_FRAME_BYTES,
  CONTROL_SOCKET_MAX_FRAME_BYTES,
  FAILURES_STREAM_MAX_FRAME_BYTES,
} from "../../../src/daemon/socketServer/LineFramer";
import type {
  SocketRequest,
  SocketResponse,
} from "../../../src/daemon/socketServer/SocketServerTypes";
import type { DaemonResponse } from "../../../src/daemon/types";
import { FakeTimer } from "../../fakes/FakeTimer";

const LIMIT = 64;

/** Socket double that flushes writes immediately and records destruction. */
class FlushingSocket extends EventEmitter {
  destroyed = false;
  writableLength = 0;
  readonly writes: string[] = [];

  setTimeout(): this {
    return this;
  }

  write(payload: string, callback?: (error?: Error | null) => void): boolean {
    this.writes.push(payload);
    callback?.();
    return true;
  }

  destroy(): this {
    if (!this.destroyed) {
      this.destroyed = true;
      this.emit("close", false);
    }
    return this;
  }

  asSocket(): Socket {
    return this as unknown as Socket;
  }
}

class RawServer extends BaseSocketServer {
  readonly lines: string[] = [];
  protected readonly maxFrameBytes = LIMIT;

  constructor() {
    super("/fake/raw.sock", new FakeTimer(), "Raw", 0);
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
    server.attach(socket.asSocket());

    for (let sent = 0; sent <= LIMIT && !socket.destroyed; sent += 8) {
      socket.emit("data", Buffer.from("aaaaaaaa"));
    }

    expect(socket.destroyed).toBe(true);
    expect(server.lines).toEqual([]);
  });

  it("answers an over-limit request/response frame with a structured error, then destroys", async () => {
    const server = new EchoServer();
    const socket = new FlushingSocket();
    server.attach(socket.asSocket());

    socket.emit("data", Buffer.from(`{"id":"1","value":"${"x".repeat(LIMIT * 2)}"}\n`));
    await flushMicrotasks();

    expect(socket.writes.map((write) => JSON.parse(write))).toEqual([
      { success: false, error: "Invalid request: frame too large" },
    ]);
    expect(socket.destroyed).toBe(true);
  });

  it("leaves a sibling connection unaffected when one connection overflows", async () => {
    const server = new EchoServer();
    const bad = new FlushingSocket();
    const good = new FlushingSocket();
    server.attach(bad.asSocket());
    server.attach(good.asSocket());

    bad.emit("data", Buffer.from("x".repeat(LIMIT + 1)));
    good.emit("data", Buffer.from('{"id":"7","value":"hi"}\n'));
    await flushMicrotasks();

    expect(bad.destroyed).toBe(true);
    expect(good.destroyed).toBe(false);
    expect(good.writes.map((write) => JSON.parse(write))).toEqual([
      { id: "7", success: true, value: "hi" },
    ]);
  });

  it("still serves a frame at the limit", async () => {
    const server = new EchoServer();
    const socket = new FlushingSocket();
    server.attach(socket.asSocket());
    const prefix = '{"id":"1","value":"';
    const suffix = '"}';
    const value = "y".repeat(LIMIT - prefix.length - suffix.length);

    socket.emit("data", Buffer.from(`${prefix}${value}${suffix}\n`));
    await flushMicrotasks();

    expect(socket.destroyed).toBe(false);
    expect(socket.writes.map((write) => JSON.parse(write))).toEqual([
      { id: "1", success: true, value },
    ]);
  });
});

describe("control socket inbound frame limit", () => {
  function connect(socket: FlushingSocket): UnixSocketServer {
    const server = new UnixSocketServer(
      "unused",
      "http://localhost:0/mcp",
      undefined,
      new FakeTimer(),
    );
    const internals = server as unknown as {
      acceptingRequests: boolean;
      maxInboundFrameBytes: number;
      handleConnection(socket: Socket): void;
    };
    internals.acceptingRequests = true;
    internals.maxInboundFrameBytes = LIMIT;
    internals.handleConnection(socket.asSocket());
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
    const frames = socket.writes.map((write) => JSON.parse(write) as DaemonResponse);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      id: null,
      success: false,
      error: "Invalid request: frame too large",
      code: -32600,
    });
  });

  it("ignores bytes that arrive after the overflow while the reply is unflushed", () => {
    const socket = new FlushingSocket();
    socket.write = (payload: string): boolean => {
      socket.writes.push(payload);
      return true; // flush callback never fires: the peer is not reading
    };
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
    const control = new UnixSocketServer(
      "unused",
      "http://localhost:0/mcp",
      undefined,
      new FakeTimer(),
    );
    expect((control as unknown as { maxInboundFrameBytes: number }).maxInboundFrameBytes).toBe(
      CONTROL_SOCKET_MAX_FRAME_BYTES,
    );
  });

  class FakeFailuresRepository implements FailuresStreamRepository {
    acknowledgedIds: number[] = [];
    async getNotificationsSince(): ReturnType<FailuresStreamRepository["getNotificationsSince"]> {
      return { notifications: [], lastTimestamp: undefined, lastId: undefined };
    }
    async getAggregatedGroups(): ReturnType<FailuresStreamRepository["getAggregatedGroups"]> {
      return { groups: [], totals: { crashes: 0, anrs: 0, toolFailures: 0 } };
    }
    async getTimelineData(): ReturnType<FailuresStreamRepository["getTimelineData"]> {
      return { dataPoints: [], previousPeriodTotals: undefined as never };
    }
    async acknowledgeNotifications(ids: number[]): Promise<void> {
      this.acknowledgedIds = ids;
    }
  }

  it("accepts a failures-stream acknowledge frame larger than the 1 MiB default", async () => {
    const repository = new FakeFailuresRepository();
    const socket = new FlushingSocket();
    const authorizedSessions: Array<string | undefined> = [];
    const server = new FailuresStreamSocketServer(
      "/fake/failures.sock",
      new FakeTimer(),
      repository,
      {
        authenticator: {
          authorize({ sessionUuid }) {
            authorizedSessions.push(sessionUuid);
          },
        },
      },
    );
    (server as unknown as { handleConnection(socket: Socket): void }).handleConnection(
      socket.asSocket(),
    );
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
    expect(socket.writes.map((write) => JSON.parse(write))).toEqual([
      { success: true, acknowledgedCount: ids.length },
    ]);
  });

  it("rejects a failures-stream frame over its own 8 MiB limit", async () => {
    const socket = new FlushingSocket();
    const server = new FailuresStreamSocketServer(
      "/fake/failures.sock",
      new FakeTimer(),
      new FakeFailuresRepository(),
    );
    (server as unknown as { handleConnection(socket: Socket): void }).handleConnection(
      socket.asSocket(),
    );

    socket.emit("data", Buffer.alloc(FAILURES_STREAM_MAX_FRAME_BYTES + 1, 0x61));
    await flushMicrotasks();

    expect(socket.destroyed).toBe(true);
    expect(socket.writes.map((write) => JSON.parse(write))).toEqual([
      { success: false, error: "Invalid request: frame too large" },
    ]);
  });
});
