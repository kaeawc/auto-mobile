import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  invalidateInstalledAppsCache,
  queryInstalledApps,
  setListInstalledAppsFactoryForTests,
} from "../../src/server/appResources";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import type { BootedDevice } from "../../src/models";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { getInstalledAppsCacheWriteCoordinator } from "../../src/db/installedAppsCacheWriteCoordinator";

const firstDevice: BootedDevice = {
  deviceId: "single-flight-device-1",
  name: "Pixel 8",
  platform: "android",
};
const secondDevice: BootedDevice = {
  deviceId: "single-flight-device-2",
  name: "Pixel 9",
  platform: "android",
};

function successfulAppsResult(packageName = "com.example.app") {
  return {
    apps: {
      profiles: {
        0: [
          {
            packageName,
            userId: 0,
            profileType: "primary" as const,
            foreground: false,
            recent: false,
            launchable: true,
          },
        ],
      },
      system: [],
    },
    successful: true,
  } as const;
}

describe("ensureAppsCacheEntry single-flight", () => {
  let fakeDeviceUtils: FakeDeviceUtils;

  beforeEach(() => {
    fakeDeviceUtils = new FakeDeviceUtils();
    fakeDeviceUtils.setBootedDevices("android", [firstDevice, secondDevice]);
    fakeDeviceUtils.setBootedDevices("ios", []);
    PlatformDeviceManagerFactory.setInstance(fakeDeviceUtils);
  });

  afterEach(() => {
    setListInstalledAppsFactoryForTests(null);
    PlatformDeviceManagerFactory.setInstance(null);
    invalidateInstalledAppsCache(firstDevice.deviceId);
    invalidateInstalledAppsCache(secondDevice.deviceId);
  });

  test("shares one fetch and returns the same cache snapshot to concurrent callers", async () => {
    const pending = Promise.withResolvers<ReturnType<typeof successfulAppsResult>>();
    const fetchStarted = Promise.withResolvers<void>();
    let fetches = 0;
    setListInstalledAppsFactoryForTests(() => ({
      executeDetailedResult: async () => {
        fetches += 1;
        fetchStarted.resolve();
        return await pending.promise;
      },
      executeIosDetailedResult: async () => {
        throw new Error("not exercised on android");
      },
    }));

    const first = queryInstalledApps({ deviceId: firstDevice.deviceId });
    const second = queryInstalledApps({ deviceId: firstDevice.deviceId });
    await fetchStarted.promise;
    expect(fetches).toBe(1);

    pending.resolve(successfulAppsResult());
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.devices[0].lastUpdated).toBe(secondResult.devices[0].lastUpdated);
    expect(firstResult.devices[0].apps).toEqual(secondResult.devices[0].apps);
  });

  test("shares a rejected fetch and retries on the next call", async () => {
    const pending = Promise.withResolvers<ReturnType<typeof successfulAppsResult>>();
    const fetchStarted = Promise.withResolvers<void>();
    const failure = new Error("listing failed");
    let fetches = 0;
    setListInstalledAppsFactoryForTests(() => ({
      executeDetailedResult: async () => {
        fetches += 1;
        if (fetches === 1) {
          fetchStarted.resolve();
          return await pending.promise;
        }
        return successfulAppsResult();
      },
      executeIosDetailedResult: async () => {
        throw new Error("not exercised on android");
      },
    }));

    const first = queryInstalledApps({ deviceId: firstDevice.deviceId });
    const second = queryInstalledApps({ deviceId: firstDevice.deviceId });
    await fetchStarted.promise;
    pending.reject(failure);
    await expect(Promise.all([first, second])).rejects.toBe(failure);
    expect(fetches).toBe(1);

    const retry = await queryInstalledApps({ deviceId: firstDevice.deviceId });
    expect(retry.devices[0].apps).toHaveLength(1);
    expect(fetches).toBe(2);
  });

  test("does not share fetches across different devices", async () => {
    const started = new Set<string>();
    const bothStarted = Promise.withResolvers<void>();
    setListInstalledAppsFactoryForTests((device) => ({
      executeDetailedResult: async () => {
        started.add(device.deviceId);
        if (started.size === 2) {
          bothStarted.resolve();
        }
        return successfulAppsResult();
      },
      executeIosDetailedResult: async () => {
        throw new Error("not exercised on android");
      },
    }));

    const first = queryInstalledApps({ deviceId: firstDevice.deviceId });
    const second = queryInstalledApps({ deviceId: secondDevice.deviceId });
    await bothStarted.promise;
    await Promise.all([first, second]);
    expect(started).toEqual(new Set([firstDevice.deviceId, secondDevice.deviceId]));
  });

  test("starts a fresh fetch after invalidation while an older fetch is pending", async () => {
    const oldFetch = Promise.withResolvers<ReturnType<typeof successfulAppsResult>>();
    const oldStarted = Promise.withResolvers<void>();
    const newStarted = Promise.withResolvers<void>();
    let oldResult: Awaited<ReturnType<typeof queryInstalledApps>> | undefined;
    let fetches = 0;
    setListInstalledAppsFactoryForTests(() => ({
      executeDetailedResult: async () => {
        fetches += 1;
        if (fetches === 1) {
          oldStarted.resolve();
          return await oldFetch.promise;
        }
        const coordinator = getInstalledAppsCacheWriteCoordinator();
        coordinator.markRebuilt(
          firstDevice.deviceId,
          coordinator.currentGeneration(firstDevice.deviceId),
        );
        newStarted.resolve();
        return successfulAppsResult("com.example.new");
      },
      executeIosDetailedResult: async () => {
        throw new Error("not exercised on android");
      },
    }));

    const stale = queryInstalledApps({ deviceId: firstDevice.deviceId });
    const staleResolved = stale.then((result) => {
      oldResult = result;
      return result;
    });
    await oldStarted.promise;
    await getInstalledAppsCacheWriteCoordinator().invalidate(firstDevice.deviceId, async () => {});

    const fresh = queryInstalledApps({ deviceId: firstDevice.deviceId });
    await newStarted.promise;
    expect(fetches).toBe(2);
    const freshResult = await fresh;
    expect(freshResult.devices[0].apps.map((app) => app.packageName)).toEqual(["com.example.new"]);

    oldFetch.resolve(successfulAppsResult("com.example.old"));
    await staleResolved;
    expect(oldResult?.devices[0].apps.map((app) => app.packageName)).toEqual(["com.example.old"]);

    const cached = await queryInstalledApps({ deviceId: firstDevice.deviceId });
    expect(cached.devices[0].apps.map((app) => app.packageName)).toEqual(["com.example.new"]);
    expect(fetches).toBe(2);
  });
});
