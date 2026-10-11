import { describe, expect, test } from "bun:test";
import {
  createTestRecordingDeviceResolution,
  TestRecordingSocketServer,
  type TestRecordingDeviceResolution,
} from "../../src/daemon/testRecordingSocketServer";
import type { TestRecordingCommand } from "../../src/daemon/testRecordingSocketTypes";
import { DeviceSessionManager } from "../../src/devices/DeviceSessionManager";
import {
  ActionableError,
  type AppearanceConfig,
  type AppearanceMode,
  type BootedDevice,
} from "../../src/models";
import type { SimCtlClient } from "../../src/utils/ios-cmdline-tools/SimCtlClient";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeDeviceClientProvider } from "../fakes/FakeDeviceClientProvider";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeSimctl } from "../fakes/FakeSimctl";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeVirtualDeviceLifecycleCoordinator } from "../fakes/FakeVirtualDeviceLifecycleCoordinator";
import { FakeWindow } from "../fakes/FakeWindow";

/**
 * A test-recording `start` readies its device for the session that asked (#11641). Readiness
 * writes the appearance to the device on connect, and that write follows the connecting session's
 * own config (#10976): a holder that chose `set_appearance light` (stored under its session with
 * syncWithHost false) keeps a light device when it starts a recording on a dark host. Without the
 * session, readiness read the global config, which follows the host.
 *
 * The production resolution runs here over a real DeviceSessionManager on fakes, so the assertion
 * is the device write itself.
 */
class TestableServer extends TestRecordingSocketServer {
  invoke(request: TestRecordingCommand) {
    return this.handleRequest(request);
  }
}

const HOLDER = "holder-session";
const held: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };
const GLOBAL_FOLLOWS_HOST: AppearanceConfig = {
  syncWithHost: true,
  defaultMode: "auto",
  applyOnConnect: true,
};
const HOLDER_CHOSE_LIGHT: AppearanceConfig = {
  syncWithHost: false,
  defaultMode: "light",
  applyOnConnect: true,
};

function harness() {
  const adb = new FakeAdbExecutor();
  adb.setDevices([held]);
  const deviceUtils = new FakeDeviceUtils();
  deviceUtils.setBootedDevices("android", [held]);
  const window = new FakeWindow();
  window.configureActiveWindow({ appId: "com.example", activityName: "Main", layoutSeqSum: 0 });
  const configKeys: Array<string | undefined> = [];
  const manager = DeviceSessionManager.createInstance(
    new FakeDeviceClientProvider(adb, deviceUtils, new FakeSimctl() as unknown as SimCtlClient, {
      window,
    }),
    { create: () => adb },
    {
      appearanceOnConnectDependencies: {
        isSyncEnabled: () => true,
        getConfig: async (sessionKey?: string) => {
          configKeys.push(sessionKey);
          return sessionKey === HOLDER ? HOLDER_CHOSE_LIGHT : GLOBAL_FOLLOWS_HOST;
        },
        // The host is dark; a config that does not follow it resolves to its own default.
        resolveMode: async (config): Promise<AppearanceMode> =>
          config?.syncWithHost || config?.defaultMode === "dark" ? "dark" : "light",
        apply: async (_target: BootedDevice, mode: AppearanceMode) => {
          await adb.executeCommand(`shell cmd uimode night ${mode === "dark" ? "yes" : "no"}`);
        },
      },
      runnerReadinessTimer: new FakeTimer(),
      lifecycleCoordinator: new FakeVirtualDeviceLifecycleCoordinator(),
      admissionGate: { assertDeviceActionable: () => {} },
      executionBinding: { bindDeviceExecution: () => {} },
    },
  );
  const production = createTestRecordingDeviceResolution(() => ({
    getPlatformDeviceManager: () => manager.getPlatformDeviceManager(),
    getCurrentDevice: () => manager.getCurrentDevice(),
    // Runner setup is not what this pins: readiness stops at "booted", then makes the same
    // selection and device writes.
    ensureDeviceReady: (platform, deviceId, options) =>
      manager.ensureDeviceReady(platform, deviceId, { ...options, readiness: "booted" }),
  }));
  const resolution: TestRecordingDeviceResolution = {
    selectDevice: async () => held,
    readyDevice: async (device, sessionUuid) => {
      await production.readyDevice(device, sessionUuid);
      // Stops before a real recorder is built on the readied device.
      throw new ActionableError("stop after readiness");
    },
  };
  const server = new TestableServer(
    undefined,
    undefined,
    { authorize: () => {} },
    { assertDeviceActionable: () => {} },
    resolution,
    async () => {},
  );
  const nightModeWrites = () =>
    adb.getExecutedCommands().filter((command) => command.includes("cmd uimode night"));
  return { server, configKeys, nightModeWrites };
}

describe("test-recording start readies the device for the session that asked", () => {
  test("a holder that chose light keeps a light device when it starts a recording on a dark host", async () => {
    const { server, configKeys, nightModeWrites } = harness();

    await expect(
      server.invoke({
        command: "start",
        sessionUuid: HOLDER,
        deviceId: held.deviceId,
        platform: "android",
      }),
    ).rejects.toThrow("stop after readiness");

    expect(configKeys).toEqual([HOLDER]);
    expect(nightModeWrites()).toEqual(["shell cmd uimode night no"]);
  });

  test("a start without a session still uses the global config", async () => {
    const { server, configKeys, nightModeWrites } = harness();

    await expect(
      server.invoke({ command: "start", deviceId: held.deviceId, platform: "android" }),
    ).rejects.toThrow("stop after readiness");

    expect(configKeys).toEqual([undefined]);
    expect(nightModeWrites()).toEqual(["shell cmd uimode night yes"]);
  });
});
