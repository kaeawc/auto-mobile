import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import { FakeTimer } from "../fakes/FakeTimer";
import type { DeviceLabelMap, Session } from "../../src/daemon/sessionManager";

function createFakeSession(
  sessionId: string,
  assignedDevice: string,
  deviceLabels?: DeviceLabelMap,
): Session {
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

function createFakeDaemonState(
  sessionDevices: Map<string, string>,
  sessionDeviceLabels: Map<string, DeviceLabelMap>,
  mcpAutolockSessions: Map<string, string>,
) {
  return {
    isInitialized: () => true,
    getSessionManager: () => ({
      getSession: (sessionId: string) => {
        const assignedDevice = sessionDevices.get(sessionId);
        return assignedDevice
          ? createFakeSession(sessionId, assignedDevice, sessionDeviceLabels.get(sessionId))
          : null;
      },
      getDeviceLabels: (sessionId: string) => sessionDeviceLabels.get(sessionId),
      releaseSession: async () => null,
    }),
    getDevicePool: () => ({
      refreshDevices: async () => 0,
      getStats: () => ({ total: 0, idle: 0, assigned: 0, error: 0 }),
      releaseDevice: async () => {},
      resolveAutolockSessionForMcpSession: (mcpSessionId: string | undefined) => {
        return mcpSessionId ? mcpAutolockSessions.get(mcpSessionId) : undefined;
      },
    }),
  };
}

function createServer() {
  const sessionDevices = new Map<string, string>();
  const sessionDeviceLabels = new Map<string, DeviceLabelMap>();
  const mcpAutolockSessions = new Map<string, string>();

  // session-a is bound to device-1
  sessionDevices.set("session-a", "device-1");
  // device label "B" on session-a maps to session-a:B, bound to device-2
  sessionDevices.set("session-a:B", "device-2");
  sessionDeviceLabels.set("session-a", { A: "session-a", B: "session-a:B" });
  // mcp-bound has an autolock session resolving to session-a (device-1)
  mcpAutolockSessions.set("mcp-bound", "session-a");

  const server = new UnixSocketServer(
    join(tmpdir(), `scope-${randomUUID()}.sock`),
    "http://localhost:0/mcp",
    createFakeDaemonState(sessionDevices, sessionDeviceLabels, mcpAutolockSessions),
    new FakeTimer(),
  );
  return server;
}

function scopeKey(server: UnixSocketServer, args: unknown): string | undefined {
  return (
    server as unknown as { getRequestArgumentScopeKey: (a: unknown) => string | undefined }
  ).getRequestArgumentScopeKey(args);
}

describe("UnixSocketServer.getRequestArgumentScopeKey precedence", () => {
  // Each row encodes one invariant the six P2 review comments on #2565 pinned down,
  // in priority order: device label > explicit deviceId > resolved-device-for-session
  // > raw session > implicit autolock/mcp-session.
  const cases: Array<{ name: string; args: unknown; expected: string | undefined }> = [
    { name: "non-object args resolve to undefined", args: "nope", expected: undefined },
    { name: "null args resolve to undefined", args: null, expected: undefined },
    { name: "array args resolve to undefined", args: [1, 2], expected: undefined },
    { name: "empty object resolves to undefined", args: {}, expected: undefined },

    {
      name: "explicit deviceId keys by physical device",
      args: { deviceId: "device-1" },
      expected: "device:device-1",
    },
    {
      name: "explicit deviceId beats a raw sessionUuid",
      args: { deviceId: "device-9", sessionUuid: "session-a" },
      expected: "device:device-9",
    },

    {
      name: "device label resolves the mapped session to its bound device",
      args: { sessionUuid: "session-a", device: "B" },
      expected: "device:device-2",
    },
    {
      name: "device label is honored over a stale deviceId",
      args: { sessionUuid: "session-a", device: "B", deviceId: "device-1" },
      expected: "device:device-2",
    },
    {
      name: "unmapped device label falls back to the base session's device",
      args: { sessionUuid: "session-a", device: "UNMAPPED" },
      expected: "device:device-1",
    },
    {
      name: "unmapped device label on an unbound session keys by session",
      args: { sessionUuid: "session-unbound", device: "UNMAPPED" },
      expected: "session:session-unbound",
    },

    {
      name: "session bound to a device keys by the resolved device",
      args: { sessionUuid: "session-a" },
      expected: "device:device-1",
    },
    {
      name: "unbound session keys by the raw session",
      args: { sessionUuid: "session-unbound" },
      expected: "session:session-unbound",
    },

    {
      name: "mcp session with an autolock binding keys by the resolved device",
      args: { __mcpSessionId: "mcp-bound" },
      expected: "device:device-1",
    },
    {
      name: "mcp session without an autolock binding keys by the mcp session",
      args: { __mcpSessionId: "mcp-free" },
      expected: "mcp-session:mcp-free",
    },
  ];

  for (const { name, args, expected } of cases) {
    test(name, () => {
      const server = createServer();
      expect(scopeKey(server, args)).toBe(expected);
    });
  }
});
