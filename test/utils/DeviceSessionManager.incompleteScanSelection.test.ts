import { describe, expect, test } from "bun:test";
import { DeviceSessionManager } from "../../src/devices/DeviceSessionManager";
import {
  AndroidBootedDeviceDiscoveryIncompleteError,
  BootedDeviceDiscoveryIncompleteError,
} from "../../src/devices/deviceBootService";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeDeviceClientProvider } from "../fakes/FakeDeviceClientProvider";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeSimctl } from "../fakes/FakeSimctl";

// #11103: one adb/simctl listing failure must not read as "nothing is booted"
// and start a fresh AVD / boot another simulator beside the attached device.

describe("DeviceSessionManager selection on an incomplete booted-device scan", () => {
  test("refuses to cold-boot an AVD when the Android listing is incomplete", async () => {
    const deviceUtils = new FakeDeviceUtils();
    deviceUtils.setBootedDevices("android", [
      { deviceId: "emulator-5554", name: "Pixel", platform: "android" },
    ]);
    deviceUtils.setDeviceImages("android", [
      { name: "Pixel_9_Pro", platform: "android", isRunning: false },
    ]);
    deviceUtils.setAndroidDiscoveryIncomplete("adb devices timed out");
    const manager = DeviceSessionManager.createInstance(
      new FakeDeviceClientProvider(new FakeAdbExecutor(), deviceUtils, new FakeSimctl() as never),
    );

    const error = await manager.findOrStartAndroidDevice().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AndroidBootedDeviceDiscoveryIncompleteError);
    expect((error as AndroidBootedDeviceDiscoveryIncompleteError).code).toBe(
      "discovery_incomplete",
    );
    expect((error as AndroidBootedDeviceDiscoveryIncompleteError).retryable).toBe(true);
    expect(deviceUtils.wasMethodCalled("startDevice")).toBe(false);
  });

  test("refuses to boot another simulator when the simctl booted listing fails", async () => {
    const simctl = new FakeSimctl();
    simctl.setAvailableSimulators([
      {
        name: "iPhone A",
        platform: "ios",
        deviceId: "AAAA",
        isRunning: false,
        isAvailable: true,
        state: "Shutdown",
      },
    ]);
    simctl.setBootedSimulators([{ deviceId: "BBBB", name: "iPhone B", platform: "ios" }]);
    simctl.setBootedSimulatorsError(new Error("simctl list timed out"));
    const manager = DeviceSessionManager.createInstance(
      new FakeDeviceClientProvider(new FakeAdbExecutor(), new FakeDeviceUtils(), simctl as never),
    );

    const error = await manager.findOrStartIosDevice().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BootedDeviceDiscoveryIncompleteError);
    expect((error as BootedDeviceDiscoveryIncompleteError).platform).toBe("ios");
    expect((error as BootedDeviceDiscoveryIncompleteError).retryable).toBe(true);
    expect((error as Error).message).toContain("simctl list timed out");
    expect(simctl.wasMethodCalled("bootSimulator")).toBe(false);
  });
});
