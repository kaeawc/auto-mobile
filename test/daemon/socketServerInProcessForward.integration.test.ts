import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod/v4";
import { DAEMON_CANCEL_REQUEST_METHOD } from "../../src/daemon/wire/constants";
import { InProcessMcpDispatcher } from "../../src/daemon/inProcessMcpDispatcher";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import type { StatelessMcpRequestScope } from "../../src/daemon/statelessMcpHttpEndpoint";
import { createStatelessMcpServer } from "../../src/daemon/statelessMcpServerFactory";
import type { DaemonResponse } from "../../src/daemon/types";
import { getToolSelectionContext } from "../../src/features/toolSelection/toolSelectionContext";
import { executionTracker } from "../../src/daemon/executionTracker";
import { SessionToolBindingStore } from "../../src/server/sessionToolBindingStore";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { defaultTimer } from "../../src/utils/SystemTimer";
import { fakeBindLock } from "../helpers/createTestUnixSocketServer";
import { installHermeticServerFixture } from "../helpers/hermeticServerFixture";
import {
  SOCKET_REQUEST_DEADLINE_MS,
  sendPersistentSocketRequest,
  sendRawSocketRequest,
  sendRequestOnPersistentSocket,
} from "./helpers/socketRequest";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";

/**
 * Control-socket forwards run in process (#11820): every forward reaches its own real
 * `createMcpServer` through the daemon's `InProcessMcpDispatcher`, keyed on the socket session that
 * sent it. Only the device boundary (hermetic fixture) and the daemon state are fake.
 */
const PROBE_TOOL = "inProcessForwardProbe";
const HOLD_TOOL = "inProcessForwardHold";

function fakeDaemonState() {
  return {
    isInitialized: () => true,
    getSessionManager: () => ({
      hasSession: () => false,
      getSession: () => null,
      getDeviceLabels: () => undefined,
      releaseSession: async () => null,
    }),
    getDevicePool: () => ({
      refreshDevices: async () => 0,
      getStats: () => ({ total: 0, idle: 0, assigned: 0, error: 0 }),
      releaseDevice: async () => {},
      resolveAutolockSessionForMcpSession: () => undefined,
    }),
    getDeviceSessionRegistry: () => new DeviceSessionRegistry(),
  };
}

function toolText(response: DaemonResponse): string {
  const result = response.result as { content?: Array<{ text?: string }> } | undefined;
  return result?.content?.[0]?.text ?? "";
}

describe("control-socket forwards through the in-process MCP dispatcher", () => {
  let restoreFixture: () => void;
  let socketServer: UnixSocketServer;
  let dispatcher: InProcessMcpDispatcher;
  let socketPath: string;
  let scopes: StatelessMcpRequestScope[];
  /** The session key the probe's tools/call ran under (its in-band key). */
  let probeCallerKeys: Array<string | undefined>;
  let holdStarted: ((signal: AbortSignal | undefined) => void) | undefined;
  let holdAborted: (() => void) | undefined;

  beforeAll(() => {
    restoreFixture = installHermeticServerFixture();
    ToolRegistry.register(PROBE_TOOL, "test probe", z.object({}), async () => {
      probeCallerKeys.push(getToolSelectionContext()?.callerMcpSessionId);
      return { content: [{ type: "text", text: "probe ok" }] };
    });
    ToolRegistry.register(
      HOLD_TOOL,
      "test hold",
      z.object({}),
      async (_args, _progress, signal) => {
        holdStarted?.(signal);
        await new Promise<void>((resolve) => {
          if (signal?.aborted) {
            resolve();
            return;
          }
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        holdAborted?.();
        return { content: [{ type: "text", text: "hold aborted" }] };
      },
    );
  });

  afterAll(() => {
    ToolRegistry.unregister(PROBE_TOOL);
    ToolRegistry.unregister(HOLD_TOOL);
    restoreFixture();
  });

  beforeEach(async () => {
    scopes = [];
    probeCallerKeys = [];
    const store = new SessionToolBindingStore();
    dispatcher = new InProcessMcpDispatcher({
      idGenerator: new CountingIdGenerator(`scope-${randomUUID()}`),
      createServer: (context, scope) => {
        scopes.push(scope);
        return createStatelessMcpServer({ sessionToolBindingStore: store }, context, scope);
      },
      cancelScopeExecutions: (scope, reason) =>
        executionTracker.cancelSessionExecutions(scope, reason),
      forgetScopeBindings: (scope) => store.forget(scope),
      closeReason: () => "mcp_forward_closed",
    });
    socketPath = join(tmpdir(), `mcp-ip-${randomUUID().slice(0, 8)}.sock`);
    socketServer = new UnixSocketServer(
      socketPath,
      fakeDaemonState(),
      defaultTimer,
      null,
      { mcpDispatcher: dispatcher },
      new CountingIdGenerator("socket"),
      { bindLock: fakeBindLock },
    );
    await socketServer.start();
  });

  afterEach(async () => {
    holdStarted = undefined;
    holdAborted = undefined;
    await socketServer.close();
    if (existsSync(socketPath)) {
      await unlink(socketPath);
    }
  });

  const callTool = async (name: string): Promise<DaemonResponse> =>
    (
      await sendRawSocketRequest(socketPath, {
        id: randomUUID(),
        type: "mcp_request",
        method: "tools/call",
        params: { name, arguments: {} },
      })
    ).response;

  test("every forward's server is keyed on the socket session that sent it", async () => {
    const first = await callTool(PROBE_TOOL);
    const second = await callTool(PROBE_TOOL);

    expect(toolText(first)).toBe("probe ok");
    expect(toolText(second)).toBe("probe ok");
    const keys = scopes.map((scope) => scope.requestMcpSessionId);
    expect(new Set(keys).size).toBe(2);
    expect(keys.every((key) => key?.startsWith("socket-"))).toBe(true);
    // Each forward closed its client and server when it ended.
    expect(dispatcher.inFlightCount).toBe(0);
  });

  test("tools/list and tools/call on one connection bind under the same session key (#13062)", async () => {
    const { response: list, socket } = await sendPersistentSocketRequest(
      socketPath,
      "tools/list",
      {},
    );
    try {
      const call = await sendRequestOnPersistentSocket(socket, "tools/call", {
        name: PROBE_TOOL,
        arguments: {},
      });

      expect(list.success).toBe(true);
      expect(toolText(call)).toBe("probe ok");
      // The list's server key (what tools/list and resources bind under) is the call's key.
      const [listScope, callScope] = scopes;
      expect(listScope.requestMcpSessionId).toStartWith("socket-");
      expect(callScope.requestMcpSessionId).toBe(listScope.requestMcpSessionId);
      expect(probeCallerKeys).toEqual([listScope.requestMcpSessionId]);
      // A fresh server per forward: no state rides on a pooled client.
      expect(listScope.requestScopeId).not.toBe(callScope.requestScopeId);
    } finally {
      socket.destroy();
    }
  });

  test("a socket cancel frame stops the forwarded call at once (#13067)", async () => {
    const started = new Promise<AbortSignal | undefined>((resolve) => {
      holdStarted = resolve;
    });
    const aborted = new Promise<void>((resolve) => {
      holdAborted = resolve;
    });
    const socket = new Socket();
    const deadline = defaultTimer.setTimeout(() => socket.destroy(), SOCKET_REQUEST_DEADLINE_MS);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.connect(socketPath, resolve);
      });
      const send = (frame: Record<string, unknown>) => socket.write(`${JSON.stringify(frame)}\n`);
      send({
        id: "hold",
        type: "mcp_request",
        method: "tools/call",
        params: { name: HOLD_TOOL, arguments: {} },
      });
      const signal = await started;
      const socketSessionId = scopes.at(-1)?.requestMcpSessionId ?? "";
      expect(executionTracker.hasActiveSessionExecutions(socketSessionId)).toBe(true);

      send({
        id: "cancel",
        type: "daemon_request",
        method: DAEMON_CANCEL_REQUEST_METHOD,
        params: { requestId: "hold" },
      });
      await aborted;

      // The handler stopped while the socket is still open: the cancel, not a disconnect.
      expect(signal?.aborted).toBe(true);
      expect(socket.destroyed).toBe(false);
    } finally {
      defaultTimer.clearTimeout(deadline);
      socket.destroy();
    }
  });

  test("a socket disconnect cancels the execution keyed on its session id", async () => {
    const started = new Promise<AbortSignal | undefined>((resolve) => {
      holdStarted = resolve;
    });
    const aborted = new Promise<void>((resolve) => {
      holdAborted = resolve;
    });
    const cancelSessionExecutions = executionTracker.cancelSessionExecutions.bind(executionTracker);
    let recordDisconnectCancel!: (cancel: { key: string; cancelled: number }) => void;
    const disconnectCancel = new Promise<{ key: string; cancelled: number }>((resolve) => {
      recordDisconnectCancel = resolve;
    });
    const spy = spyOn(executionTracker, "cancelSessionExecutions").mockImplementation(
      async (key, reason) => {
        const cancelled = await cancelSessionExecutions(key, reason);
        if (reason === "socket_disconnect") {
          recordDisconnectCancel({ key, cancelled });
        }
        return cancelled;
      },
    );
    const socket = new Socket();
    const deadline = defaultTimer.setTimeout(() => socket.destroy(), SOCKET_REQUEST_DEADLINE_MS);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("error", reject);
        socket.connect(socketPath, resolve);
      });
      socket.write(
        `${JSON.stringify({
          id: randomUUID(),
          type: "mcp_request",
          method: "tools/call",
          params: { name: HOLD_TOOL, arguments: {} },
        })}\n`,
      );
      const signal = await started;
      const socketSessionId = scopes.at(-1)?.requestMcpSessionId ?? "";
      expect(socketSessionId).toStartWith("socket-");
      expect(executionTracker.hasActiveSessionExecutions(socketSessionId)).toBe(true);

      socket.destroy();
      await aborted;

      expect(signal?.aborted).toBe(true);
      expect(await disconnectCancel).toEqual({ key: socketSessionId, cancelled: 1 });
    } finally {
      spy.mockRestore();
      defaultTimer.clearTimeout(deadline);
      socket.destroy();
    }
  });
});
