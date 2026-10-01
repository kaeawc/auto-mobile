import { afterEach, describe, expect, test } from "bun:test";
import { listBootedDevicesForResource } from "../../src/server/resourceDeviceResolver";
import type { BootedDevice } from "../../src/models";
import type { PlatformDeviceManager } from "../../src/devices/deviceUtils";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { DaemonState } from "../../src/daemon/daemonState";
import {
  QUARANTINE_POOL_SERIAL,
  createIdentityQuarantinePool,
} from "../helpers/identityQuarantinePool";

const device: BootedDevice = {
  deviceId: "emulator-5554",
  name: "Pixel 8",
  platform: "android",
};

describe("listBootedDevicesForResource", () => {
  afterEach(() => {
    PlatformDeviceManagerFactory.setInstance(null);
  });

  test("uses legacy discovery when no abort signal is supplied", async () => {
    let legacyCalls = 0;
    const legacyOnlyManager = {
      getBootedDevices: async () => {
        legacyCalls++;
        return [device];
      },
    };
    PlatformDeviceManagerFactory.setInstance(legacyOnlyManager as unknown as PlatformDeviceManager);

    await expect(listBootedDevicesForResource("android", "test")).resolves.toEqual([device]);
    expect(legacyCalls).toBe(1);
  });

  test("forwards an abort signal through detailed discovery", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const detailedManager = {
      getBootedDevices: async () => {
        throw new Error("legacy discovery should not be used with an abort signal");
      },
      getBootedDevicesDetailed: async (_platform: string, options?: { signal?: AbortSignal }) => {
        receivedSignal = options?.signal;
        options?.signal?.throwIfAborted();
        return { devices: [device], succeededPlatforms: new Set(["android"]) };
      },
    };
    PlatformDeviceManagerFactory.setInstance(detailedManager as unknown as PlatformDeviceManager);

    controller.abort();
    await expect(
      listBootedDevicesForResource("android", "test", { signal: controller.signal }),
    ).rejects.toThrow(/abort/i);
    expect(receivedSignal).toBe(controller.signal);
  });

  test("fresh lookup bypasses caches and excludes retained or failed-platform devices", async () => {
    const controller = new AbortController();
    const stale = { ...device, deviceId: "emulator-5556" };
    const failedPlatform = { ...device, deviceId: "ios-1", platform: "ios" as const };
    const detailedManager = {
      getBootedDevicesDetailed: async (
        platform: string,
        options?: {
          signal?: AbortSignal;
          bypassAndroidDeviceListCache?: boolean;
          bypassIosDeviceListCache?: boolean;
        },
      ) => {
        expect(platform).toBe("either");
        expect(options).toMatchObject({
          signal: controller.signal,
          bypassAndroidDeviceListCache: true,
          bypassIosDeviceListCache: true,
        });
        return {
          devices: [device, stale, failedPlatform],
          succeededPlatforms: new Set(["android"]),
          freshDeviceIds: new Set([device.deviceId, failedPlatform.deviceId]),
        };
      },
    };
    PlatformDeviceManagerFactory.setInstance(detailedManager as unknown as PlatformDeviceManager);

    await expect(
      listBootedDevicesForResource("either", "test", {
        signal: controller.signal,
        requireFresh: true,
      }),
    ).resolves.toEqual([device]);
  });

  test("propagates an abort swallowed by detailed discovery", async () => {
    const controller = new AbortController();
    const detailedManager = {
      getBootedDevices: async () => {
        throw new Error("legacy discovery should not be used with an abort signal");
      },
      getBootedDevicesDetailed: async (_platform: string, options?: { signal?: AbortSignal }) => {
        expect(options?.signal).toBe(controller.signal);
        return { devices: [], succeededPlatforms: new Set(["android"]) };
      },
    };
    PlatformDeviceManagerFactory.setInstance(detailedManager as unknown as PlatformDeviceManager);

    controller.abort();
    await expect(
      listBootedDevicesForResource("android", "test", { signal: controller.signal }),
    ).rejects.toThrow(/abort/i);
  });
});

/**
 * #7002: in daemon mode the reconcile stage after discovery can await the
 * identity quarantine, which cancels and drains the owning session's executions.
 * A cancellation that lands THERE must still reject the read — the discovery
 * recheck runs before that await, so without a second recheck the caller
 * proceeds to act on the device.
 */
describe("listBootedDevicesForResource rechecks cancellation after reconciliation (#7002)", () => {
  afterEach(() => {
    PlatformDeviceManagerFactory.setInstance(null);
    DaemonState.getInstance().reset();
  });

  test("an abort during the identity quarantine rejects instead of returning the devices", async () => {
    const controller = new AbortController();
    const { pool, disagreeing } = await createIdentityQuarantinePool(() => controller.abort());
    const detailedManager = {
      getBootedDevices: async () => {
        throw new Error("legacy discovery should not be used with an abort signal");
      },
      getBootedDevicesDetailed: async () => ({
        devices: [disagreeing],
        succeededPlatforms: new Set(["android"]),
      }),
    };
    PlatformDeviceManagerFactory.setInstance(detailedManager as unknown as PlatformDeviceManager);

    await expect(
      listBootedDevicesForResource("android", "test", { signal: controller.signal }),
    ).rejects.toThrow(/abort/i);
    // The observation itself was still folded in: the reconcile ran to the
    // quarantine before the abort was honoured.
    expect(pool.isPooledIdentityUnresolved(QUARANTINE_POOL_SERIAL)).toBe(true);
  });
});
