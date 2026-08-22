import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import { sendSocketRequest } from "./helpers/socketRequest";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeTimer } from "../fakes/FakeTimer";
import type { SessionToolSelectionService } from "../../src/features/toolSelection/SessionToolSelectionService";
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
      getSessionForDevice: (deviceId: string) =>
        deviceId === device.deviceId
          ? options?.useLabeledSession
            ? "device-session-1:B"
            : "device-session-1"
          : null,
      getDeviceLabels: (sessionId: string) =>
        sessionId === "device-session-1"
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

function sendRequest(
  socketPath: string,
  method: string,
  params: Record<string, unknown>,
): Promise<DaemonResponse> {
  return sendSocketRequest(socketPath, method, params);
}

describe("UnixSocketServer exact-tool selection enforcement", () => {
  let socketPath: string;
  let server: UnixSocketServer;
  let isEnabled: ReturnType<typeof mock>;
  let originalGetInstance: typeof AndroidCtrlProxyClient.getInstance;
  let getInstanceCalls: number;

  async function startServer(options?: { useLabeledSession?: boolean }): Promise<void> {
    socketPath = join(tmpdir(), `tool-capabilities-${randomUUID()}.sock`);
    isEnabled = mock(async () => false);
    const profileService: Pick<SessionToolSelectionService, "isEnabled" | "setEnabled"> = {
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
      { sessionToolSelectionService: profileService },
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
    [
      "ide/setKeyValue",
      "setKeyValue",
      {
        deviceId: device.deviceId,
        appId: "com.example",
        fileName: "prefs",
        key: "name",
        value: "value",
        type: "STRING",
      },
    ],
    [
      "ide/removeKeyValue",
      "removeKeyValue",
      { deviceId: device.deviceId, appId: "com.example", fileName: "prefs", key: "name" },
    ],
    [
      "ide/clearKeyValueFile",
      "clearKeyValueFile",
      { deviceId: device.deviceId, appId: "com.example", fileName: "prefs" },
    ],
  ])("denies %s when its exact tool is disabled", async (method, toolName, params) => {
    const response = await sendRequest(socketPath, method, params);

    expect(response.success).toBe(false);
    expect(response.error).toContain(`Tool ${toolName} is disabled`);
    expect(isEnabled).toHaveBeenCalledWith("device-session-1", toolName, false);
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

  test("denies a labeled device session when both base and derived narrow the tool away", async () => {
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
    expect(response.error).toContain("Tool setKeyValue is disabled");
    // UNION consults both the derived label session and its resolved base.
    expect(isEnabled).toHaveBeenCalledWith("device-session-1", "setKeyValue", false);
    expect(isEnabled).toHaveBeenCalledWith("device-session-1:B", "setKeyValue", false);
    expect(getInstanceCalls).toBe(0);
  });

  test("allows a labeled device session when the derived label re-enables the tool (Gap B union symmetry)", async () => {
    await server.close();
    await startServer({ useLabeledSession: true });
    // Base "device-session-1" narrows setKeyValue away; the derived
    // "device-session-1:B" label grants it. Union => allowed, matching the MCP
    // registerDeviceAware path.
    isEnabled.mockImplementation(
      async (sessionUuid: string | undefined) => sessionUuid === "device-session-1:B",
    );

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
});
