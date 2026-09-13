import { describe, expect, test } from "bun:test";
import {
  DefaultDeviceIncarnationInvalidator,
  type CtrlProxyClientLifecycle,
} from "../../src/server/DeviceIncarnationInvalidator";
import type { DeviceWindowCacheInvalidator } from "../../src/features/action/TerminateApp";
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
  test("clears window state, closes and evicts CtrlProxy, and marks installed apps stale", async () => {
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
    const calls: string[] = [];
    const markDeviceStale = installedApps.markDeviceStale.bind(installedApps);
    installedApps.markDeviceStale = async (deviceId) => {
      calls.push(`db:${deviceId}`);
      await markDeviceStale(deviceId);
    };
    const ctrlProxyLifecycle: CtrlProxyClientLifecycle = {
      closeAndRemove: async (deviceId) => {
        calls.push(`ctrlproxy:${deviceId}`);
      },
    };
    const invalidator = new DefaultDeviceIncarnationInvalidator(
      windowCacheInvalidator,
      installedApps,
      new PerDeviceInstalledAppsCacheWriteCoordinator(() => barrier),
      barrier,
      (deviceId) => {
        calls.push(`resource-cache:${deviceId}`);
      },
      ctrlProxyLifecycle,
    );

    await invalidator.invalidate(ANDROID_DEVICE);

    expect(windowInvalidations).toBe(1);
    expect(calls).toEqual([
      `ctrlproxy:${ANDROID_DEVICE.deviceId}`,
      `db:${ANDROID_DEVICE.deviceId}`,
      `resource-cache:${ANDROID_DEVICE.deviceId}`,
    ]);
    expect(barrier.trackCalls).toBe(1);
    expect(await installedApps.getCacheVerifiedAt(ANDROID_DEVICE.deviceId)).toBe(0);
  });
});
