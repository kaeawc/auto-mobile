import { z } from "zod/v4";
import { ErrorCode, McpError } from "../../src/daemon/mcpError";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import { sendSocketRequest } from "./helpers/socketRequest";
import { FakeTimer } from "../fakes/FakeTimer";
import { DAEMON_BOUND_SESSION_PARAM } from "../../src/daemon/wire/constants";
import type { DaemonResponse } from "../../src/daemon/types";
import type { DaemonStateAccess } from "../../src/daemon/daemonRequestHandlers";
import type { Session, SessionReleaseSnapshot } from "../../src/daemon/sessionManager";
import { StubMcpClient, type StubMcpClientHandlers } from "./helpers/fakeMcpClient";
import { ToolRegistry } from "../../src/server/toolRegistry";

function createFakeMcpClient(handlers: StubMcpClientHandlers = {}): StubMcpClient {
  return new StubMcpClient(handlers);
}

function socketClosedError(sensitiveDetail = ""): Error {
  return new Error(`Unstable forward transport${sensitiveDetail}`);
}

function createFakeDaemonState(
  sessionIsValid: () => boolean,
  secondarySessionIsValid: () => boolean,
  resolveDeviceEpochUuid: () => string | undefined,
  resolveSecondaryDeviceEpochUuid: () => string | undefined,
  resolveAutolockSession: () => string | undefined,
  resolveDeviceLabelSession: () => string | undefined,
  resolvePrimaryDeviceOwnerSession: () => string | undefined,
  resolvePrimarySessionGeneration: () => number,
  resolveTerminalReleaseSnapshot: () => SessionReleaseSnapshot | undefined,
): DaemonStateAccess {
  const session: Session = {
    sessionId: "session-a",
    assignedDevice: "emulator-5554",
    platform: "android" as const,
    createdAt: 0,
    lastUsedAt: 0,
    expiresAt: Number.MAX_SAFE_INTEGER,
    cacheData: {},
    lastHeartbeat: 0,
    sessionTimeoutMs: 60_000,
    heartbeatTimeoutMs: 60_000,
    heartbeatTimeoutSource: "default" as const,
    hasReceivedHeartbeat: true,
    activityGeneration: 0,
    ownership: "owned",
    livenessPolicy: "heartbeat",
  };
  const secondarySession: Session = {
    ...session,
    sessionId: "session-b",
    assignedDevice: "emulator-5556",
  };
  const replacementSession: Session = {
    ...session,
    cacheData: {},
  };
  const deviceSession = {
    deviceSessionUuid: "device-epoch-a",
    deviceId: "emulator-5554",
    platform: "android" as const,
    epochStartedAt: 0,
  };
  const secondaryDeviceSession = {
    ...deviceSession,
    deviceSessionUuid: "device-epoch-b",
    deviceId: "emulator-5556",
  };
  const getSession = (sessionId: string): Session | null =>
    sessionId === session.sessionId && sessionIsValid()
      ? resolvePrimarySessionGeneration() === 0
        ? session
        : replacementSession
      : sessionId === secondarySession.sessionId && secondarySessionIsValid()
        ? secondarySession
        : null;
  return {
    isInitialized: () => true,
    getSessionManager: () => ({
      hasSession: (sessionId: string) => getSession(sessionId) !== null,
      getSession,
      getSessionForDevice: (deviceId: string) =>
        deviceId === session.assignedDevice
          ? (resolvePrimaryDeviceOwnerSession() ?? null)
          : deviceId === secondarySession.assignedDevice
            ? secondarySession.sessionId
            : null,
      getDeviceLabels: (sessionId: string) => {
        const labeledSession = resolveDeviceLabelSession();
        return sessionId === session.sessionId && labeledSession
          ? { B: labeledSession }
          : undefined;
      },
      getTerminalReleaseSnapshot: resolveTerminalReleaseSnapshot,
      releaseSession: async () => null,
    }),
    getDevicePool: () => ({
      refreshDevices: async () => 0,
      getStats: () => ({ total: 0, idle: 0, assigned: 0, error: 0 }),
      releaseDevice: async () => {},
      resolveAutolockSessionForMcpSession: () => resolveAutolockSession(),
    }),
    getDeviceSessionRegistry: () => ({
      list: () => {
        const deviceEpochUuid = resolveDeviceEpochUuid();
        const secondaryDeviceEpochUuid = resolveSecondaryDeviceEpochUuid();
        return [
          ...(deviceEpochUuid ? [{ ...deviceSession, deviceSessionUuid: deviceEpochUuid }] : []),
          ...(secondaryDeviceEpochUuid
            ? [
                {
                  ...secondaryDeviceSession,
                  deviceSessionUuid: secondaryDeviceEpochUuid,
                },
              ]
            : []),
        ];
      },
    }),
  };
}

function sendRequest(
  socketPath: string,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs?: number,
): Promise<DaemonResponse> {
  return sendSocketRequest(socketPath, method, params, timeoutMs);
}

describe("UnixSocketServer MCP forward failures: no reconnect or replay (#11820)", () => {
  let socketPath: string;
  let server: UnixSocketServer;
  let fakeTimer: FakeTimer;
  let sessionIsValid: boolean;
  let secondarySessionIsValid: boolean;
  let deviceEpochUuid: string | undefined;
  let secondaryDeviceEpochUuid: string | undefined;
  let autolockSessionUuid: string | undefined;
  let deviceLabelSessionUuid: string | undefined;
  let primaryDeviceOwnerSessionUuid: string | undefined;
  let primarySessionGeneration: number;
  let terminalReleaseSnapshot: SessionReleaseSnapshot | undefined;

  beforeEach(async () => {
    const unusedHandler = async () => ({ content: [] });
    ToolRegistry.register("launchApp", "test transport capability", z.object({}), unusedHandler, {
      transportRecovery: "connect",
    });
    ToolRegistry.register("observe", "test transport capability", z.object({}), unusedHandler, {
      transportRecovery: "replay",
    });
    ToolRegistry.register("safeProbe", "test transport capability", z.object({}), unusedHandler, {
      transportRecovery: "replay",
    });
    ToolRegistry.register("tapOn", "test transport capability", z.object({}), unusedHandler, {
      transportRecovery: "connect",
    });
    socketPath = join(tmpdir(), `mcp-rc-${randomUUID()}.sock`);
    fakeTimer = new FakeTimer();
    sessionIsValid = true;
    secondarySessionIsValid = true;
    deviceEpochUuid = "device-epoch-a";
    secondaryDeviceEpochUuid = "device-epoch-b";
    autolockSessionUuid = undefined;
    deviceLabelSessionUuid = "session-b";
    primaryDeviceOwnerSessionUuid = "session-a";
    primarySessionGeneration = 0;
    terminalReleaseSnapshot = undefined;
    server = new UnixSocketServer(
      socketPath,
      createFakeDaemonState(
        () => sessionIsValid,
        () => secondarySessionIsValid,
        () => deviceEpochUuid,
        () => secondaryDeviceEpochUuid,
        () => autolockSessionUuid,
        () => deviceLabelSessionUuid,
        () => primaryDeviceOwnerSessionUuid,
        () => primarySessionGeneration,
        () => terminalReleaseSnapshot,
      ),
      fakeTimer,
    );
    await server.start();
  });

  afterEach(async () => {
    await server.close();
    for (const name of ["launchApp", "observe", "safeProbe", "tapOn"]) {
      ToolRegistry.unregister(name);
    }
    if (existsSync(socketPath)) {
      await unlink(socketPath);
    }
  });

  test("does not replay a tools/call on a message-only 'Session not found' (#6383)", async () => {
    let clientsCreated = 0;
    let callsDispatched = 0;

    server.mcpClientFactory = async () => {
      ++clientsCreated;
      return createFakeMcpClient({
        callTool: async () => {
          callsDispatched++;
          // Handler-side wording, not the loopback 404: no proof it never ran.
          throw new Error("Session not found: device-session-a");
        },
      });
    };

    const response = await sendRequest(socketPath, "tools/call", {
      name: "tapOn",
      arguments: { text: "Submit" },
    });

    expect(response.success).toBe(false);
    expect(response.error).toContain("Session not found: device-session-a");
    expect(clientsCreated).toBe(1);
    expect(callsDispatched).toBe(1);
  });

  test("returns typed bound-session loss without replaying through a fresh loopback client", async () => {
    let clientsCreated = 0;
    let callsDispatched = 0;
    terminalReleaseSnapshot = {
      sessionId: "session-a",
      deviceId: "ios-simulator-a",
      releaseReason: "daemon-shutdown",
      releasedAtMs: 20_000,
      terminal: true,
      heartbeat: {
        lastHeartbeatMs: 19_000,
        hasReceivedHeartbeat: true,
        timeoutMs: 10_000,
        ageMs: 1_000,
      },
    };

    server.mcpClientFactory = async () => {
      clientsCreated++;
      // The route was admitted while session-a existed, then the shared daemon
      // released it before this loopback request could execute.
      sessionIsValid = false;
      return createFakeMcpClient({
        callTool: async () => {
          callsDispatched++;
          return { content: [] };
        },
      });
    };

    const response = await sendRequest(socketPath, "tools/call", {
      name: "observe",
      arguments: {
        sessionUuid: "session-a",
        [DAEMON_BOUND_SESSION_PARAM]: "session-a",
      },
    });

    expect(response.success).toBe(false);
    expect(response.error).toBe(
      "Device session session-a is no longer active (daemon-shutdown). " +
        "The daemon shut down or restarted, or the device restarted, and this session was not " +
        "restored. Acquire a new device session before continuing.",
    );
    expect(response.boundSessionLoss).toEqual({
      code: "bound_session_lost",
      sessionUuid: "session-a",
      reason: "daemon-shutdown",
      release: terminalReleaseSnapshot,
    });
    expect(clientsCreated).toBe(1);
    expect(callsDispatched).toBe(0);
  });

  test("does not retry on non-session errors and returns failure", async () => {
    let clientsCreated = 0;

    server.mcpClientFactory = async () => {
      ++clientsCreated;
      return createFakeMcpClient({
        listTools: async () => {
          throw new Error("Connection refused");
        },
      });
    };

    const response = await sendRequest(socketPath, "tools/list");

    expect(response.success).toBe(false);
    expect(response.error).toContain("Connection refused");
    // Only one client created — no retry
    expect(clientsCreated).toBe(1);
  });

  test("does not classify an MCP application error by message text", async () => {
    let clientsCreated = 0;

    server.mcpClientFactory = async () => {
      clientsCreated++;
      return createFakeMcpClient({
        callTool: async () => {
          throw new McpError(
            ErrorCode.InternalError,
            "The socket connection was closed unexpectedly in the application",
          );
        },
      });
    };

    const response = await sendRequest(socketPath, "tools/call", {
      name: "observe",
      arguments: { sessionUuid: "session-a" },
    });

    expect(response.success).toBe(false);
    expect(clientsCreated).toBe(1);
    expect(response.transportFailure).toBeUndefined();
  });

  test("maps a structured late getApple shutdown failure to the retryable daemon envelope", async () => {
    let clientsCreated = 0;

    server.mcpClientFactory = async () => {
      clientsCreated++;
      return createFakeMcpClient({
        callTool: async () => ({
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: {
                  code: "daemon_shutting_down",
                  message: "Daemon is shutting down",
                  retryable: true,
                },
              }),
            },
          ],
          structuredContent: {
            error: { code: "daemon_shutting_down", retryable: true },
          },
          isError: true,
        }),
      });
    };

    const response = await sendRequest(socketPath, "tools/call", {
      name: "getApple",
      arguments: { udid: "ios-simulator-a" },
    });

    expect(response).toMatchObject({
      success: false,
      error: "Daemon is shutting down",
      daemonShuttingDown: {
        code: "daemon_shutting_down",
        retryable: true,
      },
    });
    expect(response.transportFailure).toBeUndefined();
    expect(clientsCreated).toBe(1);
  });

  test("seeds a session-scoped client for a reconnected tools/list carrying {sessionUuid}", async () => {
    // After a reconnect the proxy re-sends `{sessionUuid}` on tools/list
    // (daemonMcpProxy.listTools). A FRESH socket has no bound route, so the route
    // must honor the request's session and build a SESSION-SEEDED client —
    // otherwise the shared UNSEEDED client returns the full, unfiltered list
    // instead of the session-scoped one (issue #4610).
    const clientBindings: Array<string | undefined> = [];
    server.mcpClientFactory = async (boundSessionUuid) => {
      clientBindings.push(boundSessionUuid);
      return createFakeMcpClient({
        listTools: async () => ({
          tools: [{ name: boundSessionUuid ?? "unbound", inputSchema: { type: "object" } }],
        }),
      });
    };

    const response = await sendRequest(socketPath, "tools/list", { sessionUuid: "session-a" });

    expect(response.success).toBe(true);
    // The loopback transport was seeded with the requested session, not left unbound.
    expect(clientBindings).toEqual(["session-a"]);
    expect(response.result?.tools).toEqual([
      { name: "session-a", inputSchema: { type: "object" } },
    ]);
  });

  test("a forward that fails to connect answers its error once: no reconnect (#11820)", async () => {
    let clientsCreated = 0;
    server.mcpClientFactory = async () => {
      clientsCreated++;
      throw socketClosedError();
    };

    const response = await sendRequest(socketPath, "tools/call", {
      name: "launchApp",
      arguments: { appId: "com.example" },
    });

    expect(response.success).toBe(false);
    expect(response.error).toContain("Unstable forward transport");
    expect(response).not.toHaveProperty("transportFailure");
    expect(clientsCreated).toBe(1);
  });

  test("a replay-safe tool whose call fails is not replayed, and its client still closes (#11820)", async () => {
    let clientsCreated = 0;
    let callsDispatched = 0;
    let clientsClosed = 0;
    server.mcpClientFactory = async () => {
      clientsCreated++;
      return createFakeMcpClient({
        callTool: async () => {
          callsDispatched++;
          throw socketClosedError();
        },
        close: async () => {
          clientsClosed++;
        },
      });
    };

    const response = await sendRequest(socketPath, "tools/call", {
      name: "observe",
      arguments: {},
    });

    expect(response.success).toBe(false);
    expect(response.error).toContain("Unstable forward transport");
    expect(response).not.toHaveProperty("transportFailure");
    expect([clientsCreated, callsDispatched, clientsClosed]).toEqual([1, 1, 1]);
  });
});
