import { describe, expect, mock, test } from "bun:test";
import type { AppearanceConfig, AppearanceMode, BootedDevice } from "../../src/models";
import { DeviceSessionManager } from "../../src/devices/DeviceSessionManager";
import { applyAppearanceOnConnect } from "../../src/server/applyAppearanceOnConnect";
import { isAppearanceSyncEnabled } from "../../src/utils/appearance/appearanceSyncPolicy";
import { installDeviceSettingDefaults } from "../../src/features/utility/DeviceSettingDefaults";
import type { AndroidCtrlProxy } from "../../src/features/observe/android/AndroidCtrlProxyClient";
import { FakeCtrlProxyManager } from "../fakes/FakeCtrlProxyManager";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeDeviceClientProvider } from "../fakes/FakeDeviceClientProvider";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeSimctl } from "../fakes/FakeSimctl";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeWindow } from "../fakes/FakeWindow";
import { FakeVirtualDeviceLifecycleCoordinator } from "../fakes/FakeVirtualDeviceLifecycleCoordinator";

const config: AppearanceConfig = {
  syncWithHost: true,
  defaultMode: "auto",
  applyOnConnect: true,
};

function harness(
  platform: "android" | "ios",
  applyOnConnect = true,
  isSyncEnabled: () => boolean = () => true,
) {
  const device: BootedDevice = {
    deviceId: platform === "android" ? "emulator-5554" : "ios-sim-1",
    name: platform === "android" ? "Pixel" : "iPhone",
    platform,
  };
  const adb = new FakeAdbExecutor();
  const simctl = new FakeSimctl();
  const ctrlProxyManager = new FakeCtrlProxyManager();
  const ctrlProxyClient = {
    isConnected: () => false,
    waitForConnection: async () => true,
    verifyServiceReady: async () => true,
    resetConnectionBudget: () => {},
  } as unknown as AndroidCtrlProxy;
  const appearanceSimctl = new FakeSimctl();
  const devices = new FakeDeviceUtils();
  const window = new FakeWindow();
  window.configureActiveWindow({ appId: "com.example", activityName: "Main", layoutSeqSum: 0 });
  adb.setDevices(platform === "android" ? [device] : []);
  devices.setBootedDevices(platform, [device]);
  simctl.setBootedSimulators(platform === "ios" ? [device] : []);
  simctl.setAvailableSimulators([device]);
  simctl.setDeviceInfo(device.deviceId, {
    udid: device.deviceId,
    name: device.name,
    state: "Booted",
    isAvailable: true,
  });
  const getConfig = mock(async () => ({ ...config, applyOnConnect }));
  const resolveMode = mock(async (): Promise<AppearanceMode> => "dark");
  const apply = mock(async (target: BootedDevice, mode: AppearanceMode) => {
    if (target.platform === "android") {
      await adb.executeCommand(`shell cmd uimode night ${mode === "dark" ? "yes" : "no"}`);
    } else {
      await appearanceSimctl.executeCommandArgs(["ui", target.deviceId, "appearance", mode]);
    }
  });
  const dependencies = { isSyncEnabled, getConfig, resolveMode, apply };
  const manager = DeviceSessionManager.createInstance(
    new FakeDeviceClientProvider(adb, devices, simctl, {
      window,
      ctrlProxyManager,
      ctrlProxyClient,
    }),
    { create: () => adb },
    {
      appearanceOnConnectDependencies: dependencies,
      runnerReadinessTimer: new FakeTimer(),
      lifecycleCoordinator: new FakeVirtualDeviceLifecycleCoordinator(),
      admissionGate: { assertDeviceActionable: () => {} },
      executionBinding: { bindDeviceExecution: () => {} },
    },
  );
  return { device, manager, adb, appearanceSimctl, dependencies, window, ctrlProxyManager };
}

describe("appearance sync on device readiness", () => {
  for (const platform of ["android", "ios"] as const) {
    test.each(["off", "0", "false", "no", " OFF ", " FaLsE "])(
      `${platform}: sync=%s prevents writes on a sessionless first call and provided-device call`,
      async (value) => {
        const { device, manager, adb, appearanceSimctl, dependencies } = harness(
          platform,
          true,
          () => isAppearanceSyncEnabled(value),
        );
        expect(
          await manager.ensureDeviceReady(platform, undefined, { readiness: "booted" }),
        ).toEqual(device);
        // The provided-device path also applies on connect, even after selection.
        await manager.ensureDeviceReady(platform, device.deviceId, { readiness: "booted" });
        expect(dependencies.getConfig).not.toHaveBeenCalled();
        expect(dependencies.resolveMode).not.toHaveBeenCalled();
        expect(dependencies.apply).not.toHaveBeenCalled();
        expect(adb.getExecutedCommands().filter((command) => command.includes("uimode"))).toEqual(
          [],
        );
        expect(appearanceSimctl.getMethodCalls("executeCommandArgs")).toEqual([]);
      },
    );

    test.each([undefined, "on"])(
      `${platform}: sync=%s preserves apply-on-connect`,
      async (value) => {
        const { device, manager, adb, appearanceSimctl, dependencies } = harness(
          platform,
          true,
          () => isAppearanceSyncEnabled(value),
        );
        await manager.ensureDeviceReady(platform, undefined, { readiness: "booted" });
        expect(dependencies.apply).toHaveBeenCalledWith(device, "dark");
        if (platform === "android") {
          expect(adb.getExecutedCommands()).toContain("shell cmd uimode night yes");
        } else {
          expect(appearanceSimctl.getMethodCalls("executeCommandArgs")).toEqual([
            { args: ["ui", device.deviceId, "appearance", "dark"], timeoutMs: undefined },
          ]);
        }
        await manager.ensureDeviceReady(platform, undefined, { readiness: "booted" });
        expect(dependencies.apply).toHaveBeenCalledTimes(1);
      },
    );
  }

  test("applyOnConnect=false still prevents writes with sync enabled", async () => {
    const { manager, dependencies } = harness("android", false);
    await manager.ensureDeviceReady("android", undefined, { readiness: "booted" });
    expect(dependencies.apply).not.toHaveBeenCalled();
  });

  test("applyOnConnect reads the connecting session's own config only (#10976)", async () => {
    const { device, dependencies } = harness("android");
    const configs: Record<string, AppearanceConfig> = {
      "session-a": { syncWithHost: true, defaultMode: "dark", applyOnConnect: true },
      "session-b": { syncWithHost: true, defaultMode: "dark", applyOnConnect: false },
    };
    const getConfig = mock(async (sessionKey?: string) => configs[sessionKey ?? ""]!);

    expect(
      await applyAppearanceOnConnect(device, { ...dependencies, getConfig }, "session-b"),
    ).toBeNull();
    expect(getConfig).toHaveBeenCalledWith("session-b");
    expect(dependencies.apply).not.toHaveBeenCalled();

    expect(
      await applyAppearanceOnConnect(device, { ...dependencies, getConfig }, "session-a"),
    ).toBe("dark");
    expect(dependencies.apply).toHaveBeenCalledTimes(1);
  });

  test("an injected switch disables connect without changing process.env", async () => {
    const { device, dependencies } = harness("android");
    expect(
      await applyAppearanceOnConnect(device, { ...dependencies, isSyncEnabled: () => false }),
    ).toBeNull();
    expect(dependencies.getConfig).not.toHaveBeenCalled();
    expect(dependencies.apply).not.toHaveBeenCalled();
  });

  test("disabling sync while resolving host mode prevents the subsequent write", async () => {
    const { device, dependencies } = harness("android");
    let enabled = true;
    expect(
      await applyAppearanceOnConnect(device, {
        ...dependencies,
        isSyncEnabled: () => enabled,
        resolveMode: async () => {
          enabled = false;
          return "dark";
        },
      }),
    ).toBeNull();
    expect(dependencies.apply).not.toHaveBeenCalled();
  });
});

describe("readiness for a read", () => {
  for (const platform of ["android", "ios"] as const) {
    for (const provided of [true, false]) {
      test(`${platform}: a ${provided ? "provided" : "auto-selected"} read keeps required readiness without preference writes`, async () => {
        const { device, manager, adb, appearanceSimctl, dependencies, window } = harness(platform);
        const recordBeforeChange = mock(async () => {});
        installDeviceSettingDefaults({ recordBeforeChange });
        try {
          expect(
            await manager.ensureDeviceReady(platform, provided ? device.deviceId : undefined, {
              readiness: "booted",
              intent: "read",
            }),
          ).toEqual(device);
          expect(dependencies.getConfig).not.toHaveBeenCalled();
          expect(dependencies.resolveMode).not.toHaveBeenCalled();
          expect(dependencies.apply).not.toHaveBeenCalled();
          expect(
            adb
              .getExecutedCommands()
              .filter((command) => /cmd uimode night|settings put|settings delete/.test(command)),
          ).toEqual([]);
          expect(appearanceSimctl.getMethodCalls("executeCommandArgs")).toEqual([]);
          expect(recordBeforeChange).not.toHaveBeenCalled();
          expect(manager.getCurrentDevice()).toBeUndefined();
          expect(manager.getCurrentPlatform()).toBeUndefined();
          if (platform === "android") {
            expect(window.getGetActiveCallCount()).toBeGreaterThan(0);
          }
        } finally {
          installDeviceSettingDefaults(undefined);
        }
      });
    }

    test(`${platform}: a read leaves the holder's preference writes for its readiness`, async () => {
      const { device, manager, adb, dependencies } = harness(platform);
      await manager.ensureDeviceReady(platform, device.deviceId, {
        readiness: "booted",
        intent: "read",
      });
      await manager.ensureDeviceReady(platform, device.deviceId, {
        readiness: "booted",
        sessionId: "holder",
      });
      expect(dependencies.getConfig).toHaveBeenCalledTimes(1);
      expect(dependencies.getConfig).toHaveBeenCalledWith("holder");
      expect(dependencies.apply).toHaveBeenCalledTimes(1);
      expect(dependencies.apply).toHaveBeenCalledWith(device, "dark");
      expect(manager.getCurrentDevice()).toEqual(device);
      expect(manager.getCurrentPlatform()).toBe(platform);
      if (platform === "android") {
        expect(
          adb
            .getExecutedCommands()
            .filter(
              (command) => command === "shell settings put secure stylus_handwriting_enabled 0",
            ),
        ).toHaveLength(1);
      }
    });

    test(`${platform}: an auto-selected read leaves preference writes for auto-selected control`, async () => {
      const { device, manager, dependencies } = harness(platform);
      await manager.ensureDeviceReady(platform, undefined, { readiness: "booted", intent: "read" });
      await manager.ensureDeviceReady(platform, undefined, {
        readiness: "booted",
        intent: "control",
      });
      expect(dependencies.apply).toHaveBeenCalledTimes(1);
      expect(dependencies.apply).toHaveBeenCalledWith(device, "dark");
      expect(manager.getCurrentDevice()).toEqual(device);
    });

    test(`${platform}: reads after control preserve the current device without more writes`, async () => {
      const { device, manager, adb, appearanceSimctl, dependencies } = harness(platform);
      await manager.ensureDeviceReady(platform, undefined, { readiness: "booted" });
      const commands = adb
        .getExecutedCommands()
        .filter((command) => /cmd uimode night|settings put|settings delete/.test(command));
      const appearanceCalls = appearanceSimctl.getMethodCalls("executeCommandArgs");
      await manager.ensureDeviceReady(platform, device.deviceId, {
        readiness: "booted",
        intent: "read",
      });
      await manager.ensureDeviceReady(platform, undefined, { readiness: "booted", intent: "read" });
      expect(dependencies.getConfig).toHaveBeenCalledTimes(1);
      expect(dependencies.apply).toHaveBeenCalledTimes(1);
      expect(manager.getCurrentDevice()).toEqual(device);
      expect(manager.getCurrentPlatform()).toBe(platform);
      expect(
        adb
          .getExecutedCommands()
          .filter((command) => /cmd uimode night|settings put|settings delete/.test(command)),
      ).toEqual(commands);
      expect(appearanceSimctl.getMethodCalls("executeCommandArgs")).toEqual(appearanceCalls);
    });
  }

  test("android: a cold read sets up required CtrlProxy without preference writes or a pin", async () => {
    const { device, manager, adb, appearanceSimctl, dependencies, ctrlProxyManager } =
      harness("android");
    ctrlProxyManager.setInstalled(false);
    ctrlProxyManager.setEnabled(false);
    expect(await manager.ensureDeviceReady("android", device.deviceId, { intent: "read" })).toEqual(
      device,
    );
    expect(ctrlProxyManager.wasMethodCalled("setup")).toBe(true);
    expect(dependencies.getConfig).not.toHaveBeenCalled();
    expect(dependencies.apply).not.toHaveBeenCalled();
    expect(
      adb
        .getExecutedCommands()
        .filter((command) => /cmd uimode night|settings put|settings delete/.test(command)),
    ).toEqual([]);
    expect(appearanceSimctl.getMethodCalls("executeCommandArgs")).toEqual([]);
    expect(manager.getCurrentDevice()).toBeUndefined();
    expect(manager.getCurrentPlatform()).toBeUndefined();
  });
});
