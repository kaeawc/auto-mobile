import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { expect, test } from "bun:test";
import { DaemonSocketQueueOverflowError, UnixSocketServer } from "../../src/daemon/socketServer";
import type { DaemonResponse } from "../../src/daemon/types";
import { DAEMON_RPC_SOCKET_IDLE_TIMEOUT_MS } from "../../src/utils/deviceTimeouts";
import { FakeTimer } from "../fakes/FakeTimer";

const MAX_QUEUED_BYTES = 1024 * 1024;

class BackpressuredSocket extends EventEmitter {
  destroyed = false;
  writableLength = 0;
  readonly callbacks: Array<(error?: Error | null) => void> = [];

  setTimeout(_ms: number): this {
    return this;
  }

  write(payload: string, callback: (error?: Error | null) => void): boolean {
    this.writableLength += Buffer.byteLength(payload);
    this.callbacks.push(callback);
    return false;
  }

  destroy(): this {
    if (!this.destroyed) {
      this.destroyed = true;
      this.emit("close", false);
    }
    return this;
  }

  flush(): void {
    this.writableLength = 0;
    for (const callback of this.callbacks.splice(0)) {
      callback();
    }
    this.emit("drain");
  }
}

interface SocketServerInternals {
  acceptingRequests: boolean;
  handleConnection(socket: Socket): void;
  writeFrameData(
    socket: Socket,
    sessionId: string,
    frame: DaemonResponse,
    onFlushed?: (error?: Error | null) => void,
  ): void;
}

function connectedServer(timer: FakeTimer, socket: BackpressuredSocket): SocketServerInternals {
  const server = new UnixSocketServer("unused", "http://localhost:0/mcp", undefined, timer);
  const internals = server as unknown as SocketServerInternals;
  internals.acceptingRequests = true;
  internals.handleConnection(socket as unknown as Socket);
  return internals;
}

const response: DaemonResponse = {
  id: "request",
  type: "mcp_response",
  success: true,
  result: {},
};

test("disconnects before a queued RPC frame would exceed the byte cap", () => {
  const socket = new BackpressuredSocket();
  const server = connectedServer(new FakeTimer(), socket);
  const errors: Array<Error | null | undefined> = [];
  const frame: DaemonResponse = { ...response, result: { data: "x".repeat(64 * 1024) } };

  while (!socket.destroyed) {
    server.writeFrameData(socket as unknown as Socket, "session", frame, (error) => {
      errors.push(error);
    });
  }

  expect(socket.writableLength).toBeLessThanOrEqual(MAX_QUEUED_BYTES);
  expect(socket.callbacks.length).toBeGreaterThan(0);
  expect(errors).toHaveLength(1);
  expect(errors[0]?.message).toContain("queued bytes exceeded");
});

test("rejects an overflowing frame once with a typed queue overflow error", () => {
  const socket = new BackpressuredSocket();
  const server = connectedServer(new FakeTimer(), socket);
  const errors: Array<Error | null | undefined> = [];
  socket.writableLength = MAX_QUEUED_BYTES;

  server.writeFrameData(socket as unknown as Socket, "session", response, (error) => {
    expect(socket.destroyed).toBeFalse();
    errors.push(error);
  });

  expect(socket.destroyed).toBeTrue();
  expect(socket.callbacks).toHaveLength(0);
  expect(errors).toHaveLength(1);
  const error = errors[0];
  expect(error).toBeInstanceOf(DaemonSocketQueueOverflowError);
  if (!(error instanceof DaemonSocketQueueOverflowError)) {
    throw new Error("Expected a typed queue overflow error");
  }
  expect(error.reason).toBe("queue_overflow");
  expect(error.queuedBytes).toBe(
    MAX_QUEUED_BYTES + Buffer.byteLength(JSON.stringify(response) + "\n"),
  );
  expect(error.limitBytes).toBe(MAX_QUEUED_BYTES);
  expect(error.message).toContain("queued bytes exceeded");
});

test("allows one oversized frame in an empty queue but rejects a following write", () => {
  const socket = new BackpressuredSocket();
  const server = connectedServer(new FakeTimer(), socket);
  const firstErrors: Array<Error | null | undefined> = [];
  const rejectedErrors: Array<Error | null | undefined> = [];
  const frame: DaemonResponse = { ...response, result: { data: "x".repeat(MAX_QUEUED_BYTES) } };
  const frameBytes = Buffer.byteLength(JSON.stringify(frame) + "\n");

  server.writeFrameData(socket as unknown as Socket, "session", frame, (error) => {
    firstErrors.push(error);
  });

  expect(socket.destroyed).toBeFalse();
  expect(socket.writableLength).toBe(frameBytes);
  expect(socket.callbacks).toHaveLength(1);
  expect(firstErrors).toHaveLength(0);

  server.writeFrameData(socket as unknown as Socket, "session", response, (error) => {
    rejectedErrors.push(error);
  });

  expect(socket.destroyed).toBeTrue();
  expect(socket.writableLength).toBe(frameBytes);
  expect(socket.callbacks).toHaveLength(1);
  expect(firstErrors).toHaveLength(0);
  expect(rejectedErrors).toHaveLength(1);
  const error = rejectedErrors[0];
  expect(error).toBeInstanceOf(DaemonSocketQueueOverflowError);
  if (!(error instanceof DaemonSocketQueueOverflowError)) {
    throw new Error("Expected a typed queue overflow error");
  }
  expect(error.reason).toBe("queue_overflow");
  expect(error.queuedBytes).toBe(frameBytes + Buffer.byteLength(JSON.stringify(response) + "\n"));
  expect(error.limitBytes).toBe(MAX_QUEUED_BYTES);
});

test("outbound writes cannot keep an unread RPC socket alive", () => {
  const timer = new FakeTimer();
  const socket = new BackpressuredSocket();
  const server = connectedServer(timer, socket);

  server.writeFrameData(socket as unknown as Socket, "session", response);
  for (let index = 0; index < 4; index++) {
    timer.advanceTime(DAEMON_RPC_SOCKET_IDLE_TIMEOUT_MS / 5);
    server.writeFrameData(socket as unknown as Socket, "session", response);
  }
  timer.advanceTime(DAEMON_RPC_SOCKET_IDLE_TIMEOUT_MS / 5);

  expect(socket.destroyed).toBeTrue();
});

test("inbound data and fully flushed writes refresh the RPC idle deadline", () => {
  const timer = new FakeTimer();
  const socket = new BackpressuredSocket();
  const server = connectedServer(timer, socket);

  timer.advanceTime(DAEMON_RPC_SOCKET_IDLE_TIMEOUT_MS - 1);
  socket.emit("data", Buffer.from(""));
  timer.advanceTime(DAEMON_RPC_SOCKET_IDLE_TIMEOUT_MS - 1);
  server.writeFrameData(socket as unknown as Socket, "session", response);
  socket.flush();
  timer.advanceTime(DAEMON_RPC_SOCKET_IDLE_TIMEOUT_MS - 1);
  expect(socket.destroyed).toBeFalse();
  timer.advanceTime(1);
  expect(socket.destroyed).toBeTrue();
});
