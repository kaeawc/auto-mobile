import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import { FakeTimer } from "../fakes/FakeTimer";
import type { DaemonRequest, DaemonResponse } from "../../src/daemon/types";
import type { Session } from "../../src/daemon/sessionManager";

interface FakeMcpClient {
  callTool: (...args: unknown[]) => Promise<unknown>;
  listTools: () => Promise<{ tools: unknown[] }>;
  listResources: () => Promise<{ resources: unknown[] }>;
  readResource: (...args: unknown[]) => Promise<unknown>;
  listResourceTemplates: () => Promise<{ resourceTemplates: unknown[] }>;
  close: () => Promise<void>;
}

function createFakeSession(
  sessionId: string,
  assignedDevice: string,
  customData: Record<string, unknown> = {}
): Session {
  return {
    sessionId,
    assignedDevice,
    platform: "android",
    createdAt: 0,
    lastUsedAt: 0,
    expiresAt: 60_000,
    cacheData: { customData },
    lastHeartbeat: 0,
    sessionTimeoutMs: 60_000,
    heartbeatTimeoutMs: 10_000,
    heartbeatTimeoutSource: "default",
    hasReceivedHeartbeat: false,
  };
}

function createFakeDaemonState(
  sessionDevices: Map<string, string>,
  sessionCustomData: Map<string, Record<string, unknown>>,
  mcpAutolockSessions: Map<string, string>
) {
  return {
    isInitialized: () => true,
    getSessionManager: () => ({
      getSession: (sessionId: string) => {
        const assignedDevice = sessionDevices.get(sessionId);
        return assignedDevice ? createFakeSession(sessionId, assignedDevice, sessionCustomData.get(sessionId) ?? {}) : null;
      },
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

function sendRequest(socketPath: string, request: DaemonRequest): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    const client = new Socket();
    let buffer = "";

    client.connect(socketPath, () => {
      client.write(JSON.stringify(request) + "\n");
    });

    client.on("data", data => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      for (const line of lines) {
        if (line.trim()) {
          try {
            const response = JSON.parse(line) as DaemonResponse;
            client.destroy();
            resolve(response);
            return;
          } catch {
            // keep buffering
          }
        }
      }
    });

    client.on("error", reject);
    client.on("close", () => {
      if (!buffer.trim()) {
        reject(new Error("Connection closed without response"));
      }
    });
  });
}

function sendToolsCallWithArgs(
  socketPath: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<DaemonResponse> {
  return sendRequest(socketPath, {
    id: randomUUID(),
    type: "mcp_request",
    method: "tools/call",
    params: { name: toolName, arguments: args },
  });
}

function sendToolsCallWithoutArgs(socketPath: string, toolName: string): Promise<DaemonResponse> {
  return sendRequest(socketPath, {
    id: randomUUID(),
    type: "mcp_request",
    method: "tools/call",
    params: { name: toolName },
  });
}

function sendTwoToolsCallsOnOneSocket(socketPath: string, toolName: string): Promise<DaemonResponse[]> {
  return new Promise((resolve, reject) => {
    const client = new Socket();
    const responses: DaemonResponse[] = [];
    let buffer = "";

    client.connect(socketPath, () => {
      for (let i = 0; i < 2; i++) {
        client.write(JSON.stringify({
          id: randomUUID(),
          type: "mcp_request",
          method: "tools/call",
          params: { name: toolName, arguments: {} },
        }) + "\n");
      }
    });

    client.on("data", data => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        responses.push(JSON.parse(line) as DaemonResponse);
        if (responses.length === 2) {
          client.destroy();
          resolve(responses);
          return;
        }
      }
    });

    client.on("error", reject);
    client.on("close", () => {
      if (responses.length < 2) {
        reject(new Error(`Connection closed after ${responses.length} responses`));
      }
    });
  });
}

describe("UnixSocketServer MCP forward serialization", () => {
  let socketPath: string;
  let server: UnixSocketServer;
  let fakeTimer: FakeTimer;
  let sessionDevices: Map<string, string>;
  let sessionCustomData: Map<string, Record<string, unknown>>;
  let mcpAutolockSessions: Map<string, string>;

  beforeEach(async () => {
    socketPath = join(tmpdir(), `mcp-ser-${randomUUID()}.sock`);
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    sessionDevices = new Map();
    sessionCustomData = new Map();
    mcpAutolockSessions = new Map();
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(sessionDevices, sessionCustomData, mcpAutolockSessions),
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

  test("concurrent tools/call for the same device never overlaps inside callTool", async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    (server as any).createMcpClient = async () => {
      const fake: FakeMcpClient = {
        listTools: async () => ({ tools: [] }),
        callTool: async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise<void>(resolve => {
            fakeTimer.setTimeout(resolve, 40);
          });
          inFlight -= 1;
          return { content: [] };
        },
        listResources: async () => ({ resources: [] }),
        readResource: async () => ({ contents: [] }),
        listResourceTemplates: async () => ({ resourceTemplates: [] }),
        close: async () => {},
      };
      return fake;
    };

    const [a, b] = await Promise.all([
      sendToolsCallWithArgs(socketPath, "observe", { deviceId: "device-1" }),
      sendToolsCallWithArgs(socketPath, "observe", { deviceId: "device-1" }),
    ]);

    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
    expect(maxInFlight).toBe(1);
    expect(inFlight).toBe(0);
  });

  test("explicit device targets serialize even when session UUIDs differ", async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    (server as any).createMcpClient = async () => {
      const fake: FakeMcpClient = {
        listTools: async () => ({ tools: [] }),
        callTool: async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise<void>(resolve => {
            fakeTimer.setTimeout(resolve, 40);
          });
          inFlight -= 1;
          return { content: [] };
        },
        listResources: async () => ({ resources: [] }),
        readResource: async () => ({ contents: [] }),
        listResourceTemplates: async () => ({ resourceTemplates: [] }),
        close: async () => {},
      };
      return fake;
    };

    const [a, b] = await Promise.all([
      sendToolsCallWithArgs(socketPath, "observe", { deviceId: "device-1", sessionUuid: "session-a" }),
      sendToolsCallWithArgs(socketPath, "observe", { deviceId: "device-1", sessionUuid: "session-b" }),
    ]);

    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
    expect(maxInFlight).toBe(1);
    expect(inFlight).toBe(0);
  });

  test("session-bound tools/call serializes with explicit calls for the same device", async () => {
    sessionDevices.set("session-a", "device-1");
    let inFlight = 0;
    let maxInFlight = 0;

    (server as any).createMcpClient = async () => {
      const fake: FakeMcpClient = {
        listTools: async () => ({ tools: [] }),
        callTool: async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise<void>(resolve => {
            fakeTimer.setTimeout(resolve, 40);
          });
          inFlight -= 1;
          return { content: [] };
        },
        listResources: async () => ({ resources: [] }),
        readResource: async () => ({ contents: [] }),
        listResourceTemplates: async () => ({ resourceTemplates: [] }),
        close: async () => {},
      };
      return fake;
    };

    const [a, b] = await Promise.all([
      sendToolsCallWithArgs(socketPath, "observe", { sessionUuid: "session-a" }),
      sendToolsCallWithArgs(socketPath, "observe", { deviceId: "device-1" }),
    ]);

    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
    expect(maxInFlight).toBe(1);
    expect(inFlight).toBe(0);
  });

  test("device-label tools/call serializes with explicit calls for the mapped device", async () => {
    sessionDevices.set("session-a", "device-1");
    sessionDevices.set("session-a:B", "device-2");
    sessionCustomData.set("session-a", {
      deviceLabelMap: {
        A: "session-a",
        B: "session-a:B",
      },
    });
    let inFlight = 0;
    let maxInFlight = 0;

    (server as any).createMcpClient = async () => {
      const fake: FakeMcpClient = {
        listTools: async () => ({ tools: [] }),
        callTool: async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise<void>(resolve => {
            fakeTimer.setTimeout(resolve, 40);
          });
          inFlight -= 1;
          return { content: [] };
        },
        listResources: async () => ({ resources: [] }),
        readResource: async () => ({ contents: [] }),
        listResourceTemplates: async () => ({ resourceTemplates: [] }),
        close: async () => {},
      };
      return fake;
    };

    const [a, b] = await Promise.all([
      sendToolsCallWithArgs(socketPath, "observe", { sessionUuid: "session-a", device: "B" }),
      sendToolsCallWithArgs(socketPath, "observe", { deviceId: "device-2" }),
    ]);

    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
    expect(maxInFlight).toBe(1);
    expect(inFlight).toBe(0);
  });

  test("device-label tools/call ignores a stale deviceId when choosing the forward key", async () => {
    sessionDevices.set("session-a", "device-1");
    sessionDevices.set("session-a:B", "device-2");
    sessionCustomData.set("session-a", {
      deviceLabelMap: {
        A: "session-a",
        B: "session-a:B",
      },
    });
    let inFlight = 0;
    let maxInFlight = 0;

    (server as any).createMcpClient = async () => {
      const fake: FakeMcpClient = {
        listTools: async () => ({ tools: [] }),
        callTool: async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise<void>(resolve => {
            fakeTimer.setTimeout(resolve, 40);
          });
          inFlight -= 1;
          return { content: [] };
        },
        listResources: async () => ({ resources: [] }),
        readResource: async () => ({ contents: [] }),
        listResourceTemplates: async () => ({ resourceTemplates: [] }),
        close: async () => {},
      };
      return fake;
    };

    const [labelResult, explicitDeviceResult] = await Promise.all([
      sendToolsCallWithArgs(socketPath, "observe", {
        sessionUuid: "session-a",
        device: "B",
        deviceId: "device-1",
      }),
      sendToolsCallWithArgs(socketPath, "observe", { deviceId: "device-2" }),
    ]);

    expect(labelResult.success).toBe(true);
    expect(explicitDeviceResult.success).toBe(true);
    expect(maxInFlight).toBe(1);
    expect(inFlight).toBe(0);
  });

  test("queued unbound session tools/call rekeys after the session binds to a device", async () => {
    let inFlightAfterBind = 0;
    let maxInFlightAfterBind = 0;
    let releaseFirstSessionCall: () => void = () => {};
    let resolveFirstSessionCallStarted: () => void = () => {};
    let resolveSessionBound: () => void = () => {};
    const firstSessionCallStarted = new Promise<void>(resolve => { resolveFirstSessionCallStarted = resolve; });
    const firstSessionCallReleased = new Promise<void>(resolve => { releaseFirstSessionCall = resolve; });
    const sessionBound = new Promise<void>(resolve => { resolveSessionBound = resolve; });

    (server as any).createMcpClient = async () => {
      const fake: FakeMcpClient = {
        listTools: async () => ({ tools: [] }),
        callTool: async request => {
          const args = (request as { arguments: Record<string, unknown> }).arguments;
          if (args.sessionUuid === "session-a" && !sessionDevices.has("session-a")) {
            resolveFirstSessionCallStarted();
            await firstSessionCallReleased;
            sessionDevices.set("session-a", "device-1");
            resolveSessionBound();
            return { content: [] };
          }

          if (args.deviceId === "device-1") {
            await sessionBound;
          }

          inFlightAfterBind += 1;
          maxInFlightAfterBind = Math.max(maxInFlightAfterBind, inFlightAfterBind);
          await new Promise<void>(resolve => {
            fakeTimer.setTimeout(resolve, 40);
          });
          inFlightAfterBind -= 1;
          return { content: [] };
        },
        listResources: async () => ({ resources: [] }),
        readResource: async () => ({ contents: [] }),
        listResourceTemplates: async () => ({ resourceTemplates: [] }),
        close: async () => {},
      };
      return fake;
    };

    const first = sendToolsCallWithArgs(socketPath, "observe", { sessionUuid: "session-a" });
    await firstSessionCallStarted;
    const queuedSameSession = sendToolsCallWithArgs(socketPath, "observe", { sessionUuid: "session-a" });
    const explicitDevice = sendToolsCallWithArgs(socketPath, "observe", { deviceId: "device-1" });

    releaseFirstSessionCall();

    const [firstResult, sameSessionResult, explicitDeviceResult] = await Promise.all([
      first,
      queuedSameSession,
      explicitDevice,
    ]);

    expect(firstResult.success).toBe(true);
    expect(sameSessionResult.success).toBe(true);
    expect(explicitDeviceResult.success).toBe(true);
    expect(maxInFlightAfterBind).toBe(1);
    expect(inFlightAfterBind).toBe(0);
  });

  test("implicit autolock tools/call serializes with explicit session calls for the same device", async () => {
    let inFlightAfterAutolock = 0;
    let maxInFlightAfterAutolock = 0;
    let releaseFirstImplicitCall: () => void = () => {};
    let resolveAutolockReady: () => void = () => {};
    const firstImplicitCallReleased = new Promise<void>(resolve => { releaseFirstImplicitCall = resolve; });
    const autolockReady = new Promise<void>(resolve => { resolveAutolockReady = resolve; });

    (server as any).createMcpClient = async () => {
      const fake: FakeMcpClient = {
        listTools: async () => ({ tools: [] }),
        callTool: async request => {
          const args = (request as { arguments: Record<string, unknown> }).arguments;
          const mcpSessionId = String(args.__mcpSessionId);
          if (!mcpAutolockSessions.has(mcpSessionId) && !args.sessionUuid) {
            mcpAutolockSessions.set(mcpSessionId, "session-a");
            sessionDevices.set("session-a", "device-1");
            resolveAutolockReady();
            await firstImplicitCallReleased;
            return { content: [] };
          }

          if (args.sessionUuid === "session-a") {
            await firstImplicitCallReleased;
          }

          inFlightAfterAutolock += 1;
          maxInFlightAfterAutolock = Math.max(maxInFlightAfterAutolock, inFlightAfterAutolock);
          await new Promise<void>(resolve => {
            fakeTimer.setTimeout(resolve, 40);
          });
          inFlightAfterAutolock -= 1;
          return { content: [] };
        },
        listResources: async () => ({ resources: [] }),
        readResource: async () => ({ contents: [] }),
        listResourceTemplates: async () => ({ resourceTemplates: [] }),
        close: async () => {},
      };
      return fake;
    };

    const implicitSocketCalls = sendTwoToolsCallsOnOneSocket(socketPath, "observe");
    await autolockReady;
    const explicitSessionCall = sendToolsCallWithArgs(socketPath, "observe", { sessionUuid: "session-a" });

    releaseFirstImplicitCall();

    const [implicitResults, explicitSessionResult] = await Promise.all([
      implicitSocketCalls,
      explicitSessionCall,
    ]);

    expect(implicitResults.every(response => response.success)).toBe(true);
    expect(explicitSessionResult.success).toBe(true);
    expect(maxInFlightAfterAutolock).toBe(1);
    expect(inFlightAfterAutolock).toBe(0);
  });

  test("concurrent tools/call for different devices can overlap inside callTool", async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    (server as any).createMcpClient = async () => {
      const fake: FakeMcpClient = {
        listTools: async () => ({ tools: [] }),
        callTool: async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise<void>(resolve => {
            fakeTimer.setTimeout(resolve, 40);
          });
          inFlight -= 1;
          return { content: [] };
        },
        listResources: async () => ({ resources: [] }),
        readResource: async () => ({ contents: [] }),
        listResourceTemplates: async () => ({ resourceTemplates: [] }),
        close: async () => {},
      };
      return fake;
    };

    const [a, b] = await Promise.all([
      sendToolsCallWithArgs(socketPath, "observe", { deviceId: "device-1" }),
      sendToolsCallWithArgs(socketPath, "observe", { deviceId: "device-2" }),
    ]);

    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
    expect(maxInFlight).toBe(2);
    expect(inFlight).toBe(0);
  });

  test("concurrent implicit autolock tools/call from different sockets can overlap", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const forwardedSessionIds: string[] = [];

    (server as any).createMcpClient = async () => {
      const fake: FakeMcpClient = {
        listTools: async () => ({ tools: [] }),
        callTool: async request => {
          const args = (request as { arguments: Record<string, unknown> }).arguments;
          forwardedSessionIds.push(String(args.__mcpSessionId));
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise<void>(resolve => {
            fakeTimer.setTimeout(resolve, 40);
          });
          inFlight -= 1;
          return { content: [] };
        },
        listResources: async () => ({ resources: [] }),
        readResource: async () => ({ contents: [] }),
        listResourceTemplates: async () => ({ resourceTemplates: [] }),
        close: async () => {},
      };
      return fake;
    };

    const [a, b] = await Promise.all([
      sendToolsCallWithArgs(socketPath, "observe", {}),
      sendToolsCallWithArgs(socketPath, "observe", {}),
    ]);

    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
    expect(maxInFlight).toBe(2);
    expect(forwardedSessionIds).toHaveLength(2);
    expect(forwardedSessionIds[0]).not.toBe(forwardedSessionIds[1]);
  });

  test("forwards the Unix socket session as the implicit autolock key", async () => {
    const forwardedCalls: unknown[] = [];

    (server as any).createMcpClient = async () => {
      const fake: FakeMcpClient = {
        listTools: async () => ({ tools: [] }),
        callTool: async request => {
          forwardedCalls.push(request);
          return { content: [] };
        },
        listResources: async () => ({ resources: [] }),
        readResource: async () => ({ contents: [] }),
        listResourceTemplates: async () => ({ resourceTemplates: [] }),
        close: async () => {},
      };
      return fake;
    };

    const [a, b] = await Promise.all([
      sendToolsCallWithArgs(socketPath, "startDevice", { platform: "android" }),
      sendToolsCallWithArgs(socketPath, "startDevice", { platform: "android" }),
    ]);

    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
    expect(forwardedCalls).toHaveLength(2);

    const firstArgs = (forwardedCalls[0] as { arguments: Record<string, unknown> }).arguments;
    const secondArgs = (forwardedCalls[1] as { arguments: Record<string, unknown> }).arguments;
    expect(firstArgs.platform).toBe("android");
    expect(secondArgs.platform).toBe("android");
    expect(typeof firstArgs.__mcpSessionId).toBe("string");
    expect(typeof secondArgs.__mcpSessionId).toBe("string");
    expect(firstArgs.__mcpSessionId).not.toBe(secondArgs.__mcpSessionId);
  });

  test("uses a stable implicit autolock key for multiple calls on one Unix socket", async () => {
    const forwardedCalls: unknown[] = [];

    (server as any).createMcpClient = async () => {
      const fake: FakeMcpClient = {
        listTools: async () => ({ tools: [] }),
        callTool: async request => {
          forwardedCalls.push(request);
          return { content: [] };
        },
        listResources: async () => ({ resources: [] }),
        readResource: async () => ({ contents: [] }),
        listResourceTemplates: async () => ({ resourceTemplates: [] }),
        close: async () => {},
      };
      return fake;
    };

    const responses = await sendTwoToolsCallsOnOneSocket(socketPath, "observe");

    expect(responses.every(response => response.success)).toBe(true);
    expect(forwardedCalls).toHaveLength(2);
    const firstArgs = (forwardedCalls[0] as { arguments: Record<string, unknown> }).arguments;
    const secondArgs = (forwardedCalls[1] as { arguments: Record<string, unknown> }).arguments;
    expect(typeof firstArgs.__mcpSessionId).toBe("string");
    expect(secondArgs.__mcpSessionId).toBe(firstArgs.__mcpSessionId);
  });

  test("adds the Unix socket session autolock key when tool arguments are omitted", async () => {
    let forwardedCall: unknown;

    (server as any).createMcpClient = async () => {
      const fake: FakeMcpClient = {
        listTools: async () => ({ tools: [] }),
        callTool: async request => {
          forwardedCall = request;
          return { content: [] };
        },
        listResources: async () => ({ resources: [] }),
        readResource: async () => ({ contents: [] }),
        listResourceTemplates: async () => ({ resourceTemplates: [] }),
        close: async () => {},
      };
      return fake;
    };

    const response = await sendToolsCallWithoutArgs(socketPath, "observe");

    expect(response.success).toBe(true);
    expect(forwardedCall).toBeDefined();
    const args = (forwardedCall as { arguments: Record<string, unknown> }).arguments;
    expect(Object.keys(args)).toEqual(["__mcpSessionId"]);
    expect(typeof args.__mcpSessionId).toBe("string");
  });

  test("queued request fails fast when queue wait exceeds its timeout", async () => {
    let callCount = 0;
    let releaseBlockingRequest: () => void = () => {};
    const blockingPromise = new Promise<void>(r => { releaseBlockingRequest = r; });

    (server as any).createMcpClient = async () => {
      const fake: FakeMcpClient = {
        listTools: async () => ({ tools: [] }),
        callTool: async () => {
          callCount++;
          if (callCount === 1) {
            await blockingPromise;
          }
          return { content: [] };
        },
        listResources: async () => ({ resources: [] }),
        readResource: async () => ({ contents: [] }),
        listResourceTemplates: async () => ({ resourceTemplates: [] }),
        close: async () => {},
      };
      return fake;
    };

    // First request: blocks in callTool until we release it
    const first = sendToolsCallWithArgs(socketPath, "observe", { deviceId: "device-1" });

    // Yield to the real event loop so the first request enters callTool
    for (let i = 0; i < 10; i++) {
      await new Promise<void>(r => setImmediate(r));
    }

    // Second request: has a short timeout (500ms) that will expire in the queue
    const second = sendRequest(socketPath, {
      id: randomUUID(),
      type: "mcp_request",
      method: "tools/call",
      params: { name: "observe", arguments: { deviceId: "device-1" } },
      timeoutMs: 500,
    });

    // Yield to let socket data reach the server
    for (let i = 0; i < 10; i++) {
      await new Promise<void>(r => setImmediate(r));
    }

    // Advance time past the second request's timeout while it's queued
    fakeTimer.advanceTime(600);

    // Release the blocking request
    releaseBlockingRequest();

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.success).toBe(true);
    expect(secondResult.success).toBe(false);
    expect(secondResult.error).toContain("waiting in queue");
  });
});
