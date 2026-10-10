import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { UnixSocketServer } from "../../src/daemon/socketServer";
import { sendSocketRequest } from "./helpers/socketRequest";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import { IOSCtrlProxyClient } from "../../src/features/observe/ios";
import { AndroidCtrlProxyManager } from "../../src/ctrlProxy/CtrlProxyManager";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import type { AdbClientFactory } from "../../src/utils/android-cmdline-tools/AdbClientFactory";
import { createExecResult } from "../../src/utils/execResult";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
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

/** The session holding each device, or none; mutated by the held-device tests (#10827). */
const deviceHolders = new Map<string, string>();

function createDaemonState() {
  return {
    isInitialized: () => true,
    getSessionManager: () => ({
      getSession: () => null,
      getSessionForDevice: (deviceId: string) => deviceHolders.get(deviceId) ?? null,
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
  let adbClientFactory: AdbClientFactory;
  let androidSetPreference: ReturnType<typeof mock>;
  let androidRemovePreference: ReturnType<typeof mock>;
  let androidClearPreferenceStore: ReturnType<typeof mock>;
  let iosSetPreference: ReturnType<typeof mock>;
  let iosRemovePreference: ReturnType<typeof mock>;
  let iosClearPreferenceStore: ReturnType<typeof mock>;
  let simctlSweepFails = false;

  beforeEach(async () => {
    simctlSweepFails = false;
    socketPath = join(tmpdir(), `kv-routing-${randomUUID()}.sock`);

    // Only the two platform-specific booted devices exist; discovery is scoped
    // by the platform the handler asks for.
    PlatformDeviceManagerFactory.setInstance({
      getBootedDevicesDetailed: async () => ({
        devices: simctlSweepFails ? [] : [iosDevice],
        succeededPlatforms: new Set(simctlSweepFails ? [] : ["ios"]),
        discoveryErrors: simctlSweepFails
          ? { ios: { code: "failed", message: "simctl exploded" } }
          : {},
      }),
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
    adbClientFactory = {
      create: () => {
        throw new Error("Unexpected ADB access");
      },
    };
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
      undefined,
      {},
      adbClientFactory,
    );
    await server.start();
  });

  afterEach(async () => {
    deviceHolders.clear();
    await server.close();
    AndroidCtrlProxyClient.getInstance = originalAndroidGetInstance;
    IOSCtrlProxyClient.getInstance = originalIosGetInstance;
    PlatformDeviceManagerFactory.setInstance(null);
    if (existsSync(socketPath)) {
      await unlink(socketPath);
    }
  });

  test("iOS IDE mutations preserve resolved stores and set override warnings", async () => {
    const resolution = { resolvedStore: "custom-suite", effectiveValueDiffers: true };
    iosSetPreference.mockImplementation(async () => resolution);
    iosRemovePreference.mockImplementation(async () => resolution);
    iosClearPreferenceStore.mockImplementation(async () => resolution);
    const params = {
      platform: "ios",
      deviceId: iosDevice.deviceId,
      appId: "com.example.app",
      fileName: "prefs",
      key: "theme",
      value: "dark",
      type: "STRING",
    };
    const set = await sendRequest(socketPath, "ide/setKeyValue", params);
    const remove = await sendRequest(socketPath, "ide/removeKeyValue", params);
    const clear = await sendRequest(socketPath, "ide/clearKeyValueFile", params);
    expect(set.success).toBe(true);
    expect(set.result).toMatchObject({ success: true, ...resolution });
    expect(set.result).toHaveProperty(
      "warning",
      expect.stringContaining("effective value read by the app differs"),
    );
    expect(remove.success).toBe(true);
    expect(remove.result).toEqual({ success: true, resolvedStore: "custom-suite" });
    expect(clear.success).toBe(true);
    expect(clear.result).toEqual({ success: true, resolvedStore: "custom-suite" });
  });

  test("ide/setKeyValue on iOS reports incomplete discovery, not 'Device not found', when simctl fails (#11122)", async () => {
    simctlSweepFails = true;
    const response = await sendRequest(socketPath, "ide/setKeyValue", {
      platform: "ios",
      deviceId: iosDevice.deviceId,
      appId: "com.example.app",
      fileName: "prefs",
      key: "theme",
      value: "dark",
      type: "STRING",
    });

    expect(response.success).toBe(false);
    expect(response.error).toContain("discovery_incomplete");
    expect(response.error).not.toContain("Device not found");
    expect(iosSetPreference).not.toHaveBeenCalled();
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

  // Issue #6292: the desktop Storage pane sends its mutations over these `ide/*` routes.
  // When the SDK ContentProvider path is gated because SharedPreferences inspection is
  // disabled on the app, the Android routes must fall back to the same direct-file
  // `adb shell run-as` XML edit the MCP tools use — otherwise the pane can read but not
  // write/delete/clear. iOS has no on-device XML fallback and must never attempt one.
  describe("held-device ownership on mutating ide/* routes (#10827)", () => {
    const kvParams = {
      deviceId: androidDevice.deviceId,
      appId: "com.example.app",
      fileName: "prefs",
      key: "theme",
      value: "dark",
      type: "STRING",
    };
    const kvRoutes = ["ide/setKeyValue", "ide/removeKeyValue", "ide/clearKeyValueFile"];

    test("the holder's edit passes", async () => {
      deviceHolders.set(androidDevice.deviceId, "agent-session");
      const response = await sendRequest(socketPath, "ide/setKeyValue", {
        ...kvParams,
        sessionUuid: "agent-session",
      });
      expect(response.success).toBe(true);
      expect(androidSetPreference).toHaveBeenCalledTimes(1);
    });

    for (const route of kvRoutes) {
      test(`${route} from a foreign or sessionless client is refused with the typed code`, async () => {
        deviceHolders.set(androidDevice.deviceId, "agent-session");
        const foreign = await sendRequest(socketPath, route, {
          ...kvParams,
          sessionUuid: "someone-else",
        });
        const sessionless = await sendRequest(socketPath, route, kvParams);
        for (const response of [foreign, sessionless]) {
          expect(response.success).toBe(false);
          expect((response as { code?: string }).code).toBe("device_owned_by_other_session");
        }
        expect(androidSetPreference).not.toHaveBeenCalled();
        expect(androidRemovePreference).not.toHaveBeenCalled();
        expect(androidClearPreferenceStore).not.toHaveBeenCalled();
      });
    }

    test("an unheld device still accepts a sessionless edit", async () => {
      const response = await sendRequest(socketPath, "ide/setKeyValue", kvParams);
      expect(response.success).toBe(true);
    });

    describe("ide/updateService", () => {
      let ensure: ReturnType<typeof mock>;
      let managerSpy: ReturnType<typeof spyOn>;

      beforeEach(() => {
        ensure = mock(async () => ({ status: "compatible" }));
        managerSpy = spyOn(AndroidCtrlProxyManager, "getInstance").mockReturnValue({
          ensureCompatibleVersion: ensure,
        } as never);
      });

      afterEach(() => {
        managerSpy.mockRestore();
      });

      const params = { deviceId: androidDevice.deviceId, platform: "android" };

      test("is refused for a non-owner and never reaches the manager", async () => {
        deviceHolders.set(androidDevice.deviceId, "agent-session");
        const response = await sendRequest(socketPath, "ide/updateService", {
          ...params,
          sessionUuid: "someone-else",
        });
        expect(response.success).toBe(false);
        expect((response as { code?: string }).code).toBe("device_owned_by_other_session");
        expect(ensure).not.toHaveBeenCalled();
      });

      test("is allowed for the holder and with force", async () => {
        deviceHolders.set(androidDevice.deviceId, "agent-session");
        const holder = await sendRequest(socketPath, "ide/updateService", {
          ...params,
          sessionUuid: "agent-session",
        });
        const forced = await sendRequest(socketPath, "ide/updateService", {
          ...params,
          force: true,
        });
        expect(holder.success).toBe(true);
        expect(forced.success).toBe(true);
        expect(ensure).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe("SharedPreferences inspection-disabled fallback on the ide/* routes (#6292)", () => {
    const INSPECTION_DISABLED = "SharedPreferences inspection is disabled";

    function useAndroidClientThrowing(overrides: Partial<Record<string, () => Promise<void>>>) {
      AndroidCtrlProxyClient.getInstance = mock(() => ({
        setPreference:
          overrides.setPreference ??
          (async () => {
            throw new Error(INSPECTION_DISABLED);
          }),
        removePreference:
          overrides.removePreference ??
          (async () => {
            throw new Error(INSPECTION_DISABLED);
          }),
        clearPreferenceStore:
          overrides.clearPreferenceStore ??
          (async () => {
            throw new Error(INSPECTION_DISABLED);
          }),
      })) as unknown as typeof AndroidCtrlProxyClient.getInstance;
    }

    function injectFakeAdb(adb: FakeAdbExecutor): void {
      adbClientFactory.create = () => adb;
    }

    test("ide/setKeyValue falls back to the direct-file XML edit and warns to relaunch", async () => {
      useAndroidClientThrowing({});
      const adb = new FakeAdbExecutor();
      adb.setCommandResponse("cat shared_prefs/prefs.xml", createExecResult("<map/>", ""));
      injectFakeAdb(adb);

      const response = await sendRequest(socketPath, "ide/setKeyValue", {
        deviceId: androidDevice.deviceId,
        appId: "com.example.app",
        fileName: "prefs",
        key: "theme",
        value: "dark",
        type: "STRING",
      });

      expect(response.success).toBe(true);
      expect(response.result?.warning).toMatch(/relaunch/i);
      const writeCommand = adb
        .getExecutedCommands()
        .find((cmd) => cmd.includes("base64 -d > shared_prefs/prefs.xml"));
      expect(writeCommand).toBeDefined();
    });

    test("ide/removeKeyValue falls back to the direct-file XML edit when inspection is disabled", async () => {
      useAndroidClientThrowing({});
      const adb = new FakeAdbExecutor();
      adb.setCommandResponse(
        "cat shared_prefs/prefs.xml",
        createExecResult('<map><string name="theme">dark</string></map>', ""),
      );
      injectFakeAdb(adb);

      const response = await sendRequest(socketPath, "ide/removeKeyValue", {
        deviceId: androidDevice.deviceId,
        appId: "com.example.app",
        fileName: "prefs",
        key: "theme",
      });

      expect(response.success).toBe(true);
      expect(response.result?.warning).toMatch(/relaunch/i);
      const writeCommand = adb
        .getExecutedCommands()
        .find((cmd) => cmd.includes("base64 -d > shared_prefs/prefs.xml"));
      expect(writeCommand).toBeDefined();
    });

    test("ide/clearKeyValueFile falls back to the direct-file XML edit when inspection is disabled", async () => {
      useAndroidClientThrowing({});
      const adb = new FakeAdbExecutor();
      injectFakeAdb(adb);

      const response = await sendRequest(socketPath, "ide/clearKeyValueFile", {
        deviceId: androidDevice.deviceId,
        appId: "com.example.app",
        fileName: "prefs",
      });

      expect(response.success).toBe(true);
      expect(response.result?.warning).toMatch(/relaunch/i);
      const writeCommand = adb
        .getExecutedCommands()
        .find((cmd) => cmd.includes("base64 -d > shared_prefs/prefs.xml"));
      expect(writeCommand).toBeDefined();
    });

    test("a non-inspection SDK failure is surfaced and does NOT trigger the direct-file fallback", async () => {
      useAndroidClientThrowing({
        setPreference: async () => {
          throw new Error("WebSocket not connected");
        },
      });
      const adb = new FakeAdbExecutor();
      injectFakeAdb(adb);

      const response = await sendRequest(socketPath, "ide/setKeyValue", {
        deviceId: androidDevice.deviceId,
        appId: "com.example.app",
        fileName: "prefs",
        key: "theme",
        value: "dark",
        type: "STRING",
      });

      expect(response.success).toBe(false);
      expect(response.error).toContain("WebSocket not connected");
      expect(adb.getExecutedCommands()).toHaveLength(0);
    });

    test("iOS never attempts the Android direct-file fallback — an SDK error is surfaced", async () => {
      iosSetPreference.mockImplementation(async () => {
        throw new Error(INSPECTION_DISABLED);
      });
      const adb = new FakeAdbExecutor();
      injectFakeAdb(adb);

      const response = await sendRequest(socketPath, "ide/setKeyValue", {
        platform: "ios",
        deviceId: iosDevice.deviceId,
        appId: "com.example.app",
        fileName: "prefs",
        key: "theme",
        value: "dark",
        type: "STRING",
      });

      expect(response.success).toBe(false);
      // No adb command was executed: the iOS route has no direct-file fallback.
      expect(adb.getExecutedCommands()).toHaveLength(0);
    });
  });
});
