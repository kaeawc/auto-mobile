import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Socket } from "node:net";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeTimer } from "../fakes/FakeTimer";
import type { SessionToolProfileService } from "../../src/features/toolCapabilities/SessionToolProfileService";
import type { DaemonResponse } from "../../src/daemon/types";

const device = {
  deviceId: "emulator-5554",
  name: "Pixel",
  platform: "android" as const,
};

function createDaemonState(options?: { useLabeledSession?: boolean }) {
  return {
    isInitialized: () => true,
    getSessionManager: () => ({
      getSession: () => null,
      getSessionForDevice: (deviceId: string) => deviceId === device.deviceId
        ? options?.useLabeledSession ? "device-session-1:B" : "device-session-1"
        : null,
      getDeviceLabels: (sessionId: string) => sessionId === "device-session-1"
        ? { A: "device-session-1", B: "device-session-1:B" }
        : undefined,
      releaseSession: async () => null,
    }),
    getDevicePool: () => ({
      refreshDevices: async () => 0,
      getStats: () => ({ total: 0, idle: 0, assigned: 0, error: 0 }),
      releaseDevice: async () => {},
    }),
  };
}

function sendRequest(socketPath: string, method: string, params: Record<string, unknown>): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    let buffer = "";
    socket.connect(socketPath, () => {
      socket.write(JSON.stringify({
        id: randomUUID(),
        type: "mcp_request",
        method,
        params,
      }) + "\n");
    });
    socket.on("data", data => {
      buffer += data.toString();
      const line = buffer.split("\n").find(value => value.trim());
      if (line) {
        socket.destroy();
        resolve(JSON.parse(line) as DaemonResponse);
      }
    });
    socket.on("error", reject);
  });
}

describe("UnixSocketServer app-data capability enforcement", () => {
  let socketPath: string;
  let server: UnixSocketServer;
  let isEnabled: ReturnType<typeof mock>;
  let originalGetInstance: typeof AndroidCtrlProxyClient.getInstance;
  let getInstanceCalls: number;

  async function startServer(options?: { useLabeledSession?: boolean }): Promise<void> {
    socketPath = join(tmpdir(), `tool-capabilities-${randomUUID()}.sock`);
    isEnabled = mock(async () => false);
    const profileService: Pick<SessionToolProfileService, "isEnabled" | "setEnabled"> = {
      isEnabled,
      setEnabled: async () => {},
    };
    PlatformDeviceManagerFactory.setInstance({
      getBootedDevices: async () => [device],
    } as ReturnType<typeof PlatformDeviceManagerFactory.getInstance>);
    getInstanceCalls = 0;
    originalGetInstance = AndroidCtrlProxyClient.getInstance;
    AndroidCtrlProxyClient.getInstance = mock(() => {
      getInstanceCalls++;
      return {
        setPreference: async () => {},
        removePreference: async () => {},
        clearPreferenceStore: async () => {},
      };
    }) as typeof AndroidCtrlProxyClient.getInstance;
    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createDaemonState(options),
      new FakeTimer(),
      null,
      { sessionToolProfileService: profileService }
    );
    await server.start();
  }

  beforeEach(async () => {
    await startServer();
  });

  afterEach(async () => {
    await server.close();
    AndroidCtrlProxyClient.getInstance = originalGetInstance;
    PlatformDeviceManagerFactory.setInstance(null);
    if (existsSync(socketPath)) {
      await unlink(socketPath);
    }
  });

  test.each([
    ["ide/setKeyValue", { deviceId: device.deviceId, appId: "com.example", fileName: "prefs", key: "name", value: "value", type: "STRING" }],
    ["ide/removeKeyValue", { deviceId: device.deviceId, appId: "com.example", fileName: "prefs", key: "name" }],
    ["ide/clearKeyValueFile", { deviceId: device.deviceId, appId: "com.example", fileName: "prefs" }],
  ])("denies %s when app-data interop is disabled", async (method, params) => {
    const response = await sendRequest(socketPath, method, params);

    expect(response.success).toBe(false);
    expect(response.error).toContain("requires the 'app-data-interop' capability");
    expect(isEnabled).toHaveBeenCalledWith("device-session-1", "app-data-interop");
    expect(getInstanceCalls).toBe(0);
  });

  test("retains local app-data operations for an enabled session", async () => {
    isEnabled.mockImplementation(async () => true);

    const response = await sendRequest(socketPath, "ide/setKeyValue", {
      deviceId: device.deviceId,
      appId: "com.example",
      fileName: "prefs",
      key: "name",
      value: "value",
      type: "STRING",
    });

    expect(response.success).toBe(true);
    expect(getInstanceCalls).toBe(1);
  });

  test("uses the base profile for a labeled device session", async () => {
    await server.close();
    await startServer({ useLabeledSession: true });

    const response = await sendRequest(socketPath, "ide/setKeyValue", {
      deviceId: device.deviceId,
      appId: "com.example",
      fileName: "prefs",
      key: "name",
      value: "value",
      type: "STRING",
    });

    expect(response.success).toBe(false);
    expect(response.error).toContain("requires the 'app-data-interop' capability");
    expect(isEnabled).toHaveBeenCalledWith("device-session-1", "app-data-interop");
    expect(getInstanceCalls).toBe(0);
  });
});
