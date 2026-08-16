import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import { FakeTimer } from "../fakes/FakeTimer";
import type { DaemonRequest } from "../../src/daemon/types";
import type { DeviceLabelMap, Session } from "../../src/daemon/sessionManager";

function createFakeSession(sessionId: string, assignedDevice: string, deviceLabels?: DeviceLabelMap): Session {
  return {
    sessionId,
    assignedDevice,
    platform: "android",
    createdAt: 0,
    lastUsedAt: 0,
    expiresAt: 60_000,
    cacheData: { deviceLabels },
    lastHeartbeat: 0,
    sessionTimeoutMs: 60_000,
    heartbeatTimeoutMs: 10_000,
    heartbeatTimeoutSource: "default",
    hasReceivedHeartbeat: false,
  };
}

function createFakeDaemonState(sessionDevices: Map<string, string>) {
  return {
    isInitialized: () => true,
    getSessionManager: () => ({
      getSession: (sessionId: string) => {
        const assignedDevice = sessionDevices.get(sessionId);
        return assignedDevice ? createFakeSession(sessionId, assignedDevice) : null;
      },
      getDeviceLabels: () => undefined,
      releaseSession: async () => null,
    }),
    getDevicePool: () => ({
      refreshDevices: async () => 0,
      getStats: () => ({ total: 0, idle: 0, assigned: 0, error: 0 }),
      releaseDevice: async () => {},
      resolveAutolockSessionForMcpSession: () => undefined,
    }),
  };
}

interface McpForwardRoute {
  executionKey: string;
  clientKey: string;
  sessionUuid?: string;
}

interface BoundClientEntry {
  clientKey: string;
  executionKey: string;
  sessionUuid: string;
  requiresLiveDaemonSession: boolean;
}

function createServer(): UnixSocketServer {
  const sessionDevices = new Map<string, string>();
  // session-a is a live daemon session; session-b exists but is unbound to a device.
  sessionDevices.set("session-a", "device-1");
  sessionDevices.set("session-b", "");
  return new UnixSocketServer(
    join(tmpdir(), `ide-route-${randomUUID()}.sock`),
    "http://localhost:0/mcp",
    createFakeDaemonState(sessionDevices),
    new FakeTimer(),
  );
}

function bindSocketToSessionA(server: UnixSocketServer, socketSessionId: string): void {
  const boundMap = (server as unknown as {
    boundMcpClientKeysBySocketSession: Map<string, BoundClientEntry>;
  }).boundMcpClientKeysBySocketSession;
  boundMap.set(socketSessionId, {
    clientKey: `socket:${socketSessionId}:session:session-a`,
    executionKey: "device:device-1",
    sessionUuid: "session-a",
    requiresLiveDaemonSession: true,
  });
}

function route(server: UnixSocketServer, request: DaemonRequest, socketSessionId: string): McpForwardRoute {
  return (server as unknown as {
    getMcpForwardRoute: (r: DaemonRequest, s: string) => McpForwardRoute;
  }).getMcpForwardRoute(request, socketSessionId);
}

describe("UnixSocketServer ide/getNavigationGraph cross-session routing", () => {
  test("an explicit sessionUuid B does not repurpose the socket's bound (session-a) client", () => {
    const server = createServer();
    const socketSessionId = "socket-A";
    bindSocketToSessionA(server, socketSessionId);

    const request: DaemonRequest = {
      id: "1",
      method: "ide/getNavigationGraph",
      params: { sessionUuid: "session-b" },
    };
    const resolved = route(server, request, socketSessionId);

    // The read must route to session-b's OWN client, never session-a's bound
    // transport (whose SessionToolBinding would otherwise be rebound to B).
    expect(resolved.clientKey).toBe(`socket:${socketSessionId}:session:session-b`);
    expect(resolved.sessionUuid).toBe("session-b");
    expect(resolved.executionKey).toBe("session:session-b");
  });

  test("no-sessionUuid getNavigationGraph still reuses the socket's bound client", () => {
    const server = createServer();
    const socketSessionId = "socket-A";
    bindSocketToSessionA(server, socketSessionId);

    const request: DaemonRequest = {
      id: "2",
      method: "ide/getNavigationGraph",
      params: {},
    };
    const resolved = route(server, request, socketSessionId);

    expect(resolved.clientKey).toBe(`socket:${socketSessionId}:session:session-a`);
    expect(resolved.sessionUuid).toBe("session-a");
  });

  test("an explicit sessionUuid equal to the bound session keeps routing to that session", () => {
    const server = createServer();
    const socketSessionId = "socket-A";
    bindSocketToSessionA(server, socketSessionId);

    const request: DaemonRequest = {
      id: "3",
      method: "ide/getNavigationGraph",
      params: { sessionUuid: "session-a" },
    };
    const resolved = route(server, request, socketSessionId);

    expect(resolved.clientKey).toBe(`socket:${socketSessionId}:session:session-a`);
    expect(resolved.sessionUuid).toBe("session-a");
  });
});
