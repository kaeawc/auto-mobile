import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import { SOCKET_REQUEST_DEADLINE_MS, sendSocketRequest } from "./helpers/socketRequest";
import { defaultTimer } from "../../src/utils/SystemTimer";
import { FakeTimer } from "../fakes/FakeTimer";
import { SessionToolBinding } from "../../src/server/SessionToolBinding";
import type { DaemonResponse } from "../../src/daemon/types";

/**
 * Minimal fake MCP client interface for testing.
 * Only implements the methods exercised by handleIdeRequest.
 */
interface FakeMcpClient {
  listTools: () => Promise<{ tools: unknown[] }>;
  callTool: (...args: unknown[]) => Promise<unknown>;
  listResources: () => Promise<{ resources: unknown[] }>;
  readResource: (...args: unknown[]) => Promise<unknown>;
  listResourceTemplates: () => Promise<{ resourceTemplates: unknown[] }>;
  close: () => Promise<void>;
}

function createFakeMcpClient(overrides: Partial<FakeMcpClient> = {}): FakeMcpClient {
  return {
    listTools: async () => ({ tools: [] }),
    callTool: async () => ({ content: [] }),
    listResources: async () => ({ resources: [] }),
    readResource: async () => ({ contents: [] }),
    listResourceTemplates: async () => ({ resourceTemplates: [] }),
    close: async () => {},
    ...overrides,
  };
}

function socketClosedError(sensitiveDetail = ""): Error {
  return new Error(
    `The socket connection was closed unexpectedly. For more information, pass verbose: true.${sensitiveDetail}`,
  );
}

function createFakeDaemonState(
  sessionIsValid: () => boolean,
  secondarySessionIsValid: () => boolean,
  resolveDeviceEpochUuid: () => string | undefined,
  resolveSecondaryDeviceEpochUuid: () => string | undefined,
  resolveAutolockSession: () => string | undefined,
  resolveDeviceLabelSession: () => string | undefined,
) {
  const session = {
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
  };
  const secondarySession = {
    ...session,
    sessionId: "session-b",
    assignedDevice: "emulator-5556",
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
  return {
    isInitialized: () => true,
    getSessionManager: () => ({
      getSession: (sessionId: string) =>
        sessionId === session.sessionId && sessionIsValid()
          ? session
          : sessionId === secondarySession.sessionId && secondarySessionIsValid()
            ? secondarySession
            : null,
      getSessionForDevice: (deviceId: string) =>
        deviceId === session.assignedDevice
          ? session.sessionId
          : deviceId === secondarySession.assignedDevice
            ? secondarySession.sessionId
            : null,
      getDeviceLabels: (sessionId: string) => {
        const labeledSession = resolveDeviceLabelSession();
        return sessionId === session.sessionId && labeledSession
          ? { B: labeledSession }
          : undefined;
      },
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
          ...(deviceEpochUuid
            ? [{ ...deviceSession, deviceSessionUuid: deviceEpochUuid }]
            : []),
          ...(secondaryDeviceEpochUuid
            ? [{
              ...secondaryDeviceSession,
              deviceSessionUuid: secondaryDeviceEpochUuid,
            }]
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

class PersistentSocketClient {
  private readonly socket = new Socket();
  private buffer = "";
  private readonly responses = new Map<string, DaemonResponse>();
  private readonly waiters = new Map<string, (response: DaemonResponse) => void>();

  async connect(socketPath: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.socket.connect(socketPath, resolve);
      this.socket.on("error", reject);
      this.socket.on("data", data => {
        this.buffer += data.toString();
        const lines = this.buffer.split("\n");
        this.buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) {
            continue;
          }
          const response = JSON.parse(line) as DaemonResponse;
          const waiter = this.waiters.get(response.id);
          if (waiter) {
            this.waiters.delete(response.id);
            waiter(response);
          } else {
            this.responses.set(response.id, response);
          }
        }
      });
    });
  }

  request(method: string, params: Record<string, unknown>): Promise<DaemonResponse> {
    const id = randomUUID();
    this.socket.write(JSON.stringify({ id, type: "mcp_request", method, params }) + "\n");
    const buffered = this.responses.get(id);
    if (buffered) {
      this.responses.delete(id);
      return Promise.resolve(buffered);
    }
    return new Promise((resolve, reject) => {
      // Bounded: an unanswered request must fail fast with a diagnostic, not
      // pend until the suite's wall-clock watchdog (macos hang class, #5391).
      const deadline = defaultTimer.setTimeout(() => {
        this.waiters.delete(id);
        this.socket.destroy();
        reject(new Error(`No response to ${method} within ${SOCKET_REQUEST_DEADLINE_MS}ms — bounded socket-test deadline hit`));
      }, SOCKET_REQUEST_DEADLINE_MS);
      this.waiters.set(id, response => {
        defaultTimer.clearTimeout(deadline);
        resolve(response);
      });
    });
  }

  close(): void {
    this.socket.destroy();
  }
}

describe("UnixSocketServer MCP session reconnect", () => {
  let socketPath: string;
  let server: UnixSocketServer;
  let fakeTimer: FakeTimer;
  let sessionIsValid: boolean;
  let secondarySessionIsValid: boolean;
  let deviceEpochUuid: string | undefined;
  let secondaryDeviceEpochUuid: string | undefined;
  let autolockSessionUuid: string | undefined;
  let deviceLabelSessionUuid: string | undefined;

  beforeEach(async () => {
    socketPath = join(tmpdir(), `mcp-rc-${randomUUID()}.sock`);
    fakeTimer = new FakeTimer();
    sessionIsValid = true;
    secondarySessionIsValid = true;
    deviceEpochUuid = "device-epoch-a";
    secondaryDeviceEpochUuid = "device-epoch-b";
    autolockSessionUuid = undefined;
    deviceLabelSessionUuid = "session-b";
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(
        () => sessionIsValid,
        () => secondarySessionIsValid,
        () => deviceEpochUuid,
        () => secondaryDeviceEpochUuid,
        () => autolockSessionUuid,
        () => deviceLabelSessionUuid,
      ),
      fakeTimer,
    );
    await server.start();
  });

  afterEach(async () => {
    await server.close();
    if (existsSync(socketPath)) {
      await unlink(socketPath);
    }
  });

  test("retries with a fresh client when MCP throws 'Session not found'", async () => {
    let clientsCreated = 0;

    server.mcpClientFactory = async () => {
      const clientIndex = ++clientsCreated;
      return createFakeMcpClient({
        listTools: async () => {
          if (clientIndex === 1) {
            throw new Error("Session not found");
          }
          return { tools: [{ name: "observe" }] };
        },
      });
    };

    const response = await sendRequest(socketPath, "tools/list");

    expect(response.success).toBe(true);
    expect(clientsCreated).toBe(2);
    const result = response.result as { tools: Array<{ name: string }> };
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe("observe");
  });

  test("resets cached client before reconnecting so getMcpClient creates a fresh one", async () => {
    let clientsCreated = 0;

    server.mcpClientFactory = async () => {
      ++clientsCreated;
      return createFakeMcpClient({
        listTools: async () => {
          if (clientsCreated === 1) {
            throw new Error("Session not found: MCP session expired");
          }
          return { tools: [] };
        },
      });
    };

    await sendRequest(socketPath, "tools/list");

    // After reconnect, the per-key client cache should hold the fresh client.
    expect((server as any).mcpClients.size).toBe(1);
    expect(clientsCreated).toBe(2);
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

  test("reconnects launchApp after a socket closure before request dispatch", async () => {
    let clientsCreated = 0;
    let callsDispatched = 0;

    server.mcpClientFactory = async () => {
      clientsCreated++;
      if (clientsCreated === 1) {
        throw socketClosedError();
      }
      return createFakeMcpClient({
        callTool: async () => {
          callsDispatched++;
          return { content: [{ type: "text", text: "launched" }] };
        },
      });
    };

    const response = await sendRequest(socketPath, "tools/call", {
      name: "launchApp",
      arguments: { sessionUuid: "session-a", appId: "dev.example" },
    });

    expect(response.success).toBe(true);
    expect(clientsCreated).toBe(2);
    expect(callsDispatched).toBe(1);
  });

  test("reconnects a sessionless call after a socket closure before request dispatch", async () => {
    let clientsCreated = 0;
    let callsDispatched = 0;

    server.mcpClientFactory = async () => {
      clientsCreated++;
      if (clientsCreated === 1) {
        throw socketClosedError();
      }
      return createFakeMcpClient({
        callTool: async () => {
          callsDispatched++;
          return { content: [{ type: "text", text: "observed" }] };
        },
      });
    };

    const response = await sendRequest(socketPath, "tools/call", {
      name: "observe",
      arguments: { platform: "android" },
    });

    expect(response.success).toBe(true);
    expect(clientsCreated).toBe(2);
    expect(callsDispatched).toBe(1);
  });

  test("preserves an unrelated failure while reconnecting before request dispatch", async () => {
    let clientsCreated = 0;

    server.mcpClientFactory = async () => {
      clientsCreated++;
      if (clientsCreated === 1) {
        throw socketClosedError();
      }
      throw new Error("MCP configuration rejected");
    };

    const response = await sendRequest(socketPath, "tools/call", {
      name: "observe",
      arguments: { sessionUuid: "session-a" },
    });

    expect(response.success).toBe(false);
    expect(clientsCreated).toBe(2);
    expect(response.error).toContain("MCP configuration rejected");
    expect(response.transportFailure).toBeUndefined();
  });

  test("classifies a closure during the existing session-expiry replay", async () => {
    let clientsCreated = 0;
    let callsDispatched = 0;

    server.mcpClientFactory = async () => {
      const clientIndex = ++clientsCreated;
      return createFakeMcpClient({
        callTool: async () => {
          callsDispatched++;
          if (clientIndex === 1) {
            throw new Error("Session not found");
          }
          throw socketClosedError(" endpoint=https://secret.invalid?token=hidden");
        },
      });
    };

    const response = await sendRequest(socketPath, "tools/call", {
      name: "observe",
      arguments: { sessionUuid: "session-a" },
    });

    expect(response.success).toBe(false);
    expect(clientsCreated).toBe(2);
    expect(callsDispatched).toBe(2);
    expect(response.error).toBe("Device-control transport recovery exhausted while handling observe");
    expect(JSON.stringify(response)).not.toContain("secret.invalid");
    expect(response.transportFailure).toMatchObject({
      sessionValid: true,
      phase: "response",
      retryable: true,
      reconnectAttempted: true,
      replayAttempted: true,
    });
    expect((server as any).mcpClients.size).toBe(0);
  });

  test("refreshes autolock identity when session-expiry replay closes", async () => {
    let clientsCreated = 0;

    server.mcpClientFactory = async () => {
      const clientIndex = ++clientsCreated;
      return createFakeMcpClient({
        callTool: async () => {
          if (clientIndex === 1) {
            autolockSessionUuid = "session-a";
            throw new Error("Session not found");
          }
          throw socketClosedError();
        },
      });
    };

    const response = await sendRequest(socketPath, "tools/call", {
      name: "observe",
      arguments: { platform: "android" },
    });

    expect(response.success).toBe(false);
    expect(clientsCreated).toBe(2);
    expect(response.transportFailure).toMatchObject({
      deviceId: "emulator-5554",
      deviceSessionUuid: "device-epoch-a",
      sessionUuid: "session-a",
      sessionValid: true,
      deviceSessionValid: true,
      phase: "response",
      retryable: true,
      reconnectAttempted: true,
      replayAttempted: true,
    });
  });

  test("reconnects and replays observe after a socket closure while handling the response", async () => {
    let clientsCreated = 0;
    let callsDispatched = 0;

    server.mcpClientFactory = async () => {
      const clientIndex = ++clientsCreated;
      return createFakeMcpClient({
        callTool: async () => {
          callsDispatched++;
          if (clientIndex === 1) {
            throw socketClosedError();
          }
          return { content: [{ type: "text", text: "observed" }] };
        },
      });
    };

    const response = await sendRequest(socketPath, "tools/call", {
      name: "observe",
      arguments: { sessionUuid: "session-a" },
    });

    expect(response.success).toBe(true);
    expect(clientsCreated).toBe(2);
    expect(callsDispatched).toBe(2);
  });

  test("refreshes first-use autolock identity before replaying observe", async () => {
    let clientsCreated = 0;
    let callsDispatched = 0;

    server.mcpClientFactory = async () => {
      const clientIndex = ++clientsCreated;
      return createFakeMcpClient({
        callTool: async () => {
          callsDispatched++;
          if (clientIndex === 1) {
            autolockSessionUuid = "session-a";
            throw socketClosedError();
          }
          return { content: [{ type: "text", text: "observed" }] };
        },
      });
    };

    const response = await sendRequest(socketPath, "tools/call", {
      name: "observe",
      arguments: { platform: "android" },
    });

    expect(response.success).toBe(true);
    expect(clientsCreated).toBe(2);
    expect(callsDispatched).toBe(2);
  });

  test("reconnects without waiting for a stale client's close to settle", async () => {
    let clientsCreated = 0;
    let callsDispatched = 0;
    let closeCalls = 0;

    server.mcpClientFactory = async () => {
      const clientIndex = ++clientsCreated;
      return createFakeMcpClient({
        callTool: async () => {
          callsDispatched++;
          if (clientIndex === 1) {
            throw socketClosedError();
          }
          return { content: [{ type: "text", text: "observed" }] };
        },
        close: async () => {
          closeCalls++;
          if (clientIndex === 1) {
            return new Promise<void>(() => {});
          }
        },
      });
    };

    const response = await sendRequest(socketPath, "tools/call", {
      name: "observe",
      arguments: { sessionUuid: "session-a" },
    });

    expect(response.success).toBe(true);
    expect(clientsCreated).toBe(2);
    expect(callsDispatched).toBe(2);
    expect(closeCalls).toBe(1);
    expect((server as any).mcpClients.size).toBe(1);
  });

  test("does not evict a replacement client while resetting a failed route", async () => {
    let replacementCloseCalls = 0;
    const failedClient = createFakeMcpClient();
    const replacementClient = createFakeMcpClient({
      close: async () => {
        replacementCloseCalls++;
      },
    });
    const clientKey = "session:replacement-race";
    const internals = server as any;
    internals.mcpClients.set(clientKey, replacementClient);

    const reset = await internals.resetMcpClientIfCurrent(clientKey, failedClient, "detach");

    expect(reset).toBe(false);
    expect(internals.mcpClients.get(clientKey)).toBe(replacementClient);
    expect(replacementCloseCalls).toBe(0);
  });

  test("does not replay launchApp after an ambiguous response closure", async () => {
    let clientsCreated = 0;
    let callsDispatched = 0;

    server.mcpClientFactory = async () => {
      clientsCreated++;
      return createFakeMcpClient({
        callTool: async () => {
          callsDispatched++;
          throw socketClosedError(" endpoint=https://secret.invalid?token=hidden");
        },
      });
    };

    const response = await sendRequest(socketPath, "tools/call", {
      name: "launchApp",
      arguments: { sessionUuid: "session-a", appId: "dev.example" },
    });

    expect(response.success).toBe(false);
    expect(clientsCreated).toBe(2);
    expect(callsDispatched).toBe(1);
    expect(response.error).toBe("Device-control transport closed while handling launchApp");
    expect(response.error).not.toContain("secret.invalid");
    expect(response.transportFailure).toEqual({
      code: "device_control_transport_failure",
      transport: "daemon_loopback_http",
      toolName: "launchApp",
      deviceId: "emulator-5554",
      deviceSessionUuid: "device-epoch-a",
      sessionUuid: "session-a",
      sessionValid: true,
      deviceSessionValid: true,
      phase: "response",
      retryable: false,
      reconnectAttempted: true,
      replayAttempted: false,
    });
  });

  test("returns a retryable structured error after observe reconnection exhaustion", async () => {
    let clientsCreated = 0;
    let callsDispatched = 0;
    let closeCalls = 0;

    server.mcpClientFactory = async () => {
      const clientIndex = ++clientsCreated;
      return createFakeMcpClient({
        callTool: async () => {
          callsDispatched++;
          if (clientIndex <= 2) {
            throw socketClosedError(" endpoint=https://secret.invalid?token=hidden");
          }
          return { content: [{ type: "text", text: "observed" }] };
        },
        close: async () => {
          closeCalls++;
        },
      });
    };

    const response = await sendRequest(socketPath, "tools/call", {
      name: "observe",
      arguments: { sessionUuid: "session-a" },
    });

    expect(response.success).toBe(false);
    expect(clientsCreated).toBe(2);
    expect(callsDispatched).toBe(2);
    expect(response.error).toBe("Device-control transport recovery exhausted while handling observe");
    expect(JSON.stringify(response)).not.toContain("secret.invalid");
    expect(response.transportFailure).toMatchObject({
      code: "device_control_transport_failure",
      toolName: "observe",
      deviceId: "emulator-5554",
      deviceSessionUuid: "device-epoch-a",
      sessionUuid: "session-a",
      sessionValid: true,
      phase: "response",
      retryable: true,
      reconnectAttempted: true,
      replayAttempted: true,
    });
    expect(closeCalls).toBe(2);
    expect((server as any).mcpClients.size).toBe(0);

    const nextResponse = await sendRequest(socketPath, "tools/call", {
      name: "observe",
      arguments: { sessionUuid: "session-a" },
    });
    expect(nextResponse.success).toBe(true);
    expect(clientsCreated).toBe(3);
    expect(callsDispatched).toBe(3);
  });

  test("does not reconnect or replay after the bound device session becomes invalid", async () => {
    let clientsCreated = 0;
    let callsDispatched = 0;

    server.mcpClientFactory = async () => {
      clientsCreated++;
      return createFakeMcpClient({
        callTool: async () => {
          callsDispatched++;
          sessionIsValid = false;
          throw socketClosedError();
        },
      });
    };

    const response = await sendRequest(socketPath, "tools/call", {
      name: "observe",
      arguments: { sessionUuid: "session-a" },
    });

    expect(response.success).toBe(false);
    expect(clientsCreated).toBe(1);
    expect(callsDispatched).toBe(1);
    expect(response.transportFailure).toMatchObject({
      code: "device_control_transport_failure",
      deviceId: "emulator-5554",
      deviceSessionUuid: "device-epoch-a",
      sessionUuid: "session-a",
      sessionValid: false,
      deviceSessionValid: true,
      phase: "response",
      retryable: false,
      reconnectAttempted: false,
      replayAttempted: false,
    });
  });

  test("does not replay when only the captured device epoch becomes invalid", async () => {
    let clientsCreated = 0;
    let callsDispatched = 0;

    server.mcpClientFactory = async () => {
      clientsCreated++;
      return createFakeMcpClient({
        callTool: async () => {
          callsDispatched++;
          deviceEpochUuid = "device-epoch-a-replacement";
          throw socketClosedError();
        },
      });
    };

    const response = await sendRequest(socketPath, "tools/call", {
      name: "observe",
      arguments: { sessionUuid: "session-a" },
    });

    expect(response.success).toBe(false);
    expect(sessionIsValid).toBe(true);
    expect(clientsCreated).toBe(1);
    expect(callsDispatched).toBe(1);
    expect(response.transportFailure).toMatchObject({
      deviceId: "emulator-5554",
      deviceSessionUuid: "device-epoch-a",
      sessionUuid: "session-a",
      sessionValid: true,
      deviceSessionValid: false,
      reconnectAttempted: false,
      replayAttempted: false,
    });
  });

  test("rejects a replay result when the device epoch becomes invalid in flight", async () => {
    let clientsCreated = 0;
    let callsDispatched = 0;

    server.mcpClientFactory = async () => {
      const clientIndex = ++clientsCreated;
      return createFakeMcpClient({
        callTool: async () => {
          callsDispatched++;
          if (clientIndex === 1) {
            throw socketClosedError();
          }
          deviceEpochUuid = "device-epoch-a-replacement";
          return { content: [{ type: "text", text: "stale observation" }] };
        },
      });
    };

    const response = await sendRequest(socketPath, "tools/call", {
      name: "observe",
      arguments: { sessionUuid: "session-a" },
    });

    expect(response.success).toBe(false);
    expect(sessionIsValid).toBe(true);
    expect(clientsCreated).toBe(2);
    expect(callsDispatched).toBe(2);
    expect(response.transportFailure).toMatchObject({
      sessionValid: true,
      deviceSessionValid: false,
      phase: "response",
      retryable: false,
      reconnectAttempted: true,
      replayAttempted: true,
    });
    expect((server as any).mcpClients.size).toBe(0);
  });

  test("fences recovery to the device-label session and epoch", async () => {
    let clientsCreated = 0;
    let callsDispatched = 0;

    server.mcpClientFactory = async () => {
      clientsCreated++;
      return createFakeMcpClient({
        callTool: async () => {
          callsDispatched++;
          secondarySessionIsValid = false;
          throw socketClosedError();
        },
      });
    };

    const response = await sendRequest(socketPath, "tools/call", {
      name: "observe",
      arguments: { sessionUuid: "session-a", device: "B" },
    });

    expect(response.success).toBe(false);
    expect(clientsCreated).toBe(1);
    expect(callsDispatched).toBe(1);
    expect(response.transportFailure).toMatchObject({
      deviceId: "emulator-5556",
      deviceSessionUuid: "device-epoch-b",
      sessionUuid: "session-b",
      sessionValid: false,
      reconnectAttempted: false,
      replayAttempted: false,
    });
  });

  test("pins a device-label target before replaying observe", async () => {
    let clientsCreated = 0;
    let closeCalls = 0;
    let replayedArguments: Record<string, unknown> | undefined;
    const clientBindings: Array<string | undefined> = [];
    let signalReplayStarted = () => {};
    const replayStarted = new Promise<void>(resolve => {
      signalReplayStarted = resolve;
    });
    let finishReplay = () => {};
    const replayResult = new Promise<unknown>(resolve => {
      finishReplay = () => resolve({ content: [{ type: "text", text: "observed" }] });
    });

    server.mcpClientFactory = async boundSessionUuid => {
      clientBindings.push(boundSessionUuid);
      const clientIndex = ++clientsCreated;
      return createFakeMcpClient({
        callTool: async (...args: unknown[]) => {
          if (clientIndex === 1) {
            deviceLabelSessionUuid = "session-a";
            throw socketClosedError();
          }
          const [toolCall] = args as [{ arguments: Record<string, unknown> }];
          replayedArguments = toolCall.arguments;
          new SessionToolBinding(boundSessionUuid).effectiveSessionUuid(
            "replay-mcp-session",
            replayedArguments,
          );
          signalReplayStarted();
          return replayResult;
        },
        close: async () => {
          closeCalls++;
        },
      });
    };

    const responsePromise = sendRequest(socketPath, "tools/call", {
      name: "observe",
      arguments: { sessionUuid: "session-a", device: "B" },
    });
    await replayStarted;

    expect(clientsCreated).toBe(2);
    expect(clientBindings).toEqual(["session-a", "session-b"]);
    expect(replayedArguments).toMatchObject({ sessionUuid: "session-b" });
    expect(replayedArguments).not.toHaveProperty("device");
    expect(replayedArguments).not.toHaveProperty("deviceId");
    expect((server as any).mcpClients.size).toBe(1);

    fakeTimer.advanceTime(5 * 60 * 1000);
    await Promise.resolve();

    expect(closeCalls).toBe(1);
    expect((server as any).mcpClients.size).toBe(1);

    finishReplay();
    const response = await responsePromise;
    expect(response.success).toBe(true);

    fakeTimer.advanceTime(5 * 60 * 1000);
    await Promise.resolve();

    expect(closeCalls).toBe(2);
    expect((server as any).mcpClients.size).toBe(0);
  });

  test("preserves an unresolved device label when replaying observe", async () => {
    let clientsCreated = 0;
    let replayedArguments: Record<string, unknown> | undefined;
    deviceLabelSessionUuid = undefined;

    server.mcpClientFactory = async () => {
      const clientIndex = ++clientsCreated;
      return createFakeMcpClient({
        callTool: async (...args: unknown[]) => {
          if (clientIndex === 1) {
            throw socketClosedError();
          }
          const [toolCall] = args as [{ arguments: Record<string, unknown> }];
          replayedArguments = toolCall.arguments;
          return { content: [{ type: "text", text: "observed" }] };
        },
      });
    };

    const response = await sendRequest(socketPath, "tools/call", {
      name: "observe",
      arguments: { sessionUuid: "session-a", device: "unknown" },
    });

    expect(response.success).toBe(true);
    expect(clientsCreated).toBe(2);
    expect(replayedArguments).toMatchObject({
      sessionUuid: "session-a",
      device: "unknown",
    });
  });

  test("preserves the caller session grant when replaying an explicit device target", async () => {
    let clientsCreated = 0;
    let replayedArguments: Record<string, unknown> | undefined;
    const clientBindings: Array<string | undefined> = [];

    server.mcpClientFactory = async boundSessionUuid => {
      clientBindings.push(boundSessionUuid);
      const clientIndex = ++clientsCreated;
      return createFakeMcpClient({
        callTool: async (...args: unknown[]) => {
          if (clientIndex === 1) {
            throw socketClosedError();
          }
          const [toolCall] = args as [{ arguments: Record<string, unknown> }];
          replayedArguments = toolCall.arguments;
          return { content: [{ type: "text", text: "observed" }] };
        },
      });
    };

    const response = await sendRequest(socketPath, "tools/call", {
      name: "observe",
      arguments: { sessionUuid: "session-a", deviceId: "emulator-5556" },
    });

    expect(response.success).toBe(true);
    expect(clientsCreated).toBe(2);
    expect(clientBindings).toEqual(["session-a", "session-a"]);
    expect(replayedArguments).toMatchObject({
      sessionUuid: "session-a",
      deviceId: "emulator-5556",
    });
  });

  test("recovers observe for an implicit autolock session", async () => {
    let clientsCreated = 0;
    let callsDispatched = 0;
    autolockSessionUuid = "session-a";

    server.mcpClientFactory = async () => {
      const clientIndex = ++clientsCreated;
      return createFakeMcpClient({
        callTool: async () => {
          callsDispatched++;
          if (clientIndex === 1) {
            throw socketClosedError();
          }
          return { content: [{ type: "text", text: "observed" }] };
        },
      });
    };

    const response = await sendRequest(socketPath, "tools/call", {
      name: "observe",
      arguments: { platform: "android" },
    });

    expect(response.success).toBe(true);
    expect(clientsCreated).toBe(2);
    expect(callsDispatched).toBe(2);
  });

  test("does not dispatch after reconnect consumes the remaining deadline", async () => {
    let clientsCreated = 0;
    let callsDispatched = 0;
    let closeCalls = 0;

    server.mcpClientFactory = async () => {
      const clientIndex = ++clientsCreated;
      if (clientIndex === 2) {
        fakeTimer.advanceTime(90_001);
      }
      return createFakeMcpClient({
        callTool: async () => {
          callsDispatched++;
          if (clientIndex === 1) {
            throw socketClosedError();
          }
          return { content: [{ type: "text", text: "observed" }] };
        },
        close: async () => {
          closeCalls++;
        },
      });
    };

    const response = await sendRequest(
      socketPath,
      "tools/call",
      {
        name: "observe",
        arguments: { sessionUuid: "session-a" },
      },
      100,
    );

    expect(response.success).toBe(false);
    expect(clientsCreated).toBe(2);
    expect(callsDispatched).toBe(1);
    expect(response.transportFailure).toMatchObject({
      retryable: true,
      reconnectAttempted: true,
      replayAttempted: false,
    });
    expect(closeCalls).toBe(2);
    expect((server as any).mcpClients.size).toBe(0);
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

  test("subsequent requests reuse the reconnected client without creating another", async () => {
    let clientsCreated = 0;

    server.mcpClientFactory = async () => {
      ++clientsCreated;
      const isFailing = clientsCreated === 1;
      return createFakeMcpClient({
        listTools: async () => {
          if (isFailing) {throw new Error("Session not found");}
          return { tools: [] };
        },
      });
    };

    // First request triggers reconnect (2 clients)
    const first = await sendRequest(socketPath, "tools/list");
    expect(first.success).toBe(true);
    expect(clientsCreated).toBe(2);

    // Second request reuses the cached client (still 2 clients)
    const second = await sendRequest(socketPath, "tools/list");
    expect(second.success).toBe(true);
    expect(clientsCreated).toBe(2);
  });

  test("replays a bound session when tools/list reconnects its MCP client", async () => {
    const clientBindings: Array<string | undefined> = [];
    server.mcpClientFactory = async boundSessionUuid => {
      clientBindings.push(boundSessionUuid);
      const isFirstClient = clientBindings.length === 1;
      return createFakeMcpClient({
        listTools: async () => {
          if (isFirstClient) {
            throw new Error("Session not found");
          }
          return { tools: [{ name: boundSessionUuid ?? "unbound" }] };
        },
      });
    };

    const client = new PersistentSocketClient();
    await client.connect(socketPath);
    try {
      const boundCall = await client.request("tools/call", {
        name: "observe",
        arguments: { sessionUuid: "session-a" },
      });
      const list = await client.request("tools/list", {});

      expect(boundCall.success).toBe(true);
      expect(clientBindings).toEqual(["session-a", "session-a"]);
      expect(list.result).toEqual({ tools: [{ name: "session-a" }] });
    } finally {
      client.close();
    }
  });

  test("seeds a session-scoped client for a reconnected tools/list carrying {sessionUuid}", async () => {
    // After a reconnect the proxy re-sends `{sessionUuid}` on tools/list
    // (daemonMcpProxy.listTools). A FRESH socket has no bound route, so the route
    // must honor the request's session and build a SESSION-SEEDED client —
    // otherwise the shared UNSEEDED client returns the full, unfiltered list
    // instead of the session-scoped one (issue #4610).
    const clientBindings: Array<string | undefined> = [];
    server.mcpClientFactory = async boundSessionUuid => {
      clientBindings.push(boundSessionUuid);
      return createFakeMcpClient({
        listTools: async () => ({ tools: [{ name: boundSessionUuid ?? "unbound" }] }),
      });
    };

    const response = await sendRequest(socketPath, "tools/list", { sessionUuid: "session-a" });

    expect(response.success).toBe(true);
    // The loopback transport was seeded with the requested session, not left unbound.
    expect(clientBindings).toEqual(["session-a"]);
    const result = response.result as { tools: Array<{ name: string }> };
    expect(result.tools).toEqual([{ name: "session-a" }]);
  });

  test("closes idle per-key MCP clients after the idle timeout", async () => {
    let closeCalls = 0;

    server.mcpClientFactory = async () => createFakeMcpClient({
      listTools: async () => ({ tools: [] }),
      close: async () => {
        closeCalls++;
      },
    });

    const response = await sendRequest(socketPath, "tools/list");

    expect(response.success).toBe(true);
    expect((server as any).mcpClients.size).toBe(1);

    fakeTimer.advanceTime(5 * 60 * 1000);
    await Promise.resolve();

    expect(closeCalls).toBe(1);
    expect((server as any).mcpClients.size).toBe(0);
  });
});
