import { describe, expect, test, spyOn } from "bun:test";
import { DefaultDeviceIncarnationInvalidator } from "../../src/server/DeviceIncarnationInvalidator";
import type { DeviceWindowCacheInvalidator } from "../../src/features/action/TerminateApp";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android/AndroidCtrlProxyClient";
import { PerDeviceInstalledAppsCacheWriteCoordinator } from "../../src/db/installedAppsCacheWriteCoordinator";
import type { BootedDevice } from "../../src/models";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";

const ANDROID_DEVICE: BootedDevice = {
  deviceId: "emulator-5554",
  name: "Pixel_9_Pro",
  platform: "android",
};

describe("DefaultDeviceIncarnationInvalidator", () => {
  test("clears window state, evicts CtrlProxy, and marks installed apps stale", async () => {
    let windowInvalidations = 0;
    const windowCacheInvalidator: DeviceWindowCacheInvalidator = {
      invalidate: () => {
        windowInvalidations += 1;
      },
    };
    const installedApps = new FakeInstalledAppsRepository();
    await installedApps.upsertInstalledApp(
      ANDROID_DEVICE.deviceId,
      0,
      "com.example.app",
      false,
      123,
    );
    const barrier = new FakeDbWriteBarrier();
    const removeInstance = spyOn(AndroidCtrlProxyClient, "removeInstance");
    const invalidator = new DefaultDeviceIncarnationInvalidator(
      windowCacheInvalidator,
      installedApps,
      new PerDeviceInstalledAppsCacheWriteCoordinator(() => barrier),
      barrier,
    );

    try {
      await invalidator.invalidate(ANDROID_DEVICE);

      expect(windowInvalidations).toBe(1);
      expect(removeInstance).toHaveBeenCalledWith(ANDROID_DEVICE.deviceId);
      expect(barrier.trackCalls).toBe(1);
      expect(await installedApps.getLatestVerification(ANDROID_DEVICE.deviceId)).toBe(0);
    } finally {
      removeInstance.mockRestore();
    }
  });
});
