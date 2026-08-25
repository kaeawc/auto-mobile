import { describe, expect, test } from "bun:test";
import { MultiPlatformDeviceManager } from "../../src/utils/deviceUtils";
import { ListInstalledApps } from "../../src/features/observe/ListInstalledApps";
import type { BootedDevice } from "../../src/models";
import type { SimCtlClient } from "../../src/utils/ios-cmdline-tools/SimCtlClient";
import type { AndroidEmulatorClient } from "../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeSimctl } from "../fakes/FakeSimctl";
import { FakeTimer } from "../fakes/FakeTimer";

const PHYSICAL_UDID = "00008130-000A1B2C3D4E5F60";

/**
 * Issue #5620: the app resources resolve a deviceId through
 * `PlatformDeviceManager.getBootedDevices("ios")` before constructing
 * `ListInstalledApps`. This pins the whole chain — a connected physical UDID
 * must survive resolution and land on the devicectl listing path — with fakes
 * only, so it holds on hosts with no iOS tooling at all.
 */
describe("physical iOS device resolution reaches ListInstalledApps", () => {
  test("a physical UDID resolves to an iOS BootedDevice that lists apps via devicectl", async () => {
    const physical: BootedDevice = {
      name: "Jason's iPhone",
      platform: "ios",
      deviceId: PHYSICAL_UDID,
      iosVersion: "18.6",
      osVersion: "18.6",
      formFactor: "phone",
    };
    const manager = new MultiPlatformDeviceManager(
      null,
      {
        isAvailable: async () => true,
        getBootedSimulators: async () => [],
      } as unknown as SimCtlClient,
      { getBootedDevices: async () => [] } as unknown as AndroidEmulatorClient,
      undefined,
      undefined,
      { listConnectedDevices: async () => ({ devices: [physical], complete: true }) },
    );

    // Exactly the lookup src/server/appResources.ts performs.
    const booted = await manager.getBootedDevices("ios");
    const resolved = booted.find((device) => device.deviceId === PHYSICAL_UDID);

    expect(resolved).toBeDefined();
    expect(resolved!.platform).toBe("ios");

    const devicectlUdids: string[] = [];
    const simctl = new FakeSimctl();
    simctl.setInstalledApps([{ bundleId: "com.example.simulator-only" }]);
    const list = new ListInstalledApps(
      resolved!,
      new FakeAdbClientFactory(new FakeAdbExecutor()),
      simctl,
      {
        cacheEnabled: false,
        installedAppsRepository: new FakeInstalledAppsRepository(),
        timer: new FakeTimer(),
        iosPhysicalAppLister: {
          listInstalledApps: async (udid: string) => {
            devicectlUdids.push(udid);
            return [{ bundleIdentifier: "com.example.onhardware" }];
          },
        },
      },
    );

    await expect(list.execute()).resolves.toEqual(["com.example.onhardware"]);
    expect(devicectlUdids).toEqual([PHYSICAL_UDID]);
  });
});
