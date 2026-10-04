import { describe, expect, mock, test } from "bun:test";
import type { AppearanceConfig, AppearanceMode, BootedDevice } from "../../src/models";
import { DeviceSessionManager } from "../../src/devices/DeviceSessionManager";
import { applyAppearanceOnConnect } from "../../src/server/applyAppearanceOnConnect";
import { isAppearanceSyncEnabled } from "../../src/utils/appearance/appearanceSyncPolicy";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeDeviceClientProvider } from "../fakes/FakeDeviceClientProvider";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeSimctl } from "../fakes/FakeSimctl";
import { FakeSimCtlClient } from "../fakes/FakeSimCtlClient";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeWindow } from "../fakes/FakeWindow";
import { FakeVirtualDeviceLifecycleCoordinator } from "../fakes/FakeVirtualDeviceLifecycleCoordinator";
import type { SimCtlClient } from "../../src/utils/ios-cmdline-tools/SimCtlClient";

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
  const appearanceSimctl = new FakeSimCtlClient();
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
    new FakeDeviceClientProvider(adb, devices, simctl as unknown as SimCtlClient, { window }),
    { create: () => adb },
    {
      appearanceOnConnectDependencies: dependencies,
      runnerReadinessTimer: new FakeTimer(),
      lifecycleCoordinator: new FakeVirtualDeviceLifecycleCoordinator(),
      admissionGate: { assertDeviceActionable: () => {} },
      executionBinding: { bindDeviceExecution: () => {} },
    },
  );
  return { device, manager, adb, appearanceSimctl, dependencies };
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
