import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import { sendSocketRequest } from "./helpers/socketRequest";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import { IOSCtrlProxyClient } from "../../src/features/observe/ios";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeTimer } from "../fakes/FakeTimer";
import type { SessionToolSelectionService } from "../../src/features/toolSelection/SessionToolSelectionService";
import type { DaemonResponse } from "../../src/daemon/types";
import type { BootedDevice } from "../../src/models";

/**
 * Key-value mutation routing across platforms (issue #4708). The desktop Storage
 * facet edits key-value entries through the daemon's `ide/*` socket methods. iOS
 * panes must route to the iOS device + IOSCtrlProxyClient; before #4708 the
 * handlers hardcoded Android discovery + AndroidCtrlProxyClient, so an iOS edit
 * failed with the iOS device reported "not found".
 */

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

function createDaemonState() {
  return {
    isInitialized: () => true,
    getSessionManager: () => ({
      getSession: () => null,
      getSessionForDevice: () => null,
      getDeviceLabels: () => undefined,
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

describe("UnixSocketServer key-value mutation platform routing (#4708)", () => {
  let socketPath: string;
  let server: UnixSocketServer;
  let originalAndroidGetInstance: typeof AndroidCtrlProxyClient.getInstance;
  let originalIosGetInstance: typeof IOSCtrlProxyClient.getInstance;
  let androidSetPreference: ReturnType<typeof mock>;
  let androidRemovePreference: ReturnType<typeof mock>;
  let androidClearPreferenceStore: ReturnType<typeof mock>;
  let iosSetPreference: ReturnType<typeof mock>;
  let iosRemovePreference: ReturnType<typeof mock>;
  let iosClearPreferenceStore: ReturnType<typeof mock>;

  beforeEach(async () => {
    socketPath = join(tmpdir(), `kv-routing-${randomUUID()}.sock`);

    // Only the two platform-specific booted devices exist; discovery is scoped
    // by the platform the handler asks for.
    PlatformDeviceManagerFactory.setInstance({
      getBootedDevices: async (platform: "android" | "ios" | "either") =>
        platform === "ios"
          ? [iosDevice]
          : platform === "android"
            ? [androidDevice]
            : [androidDevice, iosDevice],
    } as unknown as ReturnType<typeof PlatformDeviceManagerFactory.getInstance>);

    androidSetPreference = mock(async () => {});
    androidRemovePreference = mock(async () => {});
    androidClearPreferenceStore = mock(async () => {});
    iosSetPreference = mock(async () => {});
    iosRemovePreference = mock(async () => {});
    iosClearPreferenceStore = mock(async () => {});

    originalAndroidGetInstance = AndroidCtrlProxyClient.getInstance;
    originalIosGetInstance = IOSCtrlProxyClient.getInstance;
    AndroidCtrlProxyClient.getInstance = mock(() => ({
      setPreference: androidSetPreference,
      removePreference: androidRemovePreference,
      clearPreferenceStore: androidClearPreferenceStore,
    })) as unknown as typeof AndroidCtrlProxyClient.getInstance;
    IOSCtrlProxyClient.getInstance = mock(() => ({
      setPreference: iosSetPreference,
      removePreference: iosRemovePreference,
      clearPreferenceStore: iosClearPreferenceStore,
    })) as unknown as typeof IOSCtrlProxyClient.getInstance;

    const profileService: Pick<SessionToolSelectionService, "isEnabled" | "setEnabled"> = {
      isEnabled: async () => true,
      setEnabled: async () => {},
    };

    server = new UnixSocketServer(
      socketPath,
      "http://localhost:0/mcp",
      createDaemonState(),
      new FakeTimer(),
      null,
      { sessionToolSelectionService: profileService },
    );
    await server.start();
  });

  afterEach(async () => {
    await server.close();
    AndroidCtrlProxyClient.getInstance = originalAndroidGetInstance;
    IOSCtrlProxyClient.getInstance = originalIosGetInstance;
    PlatformDeviceManagerFactory.setInstance(null);
    if (existsSync(socketPath)) {
      await unlink(socketPath);
    }
  });

  test("ide/setKeyValue with platform 'ios' targets the iOS device via IOSCtrlProxyClient", async () => {
    const response = await sendRequest(socketPath, "ide/setKeyValue", {
      platform: "ios",
      deviceId: iosDevice.deviceId,
      appId: "com.example.app",
      fileName: "prefs",
      key: "theme",
      value: "dark",
      type: "STRING",
    });

    expect(response.success).toBe(true);
    expect(iosSetPreference).toHaveBeenCalledWith(
      "com.example.app",
      "prefs",
      "theme",
      "dark",
      "STRING",
    );
    expect(androidSetPreference).not.toHaveBeenCalled();
  });

  test("ide/setKeyValue with a null value routes to removePreference on iOS", async () => {
    const response = await sendRequest(socketPath, "ide/setKeyValue", {
      platform: "ios",
      deviceId: iosDevice.deviceId,
      appId: "com.example.app",
      fileName: "prefs",
      key: "theme",
      value: null,
      type: "STRING",
    });

    expect(response.success).toBe(true);
    expect(iosRemovePreference).toHaveBeenCalledWith("com.example.app", "prefs", "theme");
    expect(iosSetPreference).not.toHaveBeenCalled();
  });

  test("ide/removeKeyValue with platform 'ios' targets the iOS device", async () => {
    const response = await sendRequest(socketPath, "ide/removeKeyValue", {
      platform: "ios",
      deviceId: iosDevice.deviceId,
      appId: "com.example.app",
      fileName: "prefs",
      key: "theme",
    });

    expect(response.success).toBe(true);
    expect(iosRemovePreference).toHaveBeenCalledWith("com.example.app", "prefs", "theme");
    expect(androidRemovePreference).not.toHaveBeenCalled();
  });

  test("ide/clearKeyValueFile with platform 'ios' targets the iOS device", async () => {
    const response = await sendRequest(socketPath, "ide/clearKeyValueFile", {
      platform: "ios",
      deviceId: iosDevice.deviceId,
      appId: "com.example.app",
      fileName: "prefs",
    });

    expect(response.success).toBe(true);
    expect(iosClearPreferenceStore).toHaveBeenCalledWith("com.example.app", "prefs");
    expect(androidClearPreferenceStore).not.toHaveBeenCalled();
  });

  test("ide/setKeyValue still routes to Android when platform is omitted (back-compat default)", async () => {
    const response = await sendRequest(socketPath, "ide/setKeyValue", {
      deviceId: androidDevice.deviceId,
      appId: "com.example.app",
      fileName: "prefs",
      key: "theme",
      value: "dark",
      type: "STRING",
    });

    expect(response.success).toBe(true);
    expect(androidSetPreference).toHaveBeenCalledWith(
      "com.example.app",
      "prefs",
      "theme",
      "dark",
      "STRING",
    );
    expect(iosSetPreference).not.toHaveBeenCalled();
  });

  test("ide/setKeyValue rejects an unknown platform", async () => {
    const response = await sendRequest(socketPath, "ide/setKeyValue", {
      platform: "windows",
      deviceId: iosDevice.deviceId,
      appId: "com.example.app",
      fileName: "prefs",
      key: "theme",
      value: "dark",
      type: "STRING",
    });

    expect(response.success).toBe(false);
    expect(response.error).toContain("Invalid platform");
  });

  // Cross-platform type guidance now enforced on the socket path, matching the
  // MCP-tool path (issue #5022). Previously an incompatible type reached the
  // CtrlProxy client and failed deeper with a less actionable message.

  test("ide/setKeyValue rejects an Android-only type on an iOS device with actionable guidance", async () => {
    const response = await sendRequest(socketPath, "ide/setKeyValue", {
      platform: "ios",
      deviceId: iosDevice.deviceId,
      appId: "com.example.app",
      fileName: "prefs",
      key: "tags",
      value: "a,b",
      type: "STRING_SET",
    });

    expect(response.success).toBe(false);
    expect(response.error).toContain("STRING_SET is Android-only");
    expect(iosSetPreference).not.toHaveBeenCalled();
  });

  test("ide/setKeyValue rejects an iOS-only type on an Android device with actionable guidance", async () => {
    const response = await sendRequest(socketPath, "ide/setKeyValue", {
      deviceId: androidDevice.deviceId,
      appId: "com.example.app",
      fileName: "prefs",
      key: "ratio",
      value: "1.5",
      type: "DOUBLE",
    });

    expect(response.success).toBe(false);
    expect(response.error).toContain("DOUBLE is iOS-only");
    expect(androidSetPreference).not.toHaveBeenCalled();
  });

  test("ide/setKeyValue with a null value skips type validation and removes on iOS", async () => {
    // A null value is a remove, which the MCP path never type-validates; an
    // Android-only type must not block a cross-platform clear.
    const response = await sendRequest(socketPath, "ide/setKeyValue", {
      platform: "ios",
      deviceId: iosDevice.deviceId,
      appId: "com.example.app",
      fileName: "prefs",
      key: "tags",
      value: null,
      type: "STRING_SET",
    });

    expect(response.success).toBe(true);
    expect(iosRemovePreference).toHaveBeenCalledWith("com.example.app", "prefs", "tags");
    expect(iosSetPreference).not.toHaveBeenCalled();
  });
});
