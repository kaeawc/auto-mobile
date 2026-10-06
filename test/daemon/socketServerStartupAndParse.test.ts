import { describe, expect, spyOn, test } from "bun:test";
import type { Socket } from "node:net";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import type { DaemonStateAccess } from "../../src/daemon/daemonRequestHandlers";
import { DAEMON_CANCEL_REQUEST_METHOD } from "../../src/daemon/constants";
import type { DaemonResponse } from "../../src/daemon/types";
import { FakeSocket } from "../fakes/FakeNetServer";
import { FakeTimer } from "../fakes/FakeTimer";
import { logger } from "../../src/utils/logger";

interface ServerInternals {
  acceptingRequests: boolean;
  handleConnection(socket: Socket): void;
}

class RpcSocket extends FakeSocket {
  setTimeout(_ms: number): this {
    return this;
  }
}

async function drainHandlers(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    await Promise.resolve();
  }
}

function deferredStartup() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function createHarness(startupCompletion: Promise<void>) {
  const timer = new FakeTimer();
  const state = {
    isInitialized: () => true,
    getSessionManager: () => ({ getSession: () => null }),
    getDevicePool: () => ({ releaseMcpSessionBindings: () => {} }),
  } as unknown as DaemonStateAccess;
  const server = new UnixSocketServer(
    "/fake/socket",
    "http://127.0.0.1:1/mcp",
    state,
    timer,
    null,
    { startupCompletion },
  );
  let forwarded = 0;
  server.mcpClientFactory = async () => ({
    callTool: async () => {
      forwarded++;
      return { content: [] };
    },
    listTools: async () => ({ tools: [] }),
    listResources: async () => ({ resources: [] }),
    readResource: async () => ({ contents: [] }),
    listResourceTemplates: async () => ({ resourceTemplates: [] }),
    close: async () => {},
  });
  const internals = server as unknown as ServerInternals;
  internals.acceptingRequests = true;
  const socket = new RpcSocket();
  internals.handleConnection(socket as unknown as Socket);
  return { socket, timer, forwarded: () => forwarded };
}

function callTool(socket: RpcSocket, timeoutMs = 1_000): void {
  socket.simulateData(
    JSON.stringify({
      id: "call-1",
      type: "mcp_request",
      method: "tools/call",
      params: { name: "testTool", arguments: {} },
      timeoutMs,
    }) + "\n",
  );
}

describe("daemon socket startup and parsing", () => {
  test("holds a tools/call until startup completes, then forwards it", async () => {
    const startup = deferredStartup();
    const harness = createHarness(startup.promise);
    callTool(harness.socket);
    await drainHandlers();
    expect(harness.forwarded()).toBe(0);
    expect(harness.socket.getWrittenMessages()).toHaveLength(0);

    startup.resolve();
    await drainHandlers();
    expect(harness.forwarded()).toBe(1);
    expect(harness.socket.getWrittenMessages<DaemonResponse>()[0]?.success).toBe(true);
    harness.socket.destroy();
  });

  test("holds other forwarded methods while startup is pending", async () => {
    const startup = deferredStartup();
    const harness = createHarness(startup.promise);
    harness.socket.simulateData(
      JSON.stringify({ id: "list-1", type: "mcp_request", method: "tools/list", params: {} }) +
        "\n",
    );
    await drainHandlers();
    expect(harness.socket.getWrittenMessages()).toHaveLength(0);
    startup.resolve();
    await drainHandlers();
    expect(harness.socket.getWrittenMessages<DaemonResponse>()[0]).toMatchObject({
      id: "list-1",
      success: true,
    });
    harness.socket.destroy();
  });

  test("allows the local ping probe during startup", async () => {
    const harness = createHarness(deferredStartup().promise);
    harness.socket.simulateData(
      JSON.stringify({ id: "ping-1", type: "daemon_request", method: "ide/ping" }) + "\n",
    );
    await drainHandlers();
    expect(harness.socket.getWrittenMessages<DaemonResponse>()[0]).toMatchObject({
      id: "ping-1",
      success: true,
    });
    harness.socket.destroy();
  });

  test("returns a structured error if startup fails", async () => {
    const startup = deferredStartup();
    const harness = createHarness(startup.promise);
    callTool(harness.socket);
    await drainHandlers();
    startup.reject(new Error("auxiliary socket failed"));
    await drainHandlers();
    const response = harness.socket.getWrittenMessages<DaemonResponse>()[0];
    expect(response).toMatchObject({ id: "call-1", success: false });
    expect(response?.error).toContain("Daemon startup failed");
    expect(response?.error).toContain("auxiliary socket failed");
    expect(harness.forwarded()).toBe(0);
    harness.socket.destroy();
  });

  test("returns a timeout when the request deadline expires during startup", async () => {
    const harness = createHarness(deferredStartup().promise);
    callTool(harness.socket, 25);
    await drainHandlers();
    harness.timer.advanceTime(25);
    await drainHandlers();
    const response = harness.socket.getWrittenMessages<DaemonResponse>()[0];
    expect(response).toMatchObject({ id: "call-1", success: false });
    expect(response?.error).toContain("Daemon still starting");
    expect(harness.forwarded()).toBe(0);
    harness.socket.destroy();
  });

  test("aborts a startup wait when the client cancels the request", async () => {
    const harness = createHarness(deferredStartup().promise);
    callTool(harness.socket);
    await drainHandlers();
    harness.socket.simulateData(
      JSON.stringify({
        id: "cancel-1",
        type: "daemon_request",
        method: DAEMON_CANCEL_REQUEST_METHOD,
        params: { requestId: "call-1" },
      }) + "\n",
    );
    await drainHandlers();
    const responses = harness.socket.getWrittenMessages<DaemonResponse>();
    expect(responses.find((response) => response.id === "cancel-1")?.success).toBe(true);
    expect(responses.find((response) => response.id === "call-1")?.success).toBe(false);
    expect(harness.forwarded()).toBe(0);
    harness.socket.destroy();
  });

  test("a cancel that arrives after the request was answered is a no-op that leaves a trace (#10151)", async () => {
    const harness = createHarness(Promise.resolve());
    callTool(harness.socket);
    await drainHandlers();
    expect(harness.socket.getWrittenMessages<DaemonResponse>()[0]).toMatchObject({
      id: "call-1",
      success: true,
    });
    const debug = spyOn(logger, "debug").mockImplementation(() => {});
    try {
      harness.socket.simulateData(
        JSON.stringify({
          id: "cancel-1",
          type: "daemon_request",
          method: DAEMON_CANCEL_REQUEST_METHOD,
          params: { requestId: "call-1" },
        }) + "\n",
      );
      await drainHandlers();
      const responses = harness.socket.getWrittenMessages<DaemonResponse>();
      expect(responses.find((response) => response.id === "cancel-1")).toMatchObject({
        success: true,
        result: { cancelled: false },
      });
      // Without this line a cancel that lost the race with the answer is invisible in the daemon
      // log, which made a client that delivered its cancel late look like one that never sent it.
      expect(
        debug.mock.calls.some(
          ([message]) =>
            typeof message === "string" &&
            message.includes("[SocketCancel]") &&
            message.includes("call-1") &&
            message.includes("no in-flight request"),
        ),
      ).toBe(true);
    } finally {
      debug.mockRestore();
      harness.socket.destroy();
    }
  });

  test("uses null id and JSON-RPC parse code for malformed JSON", async () => {
    const harness = createHarness(Promise.resolve());
    harness.socket.simulateData('{"id":"call-1",\n');
    await drainHandlers();
    expect(harness.socket.getWrittenMessages<DaemonResponse>()[0]).toMatchObject({
      id: null,
      success: false,
      code: -32700,
    });
    harness.socket.destroy();
  });

  test("preserves a valid JSON request id when the request shape is invalid", async () => {
    const harness = createHarness(Promise.resolve());
    harness.socket.simulateData('{"id":"bad-1","method":42}\n');
    await drainHandlers();
    expect(harness.socket.getWrittenMessages<DaemonResponse>()[0]).toMatchObject({
      id: "bad-1",
      success: false,
      code: -32600,
    });
    harness.socket.destroy();
  });
});
