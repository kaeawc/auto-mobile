import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { expect, test } from "bun:test";
import type { DaemonStateAccess } from "../../src/daemon/daemonRequestHandlers";
import { DAEMON_SUBSCRIBE_NOTIFICATIONS_METHOD } from "../../src/daemon/constants";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import type { DaemonResponse } from "../../src/daemon/types";
import { FakeTimer } from "../fakes/FakeTimer";

/**
 * A request the daemon refuses at shutdown is answered with a failure FRAME that carries the
 * typed refusal only in the nested `daemonShuttingDown` object. The runners read the fields of
 * the refusal-wire fixtures at the top level of a frame or inside a tool result:
 *  - Kotlin `AutoMobilePlanExecutor.parseDaemonToolResult` (line ~898): `!response.success`
 *    returns `ParsedToolResult(false, response.error)` with `retryable = false` and no code, and
 *    `DaemonResponse` has no `code`/`retryable`/`daemonShuttingDown` field, so the verdict is
 *    FAIL; `isTransientError` does not match "Daemon is shutting down" either.
 *  - Swift `AutoMobileDaemonClient.sendRequest` turns every `success: false` frame into
 *    `MCPClientError.serverError`, whose `isRetryable` is true, so it retries by accident.
 * The fixture `daemon_shutting_down` (expectations.json) says the disposition is "retry", and the
 * other socket-frame refusals (socket-frame.daemon_session_suspect) carry `code` and `retryable`
 * at the top level of the frame.
 */
class FrameSocket extends EventEmitter {
  destroyed = false;
  writableLength = 0;
  readonly responses: DaemonResponse[] = [];

  setTimeout(_ms: number): this {
    return this;
  }

  write(payload: string, callback: (error?: Error | null) => void): boolean {
    this.responses.push(JSON.parse(payload) as DaemonResponse);
    callback();
    return true;
  }

  end(): this {
    this.destroy();
    return this;
  }

  destroy(): this {
    if (!this.destroyed) {
      this.destroyed = true;
      this.emit("close", false);
    }
    return this;
  }

  send(frame: object): void {
    this.emit("data", Buffer.from(`${JSON.stringify(frame)}\n`));
  }
}

test("a tools/call refused at shutdown carries the typed code and retryable at the top of the frame", async () => {
  const timer = new FakeTimer();
  const started = Promise.withResolvers<void>();
  const refresh = Promise.withResolvers<number>();
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
        started.resolve();
        return refresh.promise;
      },
      getStats: () => ({ total: 0, idle: 0, assigned: 0, error: 0 }),
      releaseDevice: async () => {},
    }),
    getDeviceSessionRegistry: () => ({ list: () => [] }),
  };
  const server = new UnixSocketServer("unused", "http://localhost:0/mcp", state, timer);
  const internals = server as unknown as {
    acceptingRequests: boolean;
    handleConnection(socket: Socket): void;
  };
  const socket = new FrameSocket();
  internals.acceptingRequests = true;
  internals.handleConnection(socket as unknown as Socket);
  socket.send({
    id: "subscribe",
    type: "mcp_request",
    method: DAEMON_SUBSCRIBE_NOTIFICATIONS_METHOD,
  });
  socket.send({ id: "running", type: "mcp_request", method: "daemon/refreshDevices" });
  await started.promise;
  socket.send({
    id: "queued",
    type: "mcp_request",
    method: "tools/call",
    params: { name: "executePlan", arguments: {} },
  });
  const quiesce = server.quiesce();
  refresh.resolve(0);
  await quiesce;

  const frame = socket.responses.find((response) => response.id === "queued");
  expect(frame).toBeDefined();
  expect(frame?.success).toBe(false);
  // The typed refusal exists only under `daemonShuttingDown` today.
  expect(frame?.daemonShuttingDown).toMatchObject({
    code: "daemon_shutting_down",
    retryable: true,
  });
  expect(frame).toMatchObject({ code: "daemon_shutting_down", retryable: true });
});
