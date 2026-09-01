import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import { SOCKET_REQUEST_DEADLINE_MS, sendRawSocketRequest } from "./helpers/socketRequest";
import { defaultTimer } from "../../src/utils/SystemTimer";
import {
  DAEMON_BOUND_SESSION_PARAM,
  DAEMON_RELEASED_SESSION_PARAM,
  DAEMON_TOOL_SELECTION_PROFILE_PARAM,
  INTERNAL_MCP_REQUEST_TIMEOUT_PARAM,
} from "../../src/daemon/constants";
import { DEFAULT_OBSERVE_MCP_TIMEOUT_MS } from "../../src/daemon/mcpRequestTimeout";
import { FakeTimer } from "../fakes/FakeTimer";
import type { DaemonRequest, DaemonResponse } from "../../src/daemon/types";
import type { DeviceLabelMap, Session } from "../../src/daemon/sessionManager";

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

async function sendRequest(socketPath: string, request: DaemonRequest): Promise<DaemonResponse> {
  const { response } = await sendRawSocketRequest(socketPath, request);
  return response;
}

function sendToolsCallWithArgs(
  socketPath: string,
  toolName: string,
  args: Record<string, unknown>,
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

function sendTwoToolsCallsOnOneSocket(
  socketPath: string,
  toolName: string,
): Promise<DaemonResponse[]> {
  return new Promise((resolve, reject) => {
    const client = new Socket();
    const responses: DaemonResponse[] = [];
    let buffer = "";

    client.connect(socketPath, () => {
      for (let i = 0; i < 2; i++) {
        client.write(
          JSON.stringify({
            id: randomUUID(),
            type: "mcp_request",
            method: "tools/call",
            params: { name: toolName, arguments: {} },
          }) + "\n",
        );
      }
    });

    // Bounded: two unanswered pipelined requests must fail fast with a
    // diagnostic, not pend until the suite's wall-clock watchdog (#5391).
    const deadline = defaultTimer.setTimeout(() => {
      client.destroy();
      reject(
        new Error(
          `Received ${responses.length}/2 responses to pipelined tools/call within ${SOCKET_REQUEST_DEADLINE_MS}ms — ` +
            "bounded socket-test deadline hit",
        ),
      );
    }, SOCKET_REQUEST_DEADLINE_MS);

    client.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        responses.push(JSON.parse(line) as DaemonResponse);
        if (responses.length === 2) {
          defaultTimer.clearTimeout(deadline);
          client.destroy();
          resolve(responses);
          return;
        }
      }
    });

    client.on("error", (error) => {
      defaultTimer.clearTimeout(deadline);
      reject(error);
    });
    client.on("close", () => {
      defaultTimer.clearTimeout(deadline);
      if (responses.length < 2) {
        reject(new Error(`Connection closed after ${responses.length} responses`));
      }
    });
  });
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
      this.socket.on("data", (data) => {
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

  request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<DaemonResponse> {
    const id = randomUUID();
    this.socket.write(
      JSON.stringify({
        id,
        type: "mcp_request",
        method,
        params,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      }) + "\n",
    );
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
        reject(
          new Error(
            `No response to ${method} within ${SOCKET_REQUEST_DEADLINE_MS}ms — bounded socket-test deadline hit`,
          ),
        );
      }, SOCKET_REQUEST_DEADLINE_MS);
      this.waiters.set(id, (response) => {
        defaultTimer.clearTimeout(deadline);
        resolve(response);
      });
    });
  }

  close(): void {
    this.socket.destroy();
  }
}

describe("UnixSocketServer MCP forward serialization", () => {
  let socketPath: string;
  let server: UnixSocketServer;
  let fakeTimer: FakeTimer;
  let sessionDevices: Map<string, string>;
  let sessionDeviceLabels: Map<string, DeviceLabelMap>;
  let mcpAutolockSessions: Map<string, string>;

  beforeEach(async () => {
    socketPath = join(tmpdir(), `mcp-ser-${randomUUID()}.sock`);
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    sessionDevices = new Map();
    sessionDeviceLabels = new Map();
    mcpAutolockSessions = new Map();
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(sessionDevices, sessionDeviceLabels, mcpAutolockSessions),
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

    server.mcpClientFactory = async () => {
      const fake: FakeMcpClient = {
        listTools: async () => ({ tools: [] }),
        callTool: async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise<void>((resolve) => {
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

  test("forwards the socket timeout budget to IDE navigation graph calls", async () => {
    let forwardedCall: unknown;
    server.mcpClientFactory = async () => ({
      listTools: async () => ({ tools: [] }),
      callTool: async (request) => {
        forwardedCall = request;
        return { content: [] };
      },
      listResources: async () => ({ resources: [] }),
      readResource: async () => ({ contents: [] }),
      listResourceTemplates: async () => ({ resourceTemplates: [] }),
      close: async () => {},
    });

    const response = await sendRequest(socketPath, {
      id: randomUUID(),
      type: "mcp_request",
      method: "ide/getNavigationGraph",
      params: { deviceId: "device-1" },
      timeoutMs: 7_500,
    });

    expect(response.success).toBe(true);
    expect(forwardedCall).toEqual({
      name: "getNavigationGraph",
      arguments: {
        deviceId: "device-1",
        [INTERNAL_MCP_REQUEST_TIMEOUT_PARAM]: 7_500,
      },
    });
  });

  test("charges time spent in the per-socket queue against the forwarded timeout", async () => {
    await server.close();
    socketPath = join(tmpdir(), `mcp-outer-deadline-${randomUUID()}.sock`);
    fakeTimer = new FakeTimer();
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(sessionDevices, sessionDeviceLabels, mcpAutolockSessions),
      fakeTimer,
    );
    await server.start();

    const firstCallStarted = Promise.withResolvers<void>();
    const releaseFirstCall = Promise.withResolvers<void>();
    let callCount = 0;
    server.mcpClientFactory = async () => ({
      listTools: async () => ({ tools: [] }),
      callTool: async () => {
        callCount += 1;
        if (callCount === 1) {
          firstCallStarted.resolve();
          await releaseFirstCall.promise;
        }
        return { content: [] };
      },
      listResources: async () => ({ resources: [] }),
      readResource: async () => ({ contents: [] }),
      listResourceTemplates: async () => ({ resourceTemplates: [] }),
      close: async () => {},
    });

    const client = new PersistentSocketClient();
    await client.connect(socketPath);
    try {
      const first = client.request("tools/call", {
        name: "tapOn",
        arguments: { deviceId: "device-1" },
      });
      await firstCallStarted.promise;
      const queued = client.request(
        "tools/call",
        {
          name: "tapOn",
          arguments: { deviceId: "device-1" },
        },
        500,
      );
      for (let attempt = 0; attempt < 20; attempt++) {
        const contexts = Array.from(
          (
            server as unknown as {
              sessions: Map<string, { requestQueue: unknown[] }>;
            }
          ).sessions.values(),
        );
        if (contexts.some((context) => context.requestQueue.length > 0)) {
          break;
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      const queuedRequestCount = Array.from(
        (
          server as unknown as {
            sessions: Map<string, { requestQueue: unknown[] }>;
          }
        ).sessions.values(),
      ).reduce((count, context) => count + context.requestQueue.length, 0);
      expect(queuedRequestCount).toBe(1);

      fakeTimer.advanceTime(501);
      releaseFirstCall.resolve();

      await expect(first).resolves.toMatchObject({ success: true });
      await expect(queued).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining("exceeded 500ms"),
      });
      expect(callCount).toBe(1);
    } finally {
      client.close();
    }
  });

  test("binds a generated selection profile to the socket and reuses it for discovery", async () => {
    const clients: FakeMcpClient[] = [];
    server.mcpClientFactory = async () => {
      const client: FakeMcpClient = {
        callTool: async () => ({
          content: [{ type: "text", text: JSON.stringify({ sessionUuid: "profile-a" }) }],
        }),
        listTools: async () => ({ tools: [{ name: `profile-client-${clients.length}` }] }),
        listResources: async () => ({ resources: [] }),
        readResource: async () => ({ contents: [] }),
        listResourceTemplates: async () => ({ resourceTemplates: [] }),
        close: async () => {},
      };
      clients.push(client);
      return client;
    };

    const client = new PersistentSocketClient();
    await client.connect(socketPath);
    try {
      const set = await client.request("tools/call", {
        name: "setToolEnabled",
        arguments: { toolName: "executePlan" },
      });
      const list = await client.request("tools/list", {});

      expect(set.success).toBe(true);
      expect(list.result).toEqual({ tools: [{ name: "profile-client-1" }] });
      // `clients.length` is one while listTools executes: the generated profile
      // stayed on the socket's loopback transport instead of falling back to an
      // unbound tools/list client.
      expect(clients).toHaveLength(1);
    } finally {
      client.close();
    }
  });

  test("preserves a socket-bound selection profile for a later explicit device call", async () => {
    const factoryArguments: Array<[string | undefined, string | undefined]> = [];
    server.mcpClientFactory = async (sessionUuid, toolSelectionProfileUuid) => {
      factoryArguments.push([sessionUuid, toolSelectionProfileUuid]);
      return {
        callTool: async () => ({
          content: [{ type: "text", text: JSON.stringify({ sessionUuid: "profile-a" }) }],
        }),
        listTools: async () => ({ tools: [] }),
        listResources: async () => ({ resources: [] }),
        readResource: async () => ({ contents: [] }),
        listResourceTemplates: async () => ({ resourceTemplates: [] }),
        close: async () => {},
      };
    };

    const client = new PersistentSocketClient();
    await client.connect(socketPath);
    try {
      await client.request("tools/call", {
        name: "setToolEnabled",
        arguments: { toolName: "executePlan" },
      });
      const call = await client.request("tools/call", {
        name: "executePlan",
        arguments: { sessionUuid: "device-session-a" },
      });

      expect(call.success).toBe(true);
      expect(factoryArguments).toEqual([
        [undefined, undefined],
        ["device-session-a", "profile-a"],
      ]);
    } finally {
      client.close();
    }
  });

  test("creates a loopback client with both an explicit device session and its selection profile", async () => {
    const factoryArguments: Array<[string | undefined, string | undefined]> = [];
    server.mcpClientFactory = async (sessionUuid, toolSelectionProfileUuid) => {
      factoryArguments.push([sessionUuid, toolSelectionProfileUuid]);
      return {
        callTool: async () => ({ content: [] }),
        listTools: async () => ({ tools: [] }),
        listResources: async () => ({ resources: [] }),
        readResource: async () => ({ contents: [] }),
        listResourceTemplates: async () => ({ resourceTemplates: [] }),
        close: async () => {},
      };
    };

    const response = await sendToolsCallWithArgs(socketPath, "executePlan", {
      sessionUuid: "device-session-a",
      [DAEMON_TOOL_SELECTION_PROFILE_PARAM]: "profile-a",
    });

    expect(response.success).toBe(true);
    expect(factoryArguments).toEqual([["device-session-a", "profile-a"]]);
  });

  test("routes sessionless calls through the client bound by an earlier session-aware call", async () => {
    await server.close();
    socketPath = join(tmpdir(), `mcp-session-list-${randomUUID()}.sock`);
    fakeTimer = new FakeTimer();
    sessionDevices.set("session-a", "device-a");
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(sessionDevices, sessionDeviceLabels, mcpAutolockSessions),
      fakeTimer,
    );
    await server.start();

    const clients: FakeMcpClient[] = [];
    const forwardedCalls: Array<{ clientIndex: number; toolName: string | undefined }> = [];
    server.mcpClientFactory = async () => {
      const clientIndex = clients.length;
      const client: FakeMcpClient = {
        listTools: async () => ({ tools: [{ name: `client-${clientIndex}` }] }),
        callTool: async (...args: unknown[]) => {
          forwardedCalls.push({
            clientIndex,
            toolName: (args[0] as { name?: string }).name,
          });
          return { content: [] };
        },
        listResources: async () => ({ resources: [] }),
        readResource: async () => ({ contents: [] }),
        listResourceTemplates: async () => ({ resourceTemplates: [] }),
        close: async () => {},
      };
      clients.push(client);
      return client;
    };

    const client = new PersistentSocketClient();
    await client.connect(socketPath);
    try {
      const initialList = await client.request("tools/list", {});
      const call = await client.request("tools/call", {
        name: "observe",
        arguments: { sessionUuid: "session-a" },
      });
      const sessionlessCall = await client.request("tools/call", {
        name: "videoRecording",
        arguments: { action: "stop", recordingId: "recording-1", deviceId: "device-a" },
      });
      const navigationGraph = await client.request("ide/getNavigationGraph", {
        deviceId: "device-a",
      });
      const refreshedList = await client.request("tools/list", {});

      expect(initialList.success).toBe(true);
      expect(initialList.result).toEqual({ tools: [{ name: "client-0" }] });
      expect(call.success).toBe(true);
      expect(sessionlessCall.success).toBe(true);
      expect(navigationGraph.success).toBe(true);
      expect(refreshedList.success).toBe(true);
      expect(refreshedList.result).toEqual({ tools: [{ name: "client-1" }] });
      expect(forwardedCalls).toEqual([
        { clientIndex: 1, toolName: "observe" },
        { clientIndex: 1, toolName: "videoRecording" },
        { clientIndex: 1, toolName: "getNavigationGraph" },
      ]);
      expect(clients).toHaveLength(2);
    } finally {
      client.close();
    }
  });

  test("keeps the admitted bound client when the socket disconnects before a queued sessionless device call runs", async () => {
    // Socket B binds session-a → device-a, then submits a sessionless device-a
    // call that queues behind socket A's long-running op on the same device
    // (cross-socket, since one socket serializes its own frames). Socket B then
    // disconnects, so its close handler clears the binding before the queued
    // route is recomputed. The recompute keeps the same executionKey
    // (device:device-a) but would otherwise swap B's session-specific client for
    // the shared unbound client, running the admitted tool with no capability
    // profile. The admitted client/session must be preserved (issue #4610). The
    // disconnect is driven deterministically via the same clearBoundMcpClientKey
    // seam the socket "close" handler uses.
    await server.close();
    socketPath = join(tmpdir(), `mcp-disconnect-admit-${randomUUID()}.sock`);
    fakeTimer = new FakeTimer();
    sessionDevices.set("session-a", "device-a");
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(sessionDevices, sessionDeviceLabels, mcpAutolockSessions),
      fakeTimer,
    );
    await server.start();

    let releaseBlocker: () => void = () => {};
    const blockerReleased = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    let signalBlockerStarted: () => void = () => {};
    const blockerStarted = new Promise<void>((resolve) => {
      signalBlockerStarted = resolve;
    });

    const forwardedCalls: Array<{ createdWith: string | undefined; toolName: string | undefined }> =
      [];
    server.mcpClientFactory = async (createdWith?: string) => {
      const client: FakeMcpClient = {
        listTools: async () => ({ tools: [] }),
        callTool: async (...args: unknown[]) => {
          const request = args[0] as { name?: string };
          // Socket A's blocker holds the device:device-a queue until released.
          if (request.name === "tapOn") {
            signalBlockerStarted();
            await blockerReleased;
          }
          forwardedCalls.push({ createdWith, toolName: request.name });
          return { content: [] };
        },
        listResources: async () => ({ resources: [] }),
        readResource: async () => ({ contents: [] }),
        listResourceTemplates: async () => ({ resourceTemplates: [] }),
        close: async () => {},
      };
      return client;
    };

    const socketB = new PersistentSocketClient();
    const socketA = new PersistentSocketClient();
    await Promise.all([socketB.connect(socketPath), socketA.connect(socketPath)]);
    try {
      // Socket B binds session-a → device-a (awaited so the binding is set).
      const boundCall = await socketB.request("tools/call", {
        name: "observe",
        arguments: { sessionUuid: "session-a" },
      });
      expect(boundCall.success).toBe(true);

      // Socket A's long-running SESSIONLESS op occupies the device:device-a queue.
      const blockerCall = socketA.request("tools/call", {
        name: "tapOn",
        arguments: { deviceId: "device-a" },
      });
      await blockerStarted;

      // Socket B's sessionless device-a call: admitted with B's bound client,
      // queued behind socket A's op (same executionKey device:device-a).
      const queuedCall = socketB.request("tools/call", {
        name: "videoRecording",
        arguments: { action: "stop", recordingId: "recording-1", deviceId: "device-a" },
      });
      // Let socket B read the frame and compute its initial (bound) route while
      // the binding still exists.
      for (let i = 0; i < 30; i++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }

      // Simulate socket B's "close" handler: clear its bound client key while the
      // sessionless call is still queued behind socket A's op.
      const boundClientKeysBySocketSession = (
        server as unknown as {
          boundMcpClientKeysBySocketSession: Map<string, unknown>;
        }
      ).boundMcpClientKeysBySocketSession;
      const socketSessionId = boundClientKeysBySocketSession.keys().next().value as string;
      expect(socketSessionId).toBeDefined();
      (
        server as unknown as {
          clearBoundMcpClientKey(socketSessionId: string): void;
        }
      ).clearBoundMcpClientKey(socketSessionId);

      // Release socket A's op so socket B's queued call runs post-disconnect.
      releaseBlocker();
      await Promise.all([blockerCall, queuedCall]);

      const queued = forwardedCalls.find((call) => call.toolName === "videoRecording");
      expect(queued).toBeDefined();
      // The admitted request must still run through B's session-a bound client
      // (created with sessionUuid "session-a"), not the shared unbound client
      // socket A created for device:device-a (created with undefined).
      expect(queued?.createdWith).toBe("session-a");
    } finally {
      releaseBlocker();
      socketB.close();
      socketA.close();
    }
  });

  test("re-resolves a queued sessionless device call when its bound session is RELEASED mid-queue", async () => {
    // Mirror of the disconnect test above, but the admitted session is genuinely
    // RELEASED (heartbeat/idle/explicit) while the sessionless device call is
    // queued — not merely a socket disconnect. Invoking the stale session-scoped
    // client would re-seed the released UUID and resurrect the session
    // (getOrCreateSession recreates it and reacquires a device). The daemon
    // session no longer being active is exactly what distinguishes this from the
    // disconnect case, so the queued call must re-resolve to the shared, UNSEEDED
    // client (created with `undefined`) instead of replaying session-a
    // (issue #4610). The release is driven deterministically by removing the
    // session from the fake session manager, the same observable state a real
    // releaseSession produces.
    await server.close();
    socketPath = join(tmpdir(), `mcp-release-requeue-${randomUUID()}.sock`);
    fakeTimer = new FakeTimer();
    sessionDevices.set("session-a", "device-a");
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(sessionDevices, sessionDeviceLabels, mcpAutolockSessions),
      fakeTimer,
    );
    await server.start();

    let releaseBlocker: () => void = () => {};
    const blockerReleased = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    let signalBlockerStarted: () => void = () => {};
    const blockerStarted = new Promise<void>((resolve) => {
      signalBlockerStarted = resolve;
    });

    const forwardedCalls: Array<{ createdWith: string | undefined; toolName: string | undefined }> =
      [];
    server.mcpClientFactory = async (createdWith?: string) => {
      const client: FakeMcpClient = {
        listTools: async () => ({ tools: [] }),
        callTool: async (...args: unknown[]) => {
          const request = args[0] as { name?: string };
          if (request.name === "tapOn") {
            signalBlockerStarted();
            await blockerReleased;
          }
          forwardedCalls.push({ createdWith, toolName: request.name });
          return { content: [] };
        },
        listResources: async () => ({ resources: [] }),
        readResource: async () => ({ contents: [] }),
        listResourceTemplates: async () => ({ resourceTemplates: [] }),
        close: async () => {},
      };
      return client;
    };

    const socketB = new PersistentSocketClient();
    const socketA = new PersistentSocketClient();
    await Promise.all([socketB.connect(socketPath), socketA.connect(socketPath)]);
    try {
      // Socket B binds session-a → device-a (awaited so the binding is set).
      const boundCall = await socketB.request("tools/call", {
        name: "observe",
        arguments: { sessionUuid: "session-a" },
      });
      expect(boundCall.success).toBe(true);

      // Socket A's long-running SESSIONLESS op occupies the device:device-a queue.
      const blockerCall = socketA.request("tools/call", {
        name: "tapOn",
        arguments: { deviceId: "device-a" },
      });
      await blockerStarted;

      // Socket B's sessionless device-a call: admitted with B's bound client,
      // queued behind socket A's op (same executionKey device:device-a).
      const queuedCall = socketB.request("tools/call", {
        name: "videoRecording",
        arguments: { action: "stop", recordingId: "recording-1", deviceId: "device-a" },
      });
      // Let socket B read the frame and compute its initial (bound) route while
      // session-a is still active.
      for (let i = 0; i < 30; i++) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }

      // Release session-a while the sessionless call is still queued: the fake
      // session manager now reports it gone, so hasActiveDaemonSession(session-a)
      // is false when the queued route recomputes.
      sessionDevices.delete("session-a");

      // Release socket A's op so socket B's queued call runs post-release.
      releaseBlocker();
      await Promise.all([blockerCall, queuedCall]);

      const queued = forwardedCalls.find((call) => call.toolName === "videoRecording");
      expect(queued).toBeDefined();
      // The released session must NOT be replayed: the call re-resolves to the
      // shared unbound client socket A created for device:device-a (created with
      // undefined), never B's session-a bound client.
      expect(queued?.createdWith).toBeUndefined();
    } finally {
      releaseBlocker();
      socketB.close();
      socketA.close();
    }
  });

  test("re-arms the idle close after a queued forward times out in the queue", async () => {
    // An unbound forward that waits behind another request for the same shared
    // route until its timeout budget is exhausted throws the pre-forward
    // deadline BEFORE the forward body's own cleanup. The active-client wrapper
    // cleared the cached client's idle timer on entry, so without a re-arm the
    // inactive transport would stay cached until another request or shutdown
    // (issue #4610).
    await server.close();
    socketPath = join(tmpdir(), `mcp-queue-timeout-idle-${randomUUID()}.sock`);
    fakeTimer = new FakeTimer();
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(sessionDevices, sessionDeviceLabels, mcpAutolockSessions),
      fakeTimer,
    );
    await server.start();

    let callCount = 0;
    let closeCalls = 0;
    let releaseBlockingRequest: () => void = () => {};
    const blockingPromise = new Promise<void>((resolve) => {
      releaseBlockingRequest = resolve;
    });
    server.mcpClientFactory = async () =>
      ({
        listTools: async () => ({ tools: [] }),
        callTool: async () => {
          callCount += 1;
          if (callCount === 1) {
            await blockingPromise;
          }
          return { content: [] };
        },
        listResources: async () => ({ resources: [] }),
        readResource: async () => ({ contents: [] }),
        listResourceTemplates: async () => ({ resourceTemplates: [] }),
        close: async () => {
          closeCalls += 1;
        },
      }) as FakeMcpClient;

    // First request blocks in callTool. tapOn has no per-tool timeout floor so
    // the second request's short timeout is honored verbatim.
    const first = sendToolsCallWithArgs(socketPath, "tapOn", { deviceId: "device-1" });
    for (let i = 0; i < 10; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    const second = sendRequest(socketPath, {
      id: randomUUID(),
      type: "mcp_request",
      method: "tools/call",
      params: { name: "tapOn", arguments: { deviceId: "device-1" } },
      timeoutMs: 500,
    });
    for (let i = 0; i < 10; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    // Advance past the queued request's timeout, then release the blocker.
    fakeTimer.advanceTime(600);
    releaseBlockingRequest();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.success).toBe(true);
    expect(secondResult.success).toBe(false);
    expect(secondResult.error).toContain("waiting in queue");

    // Nothing has closed the shared transport yet.
    expect(closeCalls).toBe(0);

    // Advancing the idle window must close the cached transport — proving a
    // replacement idle timer was scheduled after the queued-timeout throw.
    await fakeTimer.advanceTimeAsync(5 * 60 * 1000);
    for (let i = 0; i < 20 && closeCalls === 0; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(closeCalls).toBe(1);
  });

  test("keeps tools/list isolated when two sockets bind different sessions on one device", async () => {
    sessionDevices.set("session-a", "device-a");
    sessionDevices.set("session-b", "device-a");
    const clients: FakeMcpClient[] = [];
    server.mcpClientFactory = async () => {
      let boundSessionUuid: string | undefined;
      const client: FakeMcpClient = {
        listTools: async () => ({
          tools: [{ name: boundSessionUuid ?? "unbound" }],
        }),
        callTool: async (...args: unknown[]) => {
          const request = args[0] as { arguments?: { sessionUuid?: string } };
          boundSessionUuid = request.arguments?.sessionUuid;
          return { content: [] };
        },
        listResources: async () => ({ resources: [] }),
        readResource: async () => ({ contents: [] }),
        listResourceTemplates: async () => ({ resourceTemplates: [] }),
        close: async () => {},
      };
      clients.push(client);
      return client;
    };

    const firstSocket = new PersistentSocketClient();
    const secondSocket = new PersistentSocketClient();
    await Promise.all([firstSocket.connect(socketPath), secondSocket.connect(socketPath)]);
    try {
      const firstBoundCall = await firstSocket.request("tools/call", {
        name: "observe",
        arguments: { sessionUuid: "session-a" },
      });
      const secondBoundCall = await secondSocket.request("tools/call", {
        name: "observe",
        arguments: { sessionUuid: "session-b" },
      });
      const [firstList, secondList] = await Promise.all([
        firstSocket.request("tools/list", {}),
        secondSocket.request("tools/list", {}),
      ]);

      expect(firstBoundCall.success).toBe(true);
      expect(secondBoundCall.success).toBe(true);
      expect(firstList.result).toEqual({ tools: [{ name: "session-a" }] });
      expect(secondList.result).toEqual({ tools: [{ name: "session-b" }] });
      expect(clients).toHaveLength(2);
    } finally {
      firstSocket.close();
      secondSocket.close();
    }
  });

  test("rejects a released implicit proxy binding instead of forwarding unbound", async () => {
    const clientBindings: Array<string | undefined> = [];
    const forwardedArguments: Array<Record<string, unknown>> = [];
    server.mcpClientFactory = async (boundSessionUuid) => {
      clientBindings.push(boundSessionUuid);
      return {
        listTools: async () => ({ tools: [] }),
        callTool: async (...args: unknown[]) => {
          const request = args[0] as { arguments?: Record<string, unknown> };
          forwardedArguments.push(request.arguments ?? {});
          return { content: [] };
        },
        listResources: async () => ({ resources: [] }),
        readResource: async () => ({ contents: [] }),
        listResourceTemplates: async () => ({ resourceTemplates: [] }),
        close: async () => {},
      };
    };

    const response = await sendToolsCallWithArgs(socketPath, "observe", {
      sessionUuid: "released-session",
      [DAEMON_BOUND_SESSION_PARAM]: "released-session",
    });

    expect(response.success).toBe(false);
    expect(response.error).toContain("Session not found: released-session");
    expect(clientBindings).toEqual([]);
    expect(forwardedArguments).toEqual([]);
  });

  test("rejects tools/list for a released implicit proxy binding", async () => {
    const clientBindings: Array<string | undefined> = [];
    server.mcpClientFactory = async (boundSessionUuid) => {
      clientBindings.push(boundSessionUuid);
      return {
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [] }),
        listResources: async () => ({ resources: [] }),
        readResource: async () => ({ contents: [] }),
        listResourceTemplates: async () => ({ resourceTemplates: [] }),
        close: async () => {},
      };
    };

    const response = await sendRequest(socketPath, {
      id: randomUUID(),
      type: "mcp_request",
      method: "tools/list",
      params: {
        sessionUuid: "released-session",
        [DAEMON_BOUND_SESSION_PARAM]: "released-session",
        [DAEMON_RELEASED_SESSION_PARAM]: "released-session",
      },
    });

    expect(response.success).toBe(false);
    expect(response.error).toContain("Session not found: released-session");
    expect(clientBindings).toEqual([]);
  });

  test("rejects released bound resource discovery before shared routing", async () => {
    const clientBindings: Array<[string | undefined, string | undefined]> = [];
    server.mcpClientFactory = async (boundSessionUuid, _profile, releasedSessionUuid) => {
      clientBindings.push([boundSessionUuid, releasedSessionUuid]);
      return {
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [] }),
        listResources: async () => ({ resources: [] }),
        readResource: async () => ({ contents: [] }),
        listResourceTemplates: async () => ({ resourceTemplates: [] }),
        close: async () => {},
      };
    };

    for (const method of ["resources/list", "resources/list-templates"]) {
      const response = await sendRequest(socketPath, {
        id: randomUUID(),
        type: "mcp_request",
        method,
        params: {
          sessionUuid: "released-session",
          [DAEMON_BOUND_SESSION_PARAM]: "released-session",
        },
      });

      expect(response.success).toBe(false);
      expect(response.error).toContain("Session not found: released-session");
    }
    expect(clientBindings).toEqual([]);
  });

  test("routes a bound resources/read call through its session-scoped MCP client", async () => {
    sessionDevices.set("session-a", "device-a");
    const clientBindings: Array<string | undefined> = [];
    server.mcpClientFactory = async (boundSessionUuid) => {
      clientBindings.push(boundSessionUuid);
      return {
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [] }),
        listResources: async () => ({ resources: [] }),
        readResource: async () => ({
          contents: [{ uri: "automobile:devices/booted", text: "[]" }],
        }),
        listResourceTemplates: async () => ({ resourceTemplates: [] }),
        close: async () => {},
      };
    };

    const response = await sendRequest(socketPath, {
      id: randomUUID(),
      type: "mcp_request",
      method: "resources/read",
      params: {
        uri: "automobile:devices/booted",
        sessionUuid: "session-a",
        [DAEMON_BOUND_SESSION_PARAM]: "session-a",
      },
    });

    expect(response.success).toBe(true);
    expect(clientBindings).toEqual(["session-a"]);
  });

  test("routes a released bound resource read so its handler can report the inactive session", async () => {
    const clientBindings: Array<[string | undefined, string | undefined]> = [];
    server.mcpClientFactory = async (boundSessionUuid, _profile, releasedSessionUuid) => {
      clientBindings.push([boundSessionUuid, releasedSessionUuid]);
      return {
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [] }),
        listResources: async () => ({ resources: [] }),
        readResource: async () => ({
          contents: [
            {
              uri: "automobile:device-session/released-session/screenshot",
              mimeType: "application/json",
              text: JSON.stringify({ code: "SESSION_NOT_ACTIVE" }),
            },
          ],
        }),
        listResourceTemplates: async () => ({ resourceTemplates: [] }),
        close: async () => {},
      };
    };

    const response = await sendRequest(socketPath, {
      id: randomUUID(),
      type: "mcp_request",
      method: "resources/read",
      params: {
        uri: "automobile:device-session/released-session/screenshot",
        sessionUuid: "released-session",
        [DAEMON_BOUND_SESSION_PARAM]: "released-session",
        [DAEMON_RELEASED_SESSION_PARAM]: "released-session",
      },
    });

    expect(response.success).toBe(true);
    expect(clientBindings).toEqual([["released-session", "released-session"]]);
  });

  test("retains a bound socket transport past the idle client deadline", async () => {
    sessionDevices.set("session-a", "device-a");
    let closeCalls = 0;
    server.mcpClientFactory = async () => {
      let boundSessionUuid: string | undefined;
      return {
        listTools: async () => ({
          tools: [{ name: boundSessionUuid ?? "unbound" }],
        }),
        callTool: async (...args: unknown[]) => {
          const request = args[0] as { arguments?: { sessionUuid?: string } };
          boundSessionUuid = request.arguments?.sessionUuid;
          return { content: [] };
        },
        listResources: async () => ({ resources: [] }),
        readResource: async () => ({ contents: [] }),
        listResourceTemplates: async () => ({ resourceTemplates: [] }),
        close: async () => {
          closeCalls++;
        },
      } as FakeMcpClient;
    };

    const client = new PersistentSocketClient();
    await client.connect(socketPath);
    try {
      const boundCall = await client.request("tools/call", {
        name: "observe",
        arguments: { sessionUuid: "session-a" },
      });
      fakeTimer.advanceTime(5 * 60 * 1000);
      await Promise.resolve();
      const list = await client.request("tools/list", {});

      expect(boundCall.success).toBe(true);
      expect(closeCalls).toBe(0);
      expect(list.result).toEqual({ tools: [{ name: "session-a" }] });
    } finally {
      client.close();
    }
  });

  test("retains a disconnected socket's transport while its device call is active", async () => {
    await server.close();
    socketPath = join(tmpdir(), `mcp-active-client-${randomUUID()}.sock`);
    fakeTimer = new FakeTimer();
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(sessionDevices, sessionDeviceLabels, mcpAutolockSessions),
      fakeTimer,
    );
    await server.start();
    sessionDevices.set("session-a", "device-a");
    let closeCalls = 0;
    let releaseLongCall: () => void = () => {};
    let signalLongCallStarted: () => void = () => {};
    let signalLongCallFinished: () => void = () => {};
    const longCallStarted = new Promise<void>((resolve) => {
      signalLongCallStarted = resolve;
    });
    const longCallReleased = new Promise<void>((resolve) => {
      releaseLongCall = resolve;
    });
    const longCallFinished = new Promise<void>((resolve) => {
      signalLongCallFinished = resolve;
    });
    let callCount = 0;
    server.mcpClientFactory = async () =>
      ({
        listTools: async () => ({ tools: [] }),
        callTool: async () => {
          callCount++;
          if (callCount === 2) {
            signalLongCallStarted();
            await longCallReleased;
            signalLongCallFinished();
          }
          return { content: [] };
        },
        listResources: async () => ({ resources: [] }),
        readResource: async () => ({ contents: [] }),
        listResourceTemplates: async () => ({ resourceTemplates: [] }),
        close: async () => {
          closeCalls++;
        },
      }) as FakeMcpClient;

    const client = new PersistentSocketClient();
    await client.connect(socketPath);
    try {
      const boundCall = await client.request("tools/call", {
        name: "observe",
        arguments: { sessionUuid: "session-a" },
      });
      const longCall = client.request("tools/call", {
        name: "executePlan",
        arguments: { sessionUuid: "session-a" },
      });
      await longCallStarted;
      const boundClientKeysBySocketSession = (
        server as unknown as {
          boundMcpClientKeysBySocketSession: Map<string, unknown>;
        }
      ).boundMcpClientKeysBySocketSession;
      const socketSessionId = boundClientKeysBySocketSession.keys().next().value;
      expect(socketSessionId).toBeDefined();
      (
        server as unknown as {
          clearBoundMcpClientKey(socketSessionId: string): void;
        }
      ).clearBoundMcpClientKey(socketSessionId);
      await fakeTimer.advanceTimeAsync(5 * 60 * 1000);

      try {
        expect(boundCall.success).toBe(true);
        expect(closeCalls).toBe(0);
      } finally {
        releaseLongCall();
        await longCallFinished;
        await longCall;
      }
    } finally {
      releaseLongCall();
      client.close();
    }
  });

  test("keeps the successful session binding when a later explicit session call fails", async () => {
    await server.close();
    socketPath = join(tmpdir(), `mcp-session-list-error-${randomUUID()}.sock`);
    fakeTimer = new FakeTimer();
    sessionDevices.set("session-a", "device-a");
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(sessionDevices, sessionDeviceLabels, mcpAutolockSessions),
      fakeTimer,
    );
    await server.start();

    const clients: FakeMcpClient[] = [];
    const forwardedCalls: Array<{ clientIndex: number; toolName: string | undefined }> = [];
    server.mcpClientFactory = async () => {
      const clientIndex = clients.length;
      const client: FakeMcpClient = {
        listTools: async () => ({ tools: [{ name: `client-${clientIndex}` }] }),
        callTool: async (...args: unknown[]) => {
          const request = args[0] as { name?: string; arguments?: { sessionUuid?: string } };
          forwardedCalls.push({ clientIndex, toolName: request.name });
          if (request.arguments?.sessionUuid === "session-b") {
            throw new Error("clipboard requires the 'clipboard' capability");
          }
          return { content: [] };
        },
        listResources: async () => ({ resources: [] }),
        readResource: async () => ({ contents: [] }),
        listResourceTemplates: async () => ({ resourceTemplates: [] }),
        close: async () => {},
      };
      clients.push(client);
      return client;
    };

    const client = new PersistentSocketClient();
    await client.connect(socketPath);
    try {
      await client.request("tools/list", {});
      const boundCall = await client.request("tools/call", {
        name: "observe",
        arguments: { sessionUuid: "session-a" },
      });
      const failedCall = await client.request("tools/call", {
        name: "clipboard",
        arguments: { sessionUuid: "session-b" },
      });
      const sessionlessCall = await client.request("tools/call", {
        name: "exportPlan",
        arguments: {},
      });
      const refreshedList = await client.request("tools/list", {});

      expect(boundCall.success).toBe(true);
      expect(failedCall.success).toBe(false);
      expect(sessionlessCall.success).toBe(true);
      expect(refreshedList.result).toEqual({ tools: [{ name: "client-1" }] });
      expect(forwardedCalls).toEqual([
        { clientIndex: 1, toolName: "observe" },
        { clientIndex: 2, toolName: "clipboard" },
        { clientIndex: 1, toolName: "exportPlan" },
      ]);
    } finally {
      client.close();
    }
  });

  test("preserves a profile-only binding for sessionless follow-up calls", async () => {
    const clients: FakeMcpClient[] = [];
    const forwardedCalls: Array<{ clientIndex: number; toolName: string | undefined }> = [];
    server.mcpClientFactory = async () => {
      const clientIndex = clients.length;
      const client: FakeMcpClient = {
        listTools: async () => ({ tools: [{ name: `client-${clientIndex}` }] }),
        callTool: async (...args: unknown[]) => {
          forwardedCalls.push({
            clientIndex,
            toolName: (args[0] as { name?: string }).name,
          });
          return { content: [] };
        },
        listResources: async () => ({ resources: [] }),
        readResource: async () => ({ contents: [] }),
        listResourceTemplates: async () => ({ resourceTemplates: [] }),
        close: async () => {},
      };
      clients.push(client);
      return client;
    };

    const client = new PersistentSocketClient();
    await client.connect(socketPath);
    try {
      await client.request("tools/list", {});
      const recordingStop = await client.request("tools/call", {
        name: "videoRecording",
        arguments: { action: "stop", recordingId: "recording-1", sessionUuid: "profile-only" },
      });
      const sessionlessCall = await client.request("tools/call", {
        name: "exportPlan",
        arguments: {},
      });
      const refreshedList = await client.request("tools/list", {});

      expect(recordingStop.success).toBe(true);
      expect(sessionlessCall.success).toBe(true);
      expect(forwardedCalls).toEqual([
        { clientIndex: 1, toolName: "videoRecording" },
        { clientIndex: 1, toolName: "exportPlan" },
      ]);
      expect(refreshedList.result).toEqual({ tools: [{ name: "client-1" }] });
    } finally {
      client.close();
    }
  });

  test("drops a bound client after its successful plan call releases the session", async () => {
    sessionDevices.set("session-a", "device-a");
    const clients: FakeMcpClient[] = [];
    const forwardedClientIndexes: number[] = [];
    server.mcpClientFactory = async () => {
      const clientIndex = clients.length;
      const client: FakeMcpClient = {
        listTools: async () => ({ tools: [{ name: `client-${clientIndex}` }] }),
        callTool: async (...args: unknown[]) => {
          forwardedClientIndexes.push(clientIndex);
          const request = args[0] as { name?: string; arguments?: { sessionUuid?: string } };
          if (request.name === "executePlan" && request.arguments?.sessionUuid === "session-a") {
            sessionDevices.delete("session-a");
          }
          return { content: [] };
        },
        listResources: async () => ({ resources: [] }),
        readResource: async () => ({ contents: [] }),
        listResourceTemplates: async () => ({ resourceTemplates: [] }),
        close: async () => {},
      };
      clients.push(client);
      return client;
    };

    const client = new PersistentSocketClient();
    await client.connect(socketPath);
    try {
      const initialList = await client.request("tools/list", {});
      const executePlan = await client.request("tools/call", {
        name: "executePlan",
        arguments: { sessionUuid: "session-a" },
      });
      const sessionlessCall = await client.request("tools/call", {
        name: "exportPlan",
        arguments: {},
      });
      const refreshedList = await client.request("tools/list", {});

      expect(initialList.result).toEqual({ tools: [{ name: "client-0" }] });
      expect(executePlan.success).toBe(true);
      expect(sessionlessCall.success).toBe(true);
      expect(forwardedClientIndexes).toEqual([1, 2]);
      expect(refreshedList.result).not.toEqual({ tools: [{ name: "client-1" }] });
    } finally {
      client.close();
    }
  });

  test("explicit device targets serialize even when session UUIDs differ", async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    server.mcpClientFactory = async () => {
      const fake: FakeMcpClient = {
        listTools: async () => ({ tools: [] }),
        callTool: async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise<void>((resolve) => {
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
      sendToolsCallWithArgs(socketPath, "observe", {
        deviceId: "device-1",
        sessionUuid: "session-a",
      }),
      sendToolsCallWithArgs(socketPath, "observe", {
        deviceId: "device-1",
        sessionUuid: "session-b",
      }),
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

    server.mcpClientFactory = async () => {
      const fake: FakeMcpClient = {
        listTools: async () => ({ tools: [] }),
        callTool: async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise<void>((resolve) => {
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
    sessionDeviceLabels.set("session-a", { A: "session-a", B: "session-a:B" });
    let inFlight = 0;
    let maxInFlight = 0;

    server.mcpClientFactory = async () => {
      const fake: FakeMcpClient = {
        listTools: async () => ({ tools: [] }),
        callTool: async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise<void>((resolve) => {
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
    sessionDeviceLabels.set("session-a", { A: "session-a", B: "session-a:B" });
    let inFlight = 0;
    let maxInFlight = 0;

    server.mcpClientFactory = async () => {
      const fake: FakeMcpClient = {
        listTools: async () => ({ tools: [] }),
        callTool: async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise<void>((resolve) => {
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
    const firstSessionCallStarted = new Promise<void>((resolve) => {
      resolveFirstSessionCallStarted = resolve;
    });
    const firstSessionCallReleased = new Promise<void>((resolve) => {
      releaseFirstSessionCall = resolve;
    });
    const sessionBound = new Promise<void>((resolve) => {
      resolveSessionBound = resolve;
    });

    server.mcpClientFactory = async () => {
      const fake: FakeMcpClient = {
        listTools: async () => ({ tools: [] }),
        callTool: async (request) => {
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
          await new Promise<void>((resolve) => {
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
    const queuedSameSession = sendToolsCallWithArgs(socketPath, "observe", {
      sessionUuid: "session-a",
    });
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
    const firstImplicitCallReleased = new Promise<void>((resolve) => {
      releaseFirstImplicitCall = resolve;
    });
    const autolockReady = new Promise<void>((resolve) => {
      resolveAutolockReady = resolve;
    });

    server.mcpClientFactory = async () => {
      const fake: FakeMcpClient = {
        listTools: async () => ({ tools: [] }),
        callTool: async (request) => {
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
          await new Promise<void>((resolve) => {
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
    const explicitSessionCall = sendToolsCallWithArgs(socketPath, "observe", {
      sessionUuid: "session-a",
    });

    releaseFirstImplicitCall();

    const [implicitResults, explicitSessionResult] = await Promise.all([
      implicitSocketCalls,
      explicitSessionCall,
    ]);

    expect(implicitResults.every((response) => response.success)).toBe(true);
    expect(explicitSessionResult.success).toBe(true);
    expect(maxInFlightAfterAutolock).toBe(1);
    expect(inFlightAfterAutolock).toBe(0);
  });

  test("concurrent tools/call for different devices can overlap inside callTool", async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    server.mcpClientFactory = async () => {
      const fake: FakeMcpClient = {
        listTools: async () => ({ tools: [] }),
        callTool: async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise<void>((resolve) => {
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

    server.mcpClientFactory = async () => {
      const fake: FakeMcpClient = {
        listTools: async () => ({ tools: [] }),
        callTool: async (request) => {
          const args = (request as { arguments: Record<string, unknown> }).arguments;
          forwardedSessionIds.push(String(args.__mcpSessionId));
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise<void>((resolve) => {
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

    server.mcpClientFactory = async () => {
      const fake: FakeMcpClient = {
        listTools: async () => ({ tools: [] }),
        callTool: async (request) => {
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

    server.mcpClientFactory = async () => {
      const fake: FakeMcpClient = {
        listTools: async () => ({ tools: [] }),
        callTool: async (request) => {
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

    expect(responses.every((response) => response.success)).toBe(true);
    expect(forwardedCalls).toHaveLength(2);
    const firstArgs = (forwardedCalls[0] as { arguments: Record<string, unknown> }).arguments;
    const secondArgs = (forwardedCalls[1] as { arguments: Record<string, unknown> }).arguments;
    expect(typeof firstArgs.__mcpSessionId).toBe("string");
    expect(secondArgs.__mcpSessionId).toBe(firstArgs.__mcpSessionId);
  });

  test("adds the Unix socket session autolock key when tool arguments are omitted", async () => {
    let forwardedCall: unknown;

    server.mcpClientFactory = async () => {
      const fake: FakeMcpClient = {
        listTools: async () => ({ tools: [] }),
        callTool: async (request) => {
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
    expect(args).toEqual({
      __mcpSessionId: expect.any(String),
      [INTERNAL_MCP_REQUEST_TIMEOUT_PARAM]: DEFAULT_OBSERVE_MCP_TIMEOUT_MS,
    });
    expect(typeof args.__mcpSessionId).toBe("string");
  });

  test("queued request fails fast when queue wait exceeds its timeout", async () => {
    let callCount = 0;
    let releaseBlockingRequest: () => void = () => {};
    const blockingPromise = new Promise<void>((r) => {
      releaseBlockingRequest = r;
    });

    server.mcpClientFactory = async () => {
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

    // First request: blocks in callTool until we release it. Uses tapOn (no per-tool
    // timeout floor) so the second request's short 500ms timeout is honored verbatim
    // rather than raised to observe's CtrlProxy cold-start floor (#2834).
    const first = sendToolsCallWithArgs(socketPath, "tapOn", { deviceId: "device-1" });

    // Yield to the real event loop so the first request enters callTool
    for (let i = 0; i < 10; i++) {
      await new Promise<void>((r) => setImmediate(r));
    }

    // Second request: has a short timeout (500ms) that will expire in the queue
    const second = sendRequest(socketPath, {
      id: randomUUID(),
      type: "mcp_request",
      method: "tools/call",
      params: { name: "tapOn", arguments: { deviceId: "device-1" } },
      timeoutMs: 500,
    });

    // Yield to let socket data reach the server
    for (let i = 0; i < 10; i++) {
      await new Promise<void>((r) => setImmediate(r));
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
