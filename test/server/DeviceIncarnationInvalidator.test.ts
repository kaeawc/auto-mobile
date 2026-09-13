import { describe, expect, spyOn, test } from "bun:test";
import {
  DefaultDeviceIncarnationInvalidator,
  type CtrlProxyClientLifecycle,
} from "../../src/server/DeviceIncarnationInvalidator";
import type { DeviceWindowCacheInvalidator } from "../../src/features/action/TerminateApp";
import { PerDeviceInstalledAppsCacheWriteCoordinator } from "../../src/db/installedAppsCacheWriteCoordinator";
import type { BootedDevice } from "../../src/models";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { logger } from "../../src/utils/logger";
import type { DeviceIncarnationListener } from "../../src/utils/deviceIncarnation";
import { createInstalledAppsDeviceIncarnationListener } from "../../src/server/appResources";

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
    const invalidator = new DefaultDeviceIncarnationInvalidator([
      {
        name: "observe-window-cache",
        onDeviceIncarnationChanged: () => windowCacheInvalidator.invalidate(ANDROID_DEVICE),
      },
      {
        name: "ctrlproxy-client",
        onDeviceIncarnationChanged: async (deviceId) =>
          await ctrlProxyLifecycle.closeAndRemove(deviceId),
      },
      {
        name: "installed-apps",
        onDeviceIncarnationChanged: async (deviceId) => {
          await new PerDeviceInstalledAppsCacheWriteCoordinator(() => barrier).invalidate(
            deviceId,
            async () => await barrier.track(() => installedApps.markDeviceStale(deviceId)),
          );
          calls.push(`resource-cache:${deviceId}`);
        },
      },
    ]);

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

  test("logs a rejected listener and completes the already-restored invalidation", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const installedApps = new FakeInstalledAppsRepository();
    installedApps.markDeviceStale = async () => {
      throw new Error("markDeviceStale rejected");
    };
    const barrier = new FakeDbWriteBarrier();
    const listeners: DeviceIncarnationListener[] = [
      createInstalledAppsDeviceIncarnationListener(
        installedApps,
        new PerDeviceInstalledAppsCacheWriteCoordinator(() => barrier),
        barrier,
        () => {},
      ),
    ];

    await expect(
      new DefaultDeviceIncarnationInvalidator(listeners).invalidate(ANDROID_DEVICE),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("installed-apps"), expect.any(Error));
    warn.mockRestore();
  });
});
