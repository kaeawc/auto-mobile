import { FakeSocket } from "../fakes/FakeNetServer";
import { createHarnessServer } from "./helpers/UnixSocketServerHarness";
import { expect, test } from "bun:test";
import type { DaemonStateAccess } from "../../src/daemon/daemonRequestHandlers";
import { DAEMON_SUBSCRIBE_NOTIFICATIONS_METHOD } from "../../src/daemon/wire/constants";
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
  const server = createHarnessServer("unused", state, timer);
  const socket = new FakeSocket();
  server.allowRequests();
  server.connect(socket);
  socket.send({
    id: "subscribe",
    type: "mcp_request",
    method: DAEMON_SUBSCRIBE_NOTIFICATIONS_METHOD,
    params: {},
  });
  socket.send({ id: "running", type: "mcp_request", method: "daemon/refreshDevices", params: {} });
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
