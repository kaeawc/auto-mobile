import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import { DAEMON_CANCEL_REQUEST_METHOD } from "../../src/daemon/constants";
import type { DaemonRequest } from "../../src/daemon/types";
import { defaultTimer } from "../../src/utils/SystemTimer";
import { FakeTimer } from "../fakes/FakeTimer";

// #11058 item 6: a client that dies while its tool call is in flight (after an SDK-side timeout
// sent a cancel, or with no cancel at all) must still be seen as disconnected, so the pool's
// owner-disconnect policy runs for the sessions that connection owned.

const IO_DEADLINE_MS = 2_000;

async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadlineAt = Date.now() + IO_DEADLINE_MS;
  while (!predicate()) {
    if (Date.now() > deadlineAt) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await new Promise<void>((resolve) => defaultTimer.setTimeout(resolve, 2));
  }
}

interface FakeToolCall {
  signal: AbortSignal | undefined;
  settle: (value: unknown) => void;
}

describe("a client that dies mid-request is seen as disconnected (#11058)", () => {
  let socketPath: string;
  let server: UnixSocketServer;
  let calls: FakeToolCall[];
  let honorAbort: boolean;
  let closedConnections: string[];

  beforeEach(async () => {
    socketPath = join(tmpdir(), `mid-request-death-${randomUUID()}.sock`);
    calls = [];
    honorAbort = true;
    closedConnections = [];
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      {
        isInitialized: () => true,
        getSessionManager: () => ({
          getSession: () => null,
          getDeviceLabels: () => undefined,
          releaseSession: async () => null,
          recordHeartbeat: () => {},
        }),
        getDevicePool: () => ({
          refreshDevices: async () => 0,
          getStats: () => ({ total: 0, idle: 0, assigned: 0, error: 0 }),
          releaseDevice: async () => {},
          resolveAutolockSessionForMcpSession: () => undefined,
          // The pool's owner-disconnect entry point.
          releaseMcpSessionBindings: (connectionId: string) => {
            closedConnections.push(connectionId);
          },
        }),
      },
      timer,
    );
    server.mcpClientFactory = async () => ({
      listTools: async () => ({ tools: [] }),
      callTool: (_params: unknown, _schema: unknown, options?: { signal?: AbortSignal }) =>
        new Promise((resolve, reject) => {
          const signal = options?.signal;
          calls.push({ signal, settle: resolve });
          signal?.addEventListener("abort", () => {
            // A wedged device command keeps running after the abort.
            if (honorAbort) {
              reject(signal.reason);
            }
          });
        }),
      listResources: async () => ({ resources: [] }),
      readResource: async () => ({ contents: [] }),
      listResourceTemplates: async () => ({ resourceTemplates: [] }),
      close: async () => {},
    });
    await server.start();
  });

  afterEach(async () => {
    for (const call of calls) {
      call.settle({ content: [] });
    }
    await server.close();
    if (existsSync(socketPath)) {
      await unlink(socketPath);
    }
  });

  async function connect(): Promise<{ socket: Socket; send: (request: DaemonRequest) => void }> {
    const socket = new Socket();
    await new Promise<void>((resolve) => socket.connect(socketPath, resolve));
    socket.on("data", () => {});
    socket.on("error", () => {});
    return { socket, send: (request) => socket.write(JSON.stringify(request) + "\n") };
  }

  const toolCall = (id: string): DaemonRequest => ({
    id,
    type: "mcp_request",
    method: "tools/call",
    params: { name: "observe", arguments: { deviceId: "device-1", sessionUuid: "owned" } },
  });
  const cancel = (requestId: string): DaemonRequest => ({
    id: `cancel-${requestId}`,
    type: "daemon_request",
    method: DAEMON_CANCEL_REQUEST_METHOD,
    params: { requestId },
  });

  for (const scenario of [
    { name: "cancelled, then the client dies", sendCancel: true, honor: true, sameTick: false },
    {
      name: "cancelled with a wedged forward, then the client dies",
      sendCancel: true,
      honor: false,
      sameTick: false,
    },
    { name: "cancels and dies in the same tick", sendCancel: true, honor: true, sameTick: true },
    {
      name: "cancels and dies in the same tick with a wedged forward",
      sendCancel: true,
      honor: false,
      sameTick: true,
    },
    { name: "dies with no cancel", sendCancel: false, honor: true, sameTick: false },
    {
      name: "dies with no cancel and a wedged forward",
      sendCancel: false,
      honor: false,
      sameTick: false,
    },
  ]) {
    test(scenario.name, async () => {
      honorAbort = scenario.honor;
      const { socket, send } = await connect();
      send(toolCall("a"));
      await until(() => calls.length === 1, "the tool call to be forwarded");
      if (scenario.sendCancel) {
        send(cancel("a"));
        if (!scenario.sameTick) {
          await until(() => calls[0].signal?.aborted === true, "the cancel to abort the forward");
        }
      }
      socket.destroy();
      await until(() => closedConnections.length === 1, "the disconnect to reach the pool");
      expect(calls[0].signal?.aborted).toBe(true);
    });
  }
});
