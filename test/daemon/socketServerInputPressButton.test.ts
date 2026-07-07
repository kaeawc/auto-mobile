import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import { PressButton } from "../../src/features/action/PressButton";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeTimer } from "../fakes/FakeTimer";
import type { DaemonRequest, DaemonResponse } from "../../src/daemon/types";
import type { DeviceLabelMap, Session } from "../../src/daemon/sessionManager";
import type { BootedDevice, PressButtonResult } from "../../src/models";

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

describe("UnixSocketServer input/pressButton", () => {
  let socketPath: string;
  let server: UnixSocketServer;
  let fakeTimer: FakeTimer;
  let originalPress: typeof PressButton.prototype.press;

  beforeEach(async () => {
    socketPath = join(tmpdir(), `input-press-button-${randomUUID()}.sock`);
    fakeTimer = new FakeTimer();
    PlatformDeviceManagerFactory.reset();
    originalPress = PressButton.prototype.press;
  });

  afterEach(async () => {
    if (server) {
      await server.close();
    }
    if (existsSync(socketPath)) {
      await unlink(socketPath);
    }
    PressButton.prototype.press = originalPress;
    PlatformDeviceManagerFactory.reset();
  });

  test("routes Android button presses without forwarding through tools/call", async () => {
    const press = mock(async (button: string): Promise<PressButtonResult> => ({
      success: true,
      button,
      keyCode: 24,
    }));
    const createMcpClient = mock(async () => {
      throw new Error("input/pressButton should not create an MCP client");
    });
    PressButton.prototype.press = press;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = new UnixSocketServer(socketPath, "http://localhost:0/mcp", createFakeDaemonState(), fakeTimer);
    (server as unknown as { createMcpClient: typeof createMcpClient }).createMcpClient = createMcpClient;
    await server.start();

    const response = await sendRequest(socketPath, "input/pressButton", {
      platform: "android",
      deviceId: "emulator-5554",
      button: "volume_up",
    });

    expect(response.success).toBe(true);
    expect(response.result).toEqual({
      action: "input/pressButton",
      platform: "android",
      deviceId: "emulator-5554",
      success: true,
      button: "volume_up",
    });
    expect(press).toHaveBeenCalledWith("volume_up", expect.any(Number));
    expect(createMcpClient).not.toHaveBeenCalled();
  });

  test("routes iOS button presses through the existing pressButton implementation", async () => {
    const press = mock(async (button: string): Promise<PressButtonResult> => ({
      success: true,
      button,
      keyCode: -1,
    }));
    PressButton.prototype.press = press;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([iosDevice]));
    server = new UnixSocketServer(socketPath, "http://localhost:0/mcp", createFakeDaemonState(), fakeTimer);
    await server.start();

    const response = await sendRequest(socketPath, "input/pressButton", {
      platform: "ios",
      deviceId: "ios-sim-1",
      button: "home",
    });

    expect(response.success).toBe(true);
    expect(response.result).toEqual({
      action: "input/pressButton",
      platform: "ios",
      deviceId: "ios-sim-1",
      success: true,
      button: "home",
    });
    expect(press).toHaveBeenCalledWith("home", expect.any(Number));
  });

  test("threads the client-supplied timeout budget into the button implementation", async () => {
    const press = mock(async (button: string): Promise<PressButtonResult> => ({
      success: true,
      button,
      keyCode: -1,
    }));
    PressButton.prototype.press = press;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([iosDevice]));
    server = new UnixSocketServer(socketPath, "http://localhost:0/mcp", createFakeDaemonState(), fakeTimer);
    await server.start();

    // With the FakeTimer no wall-clock elapses in the queue, so the remaining
    // budget threaded into press() equals the client's requested timeout.
    const response = await sendRequest(
      socketPath,
      "input/pressButton",
      {
        platform: "ios",
        deviceId: "ios-sim-1",
        button: "home",
      },
      500
    );

    expect(response.success).toBe(true);
    expect(press).toHaveBeenCalledWith("home", 500);
  });

  test("maps the socket app_switch contract name to the existing recent button implementation", async () => {
    const press = mock(async (button: string): Promise<PressButtonResult> => ({
      success: true,
      button,
      keyCode: -1,
    }));
    PressButton.prototype.press = press;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([iosDevice]));
    server = new UnixSocketServer(socketPath, "http://localhost:0/mcp", createFakeDaemonState(), fakeTimer);
    await server.start();

    const response = await sendRequest(socketPath, "input/pressButton", {
      platform: "ios",
      deviceId: "ios-sim-1",
      button: "app_switch",
    });

    expect(response.success).toBe(true);
    expect(response.result).toEqual({
      action: "input/pressButton",
      platform: "ios",
      deviceId: "ios-sim-1",
      success: true,
      button: "app_switch",
    });
    expect(press).toHaveBeenCalledWith("recent", expect.any(Number));
  });

  test("uses the socket autolock device when deviceId is omitted", async () => {
    const press = mock(async (button: string): Promise<PressButtonResult> => ({
      success: true,
      button,
      keyCode: 4,
    }));
    PressButton.prototype.press = press;
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
      method: "input/pressButton",
      params: {
        platform: "android",
        button: "back",
      },
    }, () => {
      const socketSessionId = [...((server as unknown as { sessions: Map<string, unknown> }).sessions.keys())][0];
      mcpAutolockSessions.set(socketSessionId, session.sessionId);
    });

    expect(response.success).toBe(true);
    expect(response.result).toMatchObject({
      platform: "android",
      deviceId: "emulator-5554",
      button: "back",
    });
    expect(press).toHaveBeenCalledWith("back", expect.any(Number));
  });

  test("propagates clear unsupported platform-gap errors from the button implementation", async () => {
    const press = mock(async (button: string): Promise<PressButtonResult> => ({
      success: false,
      button,
      keyCode: -1,
      error: "iOS has no menu hardware button",
    }));
    PressButton.prototype.press = press;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([iosDevice]));
    server = new UnixSocketServer(socketPath, "http://localhost:0/mcp", createFakeDaemonState(), fakeTimer);
    await server.start();

    const response = await sendRequest(socketPath, "input/pressButton", {
      platform: "ios",
      deviceId: "ios-sim-1",
      button: "menu",
    });

    expect(response.success).toBe(false);
    expect(response.error).toBe("iOS has no menu hardware button");
    expect(press).toHaveBeenCalledWith("menu", expect.any(Number));
  });

  test("accepts enter as a socket contract button and reports the current platform unsupported result", async () => {
    const press = mock(async (button: string): Promise<PressButtonResult> => ({
      success: false,
      button,
      keyCode: -1,
      error: "Unsupported button: enter",
    }));
    PressButton.prototype.press = press;
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = new UnixSocketServer(socketPath, "http://localhost:0/mcp", createFakeDaemonState(), fakeTimer);
    await server.start();

    const response = await sendRequest(socketPath, "input/pressButton", {
      platform: "android",
      deviceId: "emulator-5554",
      button: "enter",
    });

    expect(response.success).toBe(false);
    expect(response.error).toBe("Unsupported button: enter");
    expect(press).toHaveBeenCalledWith("enter", expect.any(Number));
  });

  test("rejects missing, non-string, and unsupported button values with actionable errors", async () => {
    PlatformDeviceManagerFactory.setInstance(createFakeDeviceManager([androidDevice]));
    server = new UnixSocketServer(socketPath, "http://localhost:0/mcp", createFakeDaemonState(), fakeTimer);
    await server.start();

    const missing = await sendRequest(socketPath, "input/pressButton", {
      platform: "android",
    });
    const nonString = await sendRequest(socketPath, "input/pressButton", {
      platform: "android",
      button: 4,
    });
    const unsupported = await sendRequest(socketPath, "input/pressButton", {
      platform: "android",
      button: "camera",
    });

    expect(missing.success).toBe(false);
    expect(missing.error).toBe("input/pressButton requires button");
    expect(nonString.success).toBe(false);
    expect(nonString.error).toBe("input/pressButton requires button");
    expect(unsupported.success).toBe(false);
    expect(unsupported.error).toBe(
      "input/pressButton button must be one of: home, back, menu, power, volume_up, volume_down, recent, app_switch, enter"
    );
  });
});
