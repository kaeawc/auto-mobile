import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { expect, test } from "bun:test";
import { DaemonSocketQueueOverflowError, UnixSocketServer } from "../../src/daemon/socketServer";
import type { DaemonRequest, DaemonResponse } from "../../src/daemon/types";
import { McpTimeoutError } from "../../src/daemon/McpTimeoutError";
import { ProgressExtendableDeadline } from "../../src/daemon/mcpRequestTimeout";
import {
  DAEMON_CANCEL_REQUEST_METHOD,
  DAEMON_HEARTBEAT_METHOD,
  DAEMON_SUBSCRIBE_NOTIFICATIONS_METHOD,
} from "../../src/daemon/constants";
import { DAEMON_RPC_SOCKET_IDLE_TIMEOUT_MS } from "../../src/utils/deviceTimeouts";
import { FakeTimer } from "../fakes/FakeTimer";

const MAX_QUEUED_BYTES = 1024 * 1024;

class BackpressuredSocket extends EventEmitter {
  destroyed = false;
  writableLength = 0;
  readonly callbacks: Array<(error?: Error | null) => void> = [];
  readonly writes: string[] = [];
  readonly timeouts: number[] = [];
  backpressure = true;

  setTimeout(ms: number): this {
    this.timeouts.push(ms);
    return this;
  }

  write(payload: string, callback: (error?: Error | null) => void): boolean {
    this.writes.push(payload);
    this.writableLength += Buffer.byteLength(payload);
    this.callbacks.push(callback);
    return !this.backpressure;
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
  handleLocalSocketRequest(request: DaemonRequest): Promise<unknown>;
  handleRequest(
    sessionId: string,
    socket: Socket,
    request: DaemonRequest,
    receivedAtMs: number,
    onAdmitted?: (deadline: ProgressExtendableDeadline) => void,
  ): Promise<DaemonResponse | undefined>;
  pendingSocketRequests: Set<unknown>;
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

const longBudgetMs = 20 * 60 * 1000;

function sendRequest(socket: BackpressuredSocket, id = "silent", timeoutMs = longBudgetMs): void {
  const request: DaemonRequest = {
    id,
    type: "mcp_request",
    method: "tools/call",
    params: { name: "tapOn", arguments: { deviceId: id } },
    timeoutMs,
  };
  socket.emit("data", Buffer.from(JSON.stringify(request) + "\n"));
}

async function settleHandlers(): Promise<void> {
  for (let index = 0; index < 30; index++) {
    await Promise.resolve();
  }
}

test.each(["native", "flushed backpressure"])(
  "silent 20-minute request survives %s idle expiry and delivers its deadline answer",
  async (idlePath) => {
    const timer = new FakeTimer();
    const socket = new BackpressuredSocket();
    socket.backpressure = false;
    const server = connectedServer(timer, socket);
    if (idlePath === "flushed backpressure") {
      socket.backpressure = true;
      server.writeFrameData(socket as unknown as Socket, "session", response);
      socket.flush();
      socket.writes.length = 0;
      socket.backpressure = false;
    }
    server.handleLocalSocketRequest = async () =>
      new Promise<never>((_resolve, reject) => {
        timer.setTimeout(
          () =>
            reject(
              new McpTimeoutError({
                toolName: "tapOn",
                timeoutMs: longBudgetMs,
                origin: "fake handler",
              }),
            ),
          longBudgetMs,
        );
      });
    sendRequest(socket);
    await settleHandlers();
    timer.advanceTime(DAEMON_RPC_SOCKET_IDLE_TIMEOUT_MS);
    if (idlePath === "native") {
      socket.emit("timeout");
    }
    expect(socket.destroyed).toBeFalse();
    timer.advanceTime(longBudgetMs - DAEMON_RPC_SOCKET_IDLE_TIMEOUT_MS);
    await settleHandlers();
    expect(socket.destroyed).toBeFalse();
    expect(socket.writes.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({
        id: "silent",
        success: false,
        error: expect.stringContaining("1200000ms"),
      }),
    ]);
    socket.flush();
    timer.advanceTime(DAEMON_RPC_SOCKET_IDLE_TIMEOUT_MS - 1);
    expect(socket.destroyed).toBeFalse();
    timer.advanceTime(1);
    expect(socket.destroyed).toBeTrue();
  },
);

test("a request exactly at the idle limit survives an idle event racing its answer", async () => {
  const timer = new FakeTimer();
  const socket = new BackpressuredSocket();
  socket.backpressure = false;
  const server = connectedServer(timer, socket);
  const completed = Promise.withResolvers<unknown>();
  server.handleLocalSocketRequest = () => completed.promise;
  sendRequest(socket, "boundary", DAEMON_RPC_SOCKET_IDLE_TIMEOUT_MS);
  await settleHandlers();
  timer.advanceTime(DAEMON_RPC_SOCKET_IDLE_TIMEOUT_MS);
  socket.emit("timeout");
  expect(socket.destroyed).toBeFalse();
  completed.resolve({ answered: true });
  await settleHandlers();
  expect(socket.writes.map((line) => JSON.parse(line))).toEqual([
    expect.objectContaining({ id: "boundary", success: true, result: { answered: true } }),
  ]);
  socket.flush();
  socket.emit("timeout");
  expect(socket.destroyed).toBeTrue();
});

test.each(["queued", "empty"])(
  "terminal flush with %s frames preserves the timer-mode idle backpressure rule",
  async (queueState) => {
    const timer = new FakeTimer();
    const socket = new BackpressuredSocket();
    const server = connectedServer(timer, socket);
    const completed = Promise.withResolvers<unknown>();
    server.handleLocalSocketRequest = () => completed.promise;
    sendRequest(socket);
    await settleHandlers();
    completed.resolve({});
    await settleHandlers();
    expect(socket.timeouts).toEqual([DAEMON_RPC_SOCKET_IDLE_TIMEOUT_MS, 0]);
    expect(timer.getPendingTimeoutCount()).toBe(1);
    expect(server.pendingSocketRequests.size).toBe(1);

    if (queueState === "queued") {
      server.writeFrameData(socket as unknown as Socket, "session", response);
    }
    timer.advanceTime(DAEMON_RPC_SOCKET_IDLE_TIMEOUT_MS / 2);
    // Flush only the terminal response, without emitting drain for later frames.
    socket.writableLength -= Buffer.byteLength(socket.writes[0]!);
    socket.callbacks.shift()!();
    expect(socket.writableLength > 0).toBe(queueState === "queued");
    expect(server.pendingSocketRequests.size).toBe(0);
    expect(timer.getPendingTimeoutCount()).toBe(1);

    timer.advanceTime(DAEMON_RPC_SOCKET_IDLE_TIMEOUT_MS / 2 - 1);
    expect(socket.destroyed).toBeFalse();
    timer.advanceTime(1);
    expect(socket.destroyed).toBe(queueState === "queued");
    if (queueState === "empty") {
      timer.advanceTime(DAEMON_RPC_SOCKET_IDLE_TIMEOUT_MS / 2 - 1);
      expect(socket.destroyed).toBeFalse();
      timer.advanceTime(1);
      expect(socket.destroyed).toBeTrue();
    }
    expect(timer.getPendingTimeoutCount()).toBe(0);
  },
);

test.each(["queued", "empty"])(
  "terminal flush with %s frames resets a fresh full native idle window",
  async (queueState) => {
    const timer = new FakeTimer();
    const socket = new BackpressuredSocket();
    socket.backpressure = false;
    const server = connectedServer(timer, socket);
    const completed = Promise.withResolvers<unknown>();
    server.handleLocalSocketRequest = () => completed.promise;
    sendRequest(socket);
    await settleHandlers();
    timer.advanceTime(DAEMON_RPC_SOCKET_IDLE_TIMEOUT_MS - 1);
    completed.resolve({});
    await settleHandlers();
    expect(server.pendingSocketRequests.size).toBe(1);
    if (queueState === "queued") {
      server.writeFrameData(socket as unknown as Socket, "session", response);
    }
    expect(timer.getPendingTimeoutCount()).toBe(0);
    socket.writableLength -= Buffer.byteLength(socket.writes[0]!);
    socket.callbacks.shift()!();
    expect(socket.writableLength > 0).toBe(queueState === "queued");
    expect(server.pendingSocketRequests.size).toBe(0);
    expect(socket.timeouts).toEqual([
      DAEMON_RPC_SOCKET_IDLE_TIMEOUT_MS,
      DAEMON_RPC_SOCKET_IDLE_TIMEOUT_MS,
    ]);
    socket.emit("timeout");
    expect(socket.destroyed).toBeTrue();
  },
);

test("native idle expiry still destroys a socket without in-flight requests", () => {
  const socket = new BackpressuredSocket();
  connectedServer(new FakeTimer(), socket);
  socket.emit("timeout");
  expect(socket.destroyed).toBeTrue();
});

test("all in-flight responses must flush before ordinary idle protection resumes", async () => {
  const timer = new FakeTimer();
  const socket = new BackpressuredSocket();
  socket.backpressure = false;
  const server = connectedServer(timer, socket);
  const first = Promise.withResolvers<unknown>();
  const second = Promise.withResolvers<unknown>();
  server.handleLocalSocketRequest = (request) =>
    request.id === "first" ? first.promise : second.promise;
  sendRequest(socket, "first");
  sendRequest(socket, "second");
  await settleHandlers();
  first.resolve({});
  await settleHandlers();
  socket.flush();
  socket.emit("timeout");
  expect(socket.destroyed).toBeFalse();
  second.resolve({});
  await settleHandlers();
  expect(server.pendingSocketRequests.size).toBe(1);
  socket.flush();
  expect(server.pendingSocketRequests.size).toBe(0);
  timer.advanceTime(DAEMON_RPC_SOCKET_IDLE_TIMEOUT_MS - 1);
  expect(socket.destroyed).toBeFalse();
  timer.advanceTime(1);
  expect(socket.destroyed).toBeTrue();
});

test("an in-flight request cannot keep an unread backpressured socket alive", async () => {
  const timer = new FakeTimer();
  const socket = new BackpressuredSocket();
  const server = connectedServer(timer, socket);
  const completed = Promise.withResolvers<unknown>();
  server.handleLocalSocketRequest = () => completed.promise;
  sendRequest(socket);
  await settleHandlers();
  server.writeFrameData(socket as unknown as Socket, "session", response);
  timer.advanceTime(DAEMON_RPC_SOCKET_IDLE_TIMEOUT_MS);
  expect(socket.destroyed).toBeTrue();
  expect(server.pendingSocketRequests.size).toBe(0);
  completed.resolve({});
  await settleHandlers();
});

test.each([
  DAEMON_HEARTBEAT_METHOD,
  DAEMON_CANCEL_REQUEST_METHOD,
  DAEMON_SUBSCRIBE_NOTIFICATIONS_METHOD,
])("%s without a terminal answer does not exempt its socket from idle expiry", async (method) => {
  const timer = new FakeTimer();
  const socket = new BackpressuredSocket();
  const server = connectedServer(timer, socket);
  const completed = Promise.withResolvers<DaemonResponse | undefined>();
  server.handleRequest = () => completed.promise;
  socket.emit(
    "data",
    Buffer.from(JSON.stringify({ id: "control", type: "mcp_request", method }) + "\n"),
  );
  timer.advanceTime(DAEMON_RPC_SOCKET_IDLE_TIMEOUT_MS);
  socket.emit("timeout");
  expect(socket.destroyed).toBeTrue();
  expect(server.pendingSocketRequests.size).toBe(0);
  completed.resolve(undefined);
  await settleHandlers();
});

test("a never-answering handler loses its idle exemption after its request deadline", async () => {
  const timer = new FakeTimer();
  const socket = new BackpressuredSocket();
  const server = connectedServer(timer, socket);
  const completed = Promise.withResolvers<unknown>();
  server.handleLocalSocketRequest = () => completed.promise;
  sendRequest(socket);
  await settleHandlers();
  timer.advanceTime(DAEMON_RPC_SOCKET_IDLE_TIMEOUT_MS);
  socket.emit("timeout");
  expect(socket.destroyed).toBeFalse();
  timer.advanceTime(DAEMON_RPC_SOCKET_IDLE_TIMEOUT_MS);
  expect(socket.destroyed).toBeTrue();
  expect(server.pendingSocketRequests.size).toBe(0);
  expect(timer.getPendingTimeoutCount()).toBe(0);
  completed.resolve({});
  await settleHandlers();
});

test("idle exemption follows the live progress-extended deadline", async () => {
  const timer = new FakeTimer();
  const socket = new BackpressuredSocket();
  const server = connectedServer(timer, socket);
  const completed = Promise.withResolvers<DaemonResponse | undefined>();
  const deadline = new ProgressExtendableDeadline(0, longBudgetMs, 40 * 60 * 1000);
  server.handleRequest = (_sessionId, _socket, _request, _receivedAtMs, onAdmitted) => {
    onAdmitted?.(deadline);
    return completed.promise;
  };
  sendRequest(socket);
  timer.advanceTime(DAEMON_RPC_SOCKET_IDLE_TIMEOUT_MS);
  socket.emit("timeout");
  expect(socket.destroyed).toBeFalse();
  deadline.extendOnProgress(timer.now(), longBudgetMs);
  timer.advanceTime(DAEMON_RPC_SOCKET_IDLE_TIMEOUT_MS);
  expect(socket.destroyed).toBeFalse();
  timer.advanceTime(DAEMON_RPC_SOCKET_IDLE_TIMEOUT_MS);
  expect(socket.destroyed).toBeTrue();
  completed.resolve(undefined);
  await settleHandlers();
});
