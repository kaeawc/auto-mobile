import { expect, spyOn, test } from "bun:test";
import {
  getDeviceToolsDependencies,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import {
  type AppResourceDependencies,
  invalidateInstalledAppsCache,
} from "../../src/server/appResources";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { ListInstalledApps } from "../../src/features/observe/ListInstalledApps";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";

for (const path of ["notifyResourcesChanged", "syncInstalledAppResourceRegistry"] as const) {
  test(`${path} retains lazily injected app resource dependencies`, async () => {
    const device = { deviceId: `injected-${path}`, name: "fake", platform: "android" as const };
    const manager = new FakeDeviceUtils();
    manager.setBootedDevices("android", [device]);
    PlatformDeviceManagerFactory.setInstance(manager);
    const result = { apps: { profiles: {}, system: [] }, successful: true };
    // Guard the default implementation too: a regression must never reach adb.
    const fallback = spyOn(ListInstalledApps.prototype, "executeDetailedResult").mockResolvedValue(
      result,
    );
    let calls = 0;
    const appResourceDependencies: AppResourceDependencies = {
      listInstalledAppsFactory: () => {
        calls++;
        return {
          executeDetailedResult: async () => result,
          executeIosDetailedResult: async () => ({ apps: [], successful: true }),
        };
      },
    };
    resetDeviceToolsDependencies();
    const callback = getDeviceToolsDependencies()[path];
    try {
      setDeviceToolsDependencies({ appResourceDependencies });
      // An unrelated override must preserve the injected dependency.
      setDeviceToolsDependencies({});
      await callback();
      const resource = ResourceRegistry.getResource(`automobile:devices/${device.deviceId}/apps`);
      expect(resource).toBeDefined();
      await resource!.handler();
      expect(calls).toBe(1);
      expect(fallback).not.toHaveBeenCalled();
    } finally {
      fallback.mockRestore();
      invalidateInstalledAppsCache(device.deviceId);
      resetDeviceToolsDependencies();
      PlatformDeviceManagerFactory.setInstance(null);
    }
  });
}
