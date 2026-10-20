import { describe, expect, test } from "bun:test";
import type { DeviceWindowCacheInvalidator } from "../../src/features/observe/DeviceWindowCacheInvalidator";
import type { BootedDevice } from "../../src/models";

export interface DeviceWindowCacheInvalidatorContractHarness {
  invalidator: DeviceWindowCacheInvalidator;
  /** Puts a cached observation in the registered observe-result store. */
  cacheObservation(deviceId: string): Promise<void>;
  hasCachedObservation(deviceId: string): Promise<boolean>;
  /** Whether the next element resolution must re-read the window for this device. */
  windowResolutionRequired(deviceId: string): boolean;
}

const android: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };
const ios: BootedDevice = { deviceId: "SIM-UDID", name: "iPhone", platform: "ios" };
const other: BootedDevice = { deviceId: "emulator-5556", name: "Other", platform: "android" };

/**
 * Shared contract for every {@link DeviceWindowCacheInvalidator}: invalidate retires only the
 * selected device's cached observation (Android also owes a window re-read), and retiring an
 * app process leaves the observation cache alone. Run against DefaultDeviceWindowCacheInvalidator
 * (a fake observe-result store, no CtrlProxy client) and FakeDeviceWindowCacheInvalidator
 * (issue #11868).
 */
export const runDeviceWindowCacheInvalidatorContract = (
  description: string,
  make: () => DeviceWindowCacheInvalidatorContractHarness,
): void => {
  describe(`DeviceWindowCacheInvalidator contract: ${description}`, function () {
    test("invalidate drops only the selected device's cached observation", async function () {
      const h = make();
      await h.cacheObservation(android.deviceId);
      await h.cacheObservation(other.deviceId);

      h.invalidator.invalidate(android);

      expect(await h.hasCachedObservation(android.deviceId)).toBe(false);
      expect(await h.hasCachedObservation(other.deviceId)).toBe(true);
    });

    test("invalidate preserving app identity still drops the cached observation", async function () {
      const h = make();
      await h.cacheObservation(ios.deviceId);

      h.invalidator.invalidate(ios, true);

      expect(await h.hasCachedObservation(ios.deviceId)).toBe(false);
    });

    test("android invalidation requires a window re-read for that device only", function () {
      const h = make();

      h.invalidator.invalidate(android);

      expect(h.windowResolutionRequired(android.deviceId)).toBe(true);
      expect(h.windowResolutionRequired(other.deviceId)).toBe(false);
    });

    test("ios invalidation does not require a window re-read", function () {
      const h = make();

      h.invalidator.invalidate(ios);

      expect(h.windowResolutionRequired(ios.deviceId)).toBe(false);
    });

    test("retiring an app process leaves the cached observation and window state alone", async function () {
      const h = make();
      await h.cacheObservation(android.deviceId);

      h.invalidator.retireAppProcess(android, "com.example.app");

      expect(await h.hasCachedObservation(android.deviceId)).toBe(true);
      expect(h.windowResolutionRequired(android.deviceId)).toBe(false);
    });
  });
};
