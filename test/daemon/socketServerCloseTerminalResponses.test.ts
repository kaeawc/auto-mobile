import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { expect, test } from "bun:test";
import type { DaemonStateAccess } from "../../src/daemon/daemonRequestHandlers";
import {
  daemonShuttingDownFailureFromToolResult,
  daemonShuttingDownMcpOutcome,
} from "../../src/daemon/daemonShutdownOutcome";
import { DAEMON_SUBSCRIBE_NOTIFICATIONS_METHOD } from "../../src/daemon/constants";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import type { DaemonResponse } from "../../src/daemon/types";
import { FakeTimer } from "../fakes/FakeTimer";

// Match the private shutdown bounds without exposing production-only constants.
const REQUEST_DRAIN_MS = 1_000;
const WRITE_DRAIN_MS = 1_000;

test("shutdown tool results preserve only a true dispatch marker in the wire failure", () => {
  expect(
    daemonShuttingDownFailureFromToolResult({
      structuredContent: daemonShuttingDownMcpOutcome(true),
    }),
  ).toEqual({ code: "daemon_shutting_down", retryable: true, requestMayHaveDispatched: true });
  expect(
    daemonShuttingDownFailureFromToolResult({
      structuredContent: daemonShuttingDownMcpOutcome(),
    }),
  ).toEqual({ code: "daemon_shutting_down", retryable: true });
  expect(
    daemonShuttingDownFailureFromToolResult({
      structuredContent: {
        error: { ...daemonShuttingDownMcpOutcome().error, requestMayHaveDispatched: "true" },
      },
    }),
  ).toEqual({ code: "daemon_shutting_down", retryable: true });
});

class TerminalSocket extends EventEmitter {
  destroyed = false;
  writableLength = 0;
  readonly responses: DaemonResponse[] = [];
  readonly events: string[] = [];

  constructor(private readonly peerCloses = true) {
    super();
  }

  setTimeout(_ms: number): this {
    return this;
  }

  write(payload: string, callback: (error?: Error | null) => void): boolean {
    const response = JSON.parse(payload) as DaemonResponse;
    this.responses.push(response);
    this.events.push(`write:${response.id}`);
    if (!this.peerCloses) {
      this.writableLength += Buffer.byteLength(payload);
      return false;
    }
    callback();
    return true;
  }

  end(): this {
    this.events.push("end");
    if (this.peerCloses) {
      this.destroy();
    }
    return this;
  }

  destroy(): this {
    if (!this.destroyed) {
      this.events.push("destroy");
      this.destroyed = true;
      this.emit("close", false);
    }
    return this;
  }

  /** Opt in to notifications so quiesce keeps this socket open, as a bound proxy's is. */
  subscribe(): void {
    const frame = {
      id: "subscribe",
      type: "mcp_request",
      method: DAEMON_SUBSCRIBE_NOTIFICATIONS_METHOD,
    };
    this.emit("data", Buffer.from(`${JSON.stringify(frame)}\n`));
  }

  send(id: string): void {
    this.emit(
      "data",
      Buffer.from(
        `${JSON.stringify({ id, type: "mcp_request", method: "daemon/refreshDevices" })}\n`,
      ),
    );
  }
}

interface SocketServerInternals {
  acceptingRequests: boolean;
  handleConnection(socket: Socket): void;
  activeRequestHandlers: Set<Promise<void>>;
}

function createHarness(peerCloses = true) {
  const timer = new FakeTimer();
  const started = Promise.withResolvers<void>();
  const refresh = Promise.withResolvers<number>();
  let refreshStarts = 0;
  const state: DaemonStateAccess = {
    isInitialized: () => true,
    getSessionManager: () => ({
      hasSession: () => false,
      getSession: () => null,
      getDeviceLabels: () => undefined,
      releaseSession: async () => null,
    }),
    getDevicePool: () => ({
      refreshDevices: () => {
        refreshStarts += 1;
        started.resolve();
        return refresh.promise;
      },
      getStats: () => ({ total: 0, idle: 0, assigned: 0, error: 0 }),
      releaseDevice: async () => {},
    }),
    getDeviceSessionRegistry: () => ({ list: () => [] }),
  };
  const server = new UnixSocketServer("unused", "http://localhost:0/mcp", state, timer);
  const internals = server as unknown as SocketServerInternals;
  const socket = new TerminalSocket(peerCloses);
  internals.acceptingRequests = true;
  internals.handleConnection(socket as unknown as Socket);
  return { server, internals, socket, timer, started, refresh, refreshStarts: () => refreshStarts };
}

function expectShutdown(socket: TerminalSocket, id: string, possiblyDispatched: boolean): void {
  const frames = socket.responses.filter((response) => response.id === id);
  expect(frames).toHaveLength(1);
  expect(frames[0]).toMatchObject({
    type: "mcp_response",
    success: false,
    daemonShuttingDown: { code: "daemon_shutting_down", retryable: true },
  });
  expect(frames[0]?.daemonShuttingDown?.requestMayHaveDispatched).toBe(
    possiblyDispatched ? true : undefined,
  );
}

test("an admitted handler settling inside the drain writes its real response before end", async () => {
  const { server, socket, timer, started, refresh } = createHarness();
  socket.send("settled");
  await started.promise;
  const close = server.close();
  timer.advanceTime(REQUEST_DRAIN_MS - 1);
  expect(socket.events).toEqual([]);
  refresh.resolve(2);
  await close;

  expect(socket.responses).toEqual([
    expect.objectContaining({
      id: "settled",
      success: true,
      result: expect.objectContaining({ addedDevices: 2 }),
    }),
  ]);
  expect(socket.events).toEqual(["write:settled", "end", "destroy"]);
  expect(timer.getPendingTimeoutCount()).toBe(0);
});

test("a stalled admitted handler gets one possibly-dispatched shutdown frame before end", async () => {
  const { server, internals, socket, timer, started, refresh } = createHarness();
  socket.send("stalled");
  await started.promise;
  const handlers = [...internals.activeRequestHandlers];
  const close = server.close();
  timer.advanceTime(REQUEST_DRAIN_MS - 1);
  expect(socket.events).toEqual([]);
  timer.advanceTime(2);
  await close;

  expectShutdown(socket, "stalled", true);
  expect(socket.events).toEqual(["write:stalled", "end", "destroy"]);
  // A late completion must not produce a second terminal response.
  refresh.resolve(0);
  await Promise.all(handlers);
  expect(socket.responses).toHaveLength(1);
});

test("a queued successor gets one undispatched shutdown frame without reaching its handler", async () => {
  const { server, internals, socket, timer, started, refresh, refreshStarts } = createHarness();
  socket.send("stalled");
  await started.promise;
  socket.send("queued");
  const handlers = [...internals.activeRequestHandlers];
  const close = server.close();
  expectShutdown(socket, "queued", false);
  expect(socket.events).toEqual(["write:queued"]);
  timer.advanceTime(REQUEST_DRAIN_MS);
  await close;

  expectShutdown(socket, "queued", false);
  expect(socket.events).toEqual(["write:queued", "write:stalled", "end", "destroy"]);
  refresh.resolve(0);
  await Promise.all(handlers);
  expect(refreshStarts()).toBe(1);
  expect(socket.responses).toHaveLength(2);
});

test("a request queued before quiesce is refused as undispatched when the earlier request ends", async () => {
  const { server, internals, socket, timer, started, refresh, refreshStarts } = createHarness();
  socket.subscribe();
  socket.send("running");
  await started.promise;
  socket.send("queued");
  const handlers = [...internals.activeRequestHandlers];
  const quiesce = server.quiesce();
  // The drain bound passes with the first request still running, as when session
  // release is about to cancel it.
  timer.advanceTime(REQUEST_DRAIN_MS);
  await quiesce;
  // The earlier request ending frees the queue; the queued one must not start now.
  refresh.resolve(1);
  await Promise.all(handlers);

  expectShutdown(socket, "queued", false);
  expect(refreshStarts()).toBe(1);
  expect(socket.responses.filter((response) => response.id === "queued")).toHaveLength(1);
  expect(socket.responses.find((response) => response.id === "running")).toMatchObject({
    success: true,
    result: expect.objectContaining({ addedDevices: 1 }),
  });

  // close() later must not answer the refused request a second time or flag it dispatched.
  await server.close();
  expect(socket.responses.filter((response) => response.id === "queued")).toHaveLength(1);
  expectShutdown(socket, "queued", false);
});

test("a request already running when quiesce begins still completes with its real response", async () => {
  const { server, socket, started, refresh } = createHarness();
  socket.subscribe();
  socket.send("running");
  await started.promise;
  const quiesce = server.quiesce();
  refresh.resolve(3);
  await quiesce;

  expect(socket.responses.find((response) => response.id === "running")).toMatchObject({
    success: true,
    result: expect.objectContaining({ addedDevices: 3 }),
  });
});

test("a request arriving during close is refused as undispatched without reaching its handler", async () => {
  const { server, socket, timer, started, refreshStarts } = createHarness();
  socket.send("stalled");
  await started.promise;
  const close = server.close();
  socket.send("refused");
  await Promise.resolve();
  expectShutdown(socket, "refused", false);
  expect(refreshStarts()).toBe(1);
  timer.advanceTime(REQUEST_DRAIN_MS);
  await close;

  expectShutdown(socket, "refused", false);
  expect(socket.events).toEqual(["write:refused", "write:stalled", "end", "destroy"]);
});

test("an unread socket is force-destroyed at the injected write-drain bound", async () => {
  const { server, socket, timer, started } = createHarness(false);
  socket.send("stalled");
  await started.promise;
  const close = server.close();
  timer.advanceTime(REQUEST_DRAIN_MS);
  await close;

  expect(socket.responses).toHaveLength(1);
  expect(socket.events).toEqual(["write:stalled", "end"]);
  expect(socket.destroyed).toBeFalse();
  timer.advanceTime(WRITE_DRAIN_MS - 1);
  expect(socket.destroyed).toBeFalse();
  timer.advanceTime(1);
  expect(socket.events).toEqual(["write:stalled", "end", "destroy"]);
  expect(socket.destroyed).toBeTrue();
  expect(timer.getPendingTimeoutCount()).toBe(0);
});
