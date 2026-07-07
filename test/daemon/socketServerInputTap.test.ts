import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import { IOSCtrlProxyClient } from "../../src/features/observe/ios";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeTimer } from "../fakes/FakeTimer";
import type { DaemonRequest, DaemonResponse } from "../../src/daemon/types";
import type { DeviceLabelMap, Session } from "../../src/daemon/sessionManager";
import type { BootedDevice } from "../../src/models";

const androidDevice: BootedDevice = {
  deviceId: "emulator-5554",
  name: "Pixel",
  platform: "android",
};

const iosDevice: BootedDevice = {
  deviceId: "ios-sim-1",
  name: "iPhone 16",
  platform: "ios",
};

function createFakeDeviceManager(
  devices: BootedDevice[],
  succeededPlatforms: Set<"android" | "ios"> = new Set(["android", "ios"])
) {
  return {
    getBootedDevicesDetailed: mock(async () => ({
      devices,
      succeededPlatforms,
    })),
  } as unknown as ReturnType<typeof PlatformDeviceManagerFactory.getInstance>;
}

function createFakeSession(sessionId: string, assignedDevice: string, platform: "android" | "ios"): Session {
  return {
    sessionId,
    assignedDevice,
    platform,
    createdAt: 0,
    lastUsedAt: 0,
    expiresAt: 60_000,
    cacheData: {},
    lastHeartbeat: 0,
    sessionTimeoutMs: 60_000,
    heartbeatTimeoutMs: 10_000,
    heartbeatTimeoutSource: "default",
    hasReceivedHeartbeat: false,
  };
}

function createFakeDaemonState(
  autolockSessions: Map<string, Session> = new Map(),
  mcpAutolockSessions: Map<string, string> = new Map()
) {
  return {
    isInitialized: () => true,
    getSessionManager: () => ({
      getSession: (sessionId: string) => autolockSessions.get(sessionId) ?? null,
      getDeviceLabels: (_sessionId: string): DeviceLabelMap | undefined => undefined,
      releaseSession: async () => null,
    }),
    getDevicePool: () => ({
      refreshDevices: async () => 0,
      getStats: () => ({ total: 0, idle: 0, assigned: 0, error: 0 }),
      releaseDevice: async () => {},
      resolveAutolockSessionForMcpSession: (mcpSessionId: string | undefined, platform?: "android" | "ios") => {
        if (!mcpSessionId) {
          return undefined;
        }
        const sessionId = mcpAutolockSessions.get(mcpSessionId);
        const session = sessionId ? autolockSessions.get(sessionId) : undefined;
        return session?.platform === platform ? session.sessionId : undefined;
      },
    }),
  };
}

function sendRequest(
  socketPath: string,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs?: number
): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    const client = new Socket();
    let buffer = "";
    const request: DaemonRequest = {
      id: randomUUID(),
      type: "mcp_request",
      method,
      params,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    };

    client.connect(socketPath, () => {
      client.write(JSON.stringify(request) + "\n");
    });

    client.on("data", data => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        try {
          const response = JSON.parse(line) as DaemonResponse;
          client.destroy();
          resolve(response);
          return;
        } catch {
          // Incomplete JSON, keep buffering.
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

function sendRequestAfterConnect(
  socketPath: string,
  request: DaemonRequest,
  onConnect: () => void
): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    const client = new Socket();
    let buffer = "";

    client.connect(socketPath, () => {
      onConnect();
      client.write(JSON.stringify(request) + "\n");
    });

    client.on("data", data => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        try {
          const response = JSON.parse(line) as DaemonResponse;
          client.destroy();
          resolve(response);
          return;
        } catch {
          // Incomplete JSON, keep buffering.
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

describe("UnixSocketServer input/tap", () => {
  let socketPath: string;
  let server: UnixSocketServer;
  let fakeTimer: FakeTimer;
  let originalAndroidGetInstance: typeof AndroidCtrlProxyClient.getInstance;
  let originalIosGetInstance: typeof IOSCtrlProxyClient.getInstance;

  beforeEach(async () => {
    socketPath = join(tmpdir(), `input-tap-${randomUUID()}.sock`);
    fakeTimer = new FakeTimer();
    PlatformDeviceManagerFactory.reset();
    AndroidCtrlProxyClient.resetInstances();
    IOSCtrlProxyClient.resetInstances();
    originalAndroidGetInstance = AndroidCtrlProxyClient.getInstance;
    originalIosGetInstance = IOSCtrlProxyClient.getInstance;
  });

  afterEach(async () => {
    if (server) {
      await server.close();
    }
    if (existsSync(socketPath)) {
      await unlink(socketPath);
    }
    AndroidCtrlProxyClient.getInstance = originalAndroidGetInstance;
    IOSCtrlProxyClient.getInstance = originalIosGetInstance;
    PlatformDeviceManagerFactory.reset();
    AndroidCtrlProxyClient.resetInstances();
    IOSCtrlProxyClient.resetInstances();
  });

  test("routes Android coordinate taps without forwarding through tools/call", async () => {
    const requestTapCoordinates = mock(async () => ({ success: true }));
    const createMcpClient = mock(async () => {
      throw new Error("input/tap should not create an MCP client");
    });
    AndroidCtrlProxyClient.getInstance = mock(() => ({
      requestTapCoordinates,
    })) as unknown as typeof AndroidCtrlProxyClient.getInstance;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = new UnixSocketServer(socketPath, "http://localhost:0/mcp", createFakeDaemonState(), fakeTimer);
    (server as unknown as { createMcpClient: typeof createMcpClient }).createMcpClient = createMcpClient;
    await server.start();

    const response = await sendRequest(socketPath, "input/tap", {
      platform: "android",
      deviceId: "emulator-5554",
      x: 12.5,
      y: 34.25,
      duration: 80,
    }, 1234);

    expect(response.success).toBe(true);
    expect(response.result).toEqual({
      action: "input/tap",
      platform: "android",
      deviceId: "emulator-5554",
      success: true,
      coordinates: { x: 12.5, y: 34.25 },
    });
    expect(requestTapCoordinates).toHaveBeenCalledWith(12.5, 34.25, 80, 1234);
    expect(createMcpClient).not.toHaveBeenCalled();
  });

  test("routes iOS coordinate taps through the iOS gesture client", async () => {
    const requestTapCoordinates = mock(async () => ({ success: true }));
    IOSCtrlProxyClient.getInstance = mock(() => ({
      requestTapCoordinates,
    })) as unknown as typeof IOSCtrlProxyClient.getInstance;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([iosDevice]));
    server = new UnixSocketServer(socketPath, "http://localhost:0/mcp", createFakeDaemonState(), fakeTimer);
    await server.start();

    const response = await sendRequest(socketPath, "input/tap", {
      platform: "ios",
      deviceId: "ios-sim-1",
      x: 20,
      y: 30,
    });

    expect(response.success).toBe(true);
    expect(response.result).toMatchObject({
      action: "input/tap",
      platform: "ios",
      deviceId: "ios-sim-1",
      success: true,
      coordinates: { x: 20, y: 30 },
    });
    expect(requestTapCoordinates).toHaveBeenCalledWith(20, 30, undefined, 30_000);
  });

  test("uses the socket autolock device when deviceId is omitted", async () => {
    const requestTapCoordinates = mock(async () => ({ success: true }));
    AndroidCtrlProxyClient.getInstance = mock(() => ({
      requestTapCoordinates,
    })) as unknown as typeof AndroidCtrlProxyClient.getInstance;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    const session = createFakeSession("session-1", "emulator-5554", "android");
    const autolockSessions = new Map([[session.sessionId, session]]);
    const mcpAutolockSessions = new Map<string, string>();
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createFakeDaemonState(autolockSessions, mcpAutolockSessions),
      fakeTimer
    );
    await server.start();

    const response = await sendRequestAfterConnect(socketPath, {
      id: randomUUID(),
      type: "mcp_request",
      method: "input/tap",
      params: {
        platform: "android",
        x: 1,
        y: 2,
      },
    }, () => {
      const socketSessionId = [...((server as unknown as { sessions: Map<string, unknown> }).sessions.keys())][0];
      mcpAutolockSessions.set(socketSessionId, session.sessionId);
    });

    expect(response.success).toBe(true);
    expect(response.result).toMatchObject({
      platform: "android",
      deviceId: "emulator-5554",
      coordinates: { x: 1, y: 2 },
    });
    expect(requestTapCoordinates).toHaveBeenCalledWith(1, 2, undefined, 30_000);
  });

  test("serializes concurrent taps for the same device across socket clients", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const requestTapCoordinates = mock(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>(resolve => {
        fakeTimer.setTimeout(resolve, 40);
      });
      inFlight -= 1;
      return { success: true };
    });
    AndroidCtrlProxyClient.getInstance = mock(() => ({
      requestTapCoordinates,
    })) as unknown as typeof AndroidCtrlProxyClient.getInstance;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    fakeTimer.enableAutoAdvance();
    server = new UnixSocketServer(socketPath, "http://localhost:0/mcp", createFakeDaemonState(), fakeTimer);
    await server.start();

    const [first, second] = await Promise.all([
      sendRequest(socketPath, "input/tap", {
        platform: "android",
        deviceId: "emulator-5554",
        x: 1,
        y: 1,
      }),
      sendRequest(socketPath, "input/tap", {
        platform: "android",
        deviceId: "emulator-5554",
        x: 2,
        y: 2,
      }),
    ]);

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(requestTapCoordinates).toHaveBeenCalledTimes(2);
    expect(maxInFlight).toBe(1);
    expect(inFlight).toBe(0);
  });

  test("fails queued taps before dispatch when queue wait exceeds timeout", async () => {
    let callCount = 0;
    let releaseBlockingRequest: () => void = () => {};
    const blockingPromise = new Promise<void>(resolve => {
      releaseBlockingRequest = resolve;
    });
    const requestTapCoordinates = mock(async () => {
      callCount += 1;
      if (callCount === 1) {
        await blockingPromise;
      }
      return { success: true };
    });
    AndroidCtrlProxyClient.getInstance = mock(() => ({
      requestTapCoordinates,
    })) as unknown as typeof AndroidCtrlProxyClient.getInstance;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = new UnixSocketServer(socketPath, "http://localhost:0/mcp", createFakeDaemonState(), fakeTimer);
    await server.start();

    const first = sendRequest(socketPath, "input/tap", {
      platform: "android",
      deviceId: "emulator-5554",
      x: 1,
      y: 1,
    });

    for (let i = 0; i < 10; i++) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }

    const second = sendRequest(socketPath, "input/tap", {
      platform: "android",
      deviceId: "emulator-5554",
      x: 2,
      y: 2,
    }, 500);

    for (let i = 0; i < 10; i++) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }

    fakeTimer.advanceTime(600);
    releaseBlockingRequest();

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.success).toBe(true);
    expect(secondResult.success).toBe(false);
    expect(secondResult.error).toContain("waiting in queue");
    expect(requestTapCoordinates).toHaveBeenCalledTimes(1);
  });

  test("surfaces platform discovery failures before device targeting errors", async () => {
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([], new Set()));
    server = new UnixSocketServer(socketPath, "http://localhost:0/mcp", createFakeDaemonState(), fakeTimer);
    await server.start();

    const response = await sendRequest(socketPath, "input/tap", {
      platform: "android",
      deviceId: "emulator-5554",
      x: 1,
      y: 1,
    });

    expect(response.success).toBe(false);
    expect(response.error).toBe("Unable to discover booted android devices for input/tap");
  });

  test("rejects missing and non-numeric coordinates with actionable errors", async () => {
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = new UnixSocketServer(socketPath, "http://localhost:0/mcp", createFakeDaemonState(), fakeTimer);
    await server.start();

    const missing = await sendRequest(socketPath, "input/tap", {
      platform: "android",
      y: 10,
    });
    const nonNumeric = await sendRequest(socketPath, "input/tap", {
      platform: "android",
      x: "12",
      y: 10,
    });

    expect(missing.success).toBe(false);
    expect(missing.error).toBe("input/tap requires numeric x and y params");
    expect(nonNumeric.success).toBe(false);
    expect(nonNumeric.error).toBe("input/tap requires numeric x and y params");
  });
});
