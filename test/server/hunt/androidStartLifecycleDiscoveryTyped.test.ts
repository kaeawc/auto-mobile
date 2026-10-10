import { describe, expect, test } from "bun:test";
import {
  knownProvisionDeviceError,
  resolveAndroidStartStableDeviceLifecycleTarget,
} from "../../../src/server/deviceTools";
import type { PlatformDeviceManager } from "../../../src/devices/deviceUtils";
import { FakeTimer } from "../../fakes/FakeTimer";

/** adb failed this sweep: no device list, Android not in succeededPlatforms. */
function adbDownDeviceManager(): PlatformDeviceManager {
  return {
    getBootedDevicesDetailed: async () => ({
      devices: [],
      succeededPlatforms: new Set(),
      discoveryErrors: {
        android: { code: "failed", message: "adb server crashed", retryable: true },
      },
    }),
    getDeviceImagesDetailed: async () => ({ devices: [], succeededPlatforms: new Set() }),
  } as unknown as PlatformDeviceManager;
}

describe("hunt: startDevice Android deviceId with incomplete discovery", () => {
  test("is a typed retryable discovery_incomplete, as provisionDevice reports it", async () => {
    const error = await resolveAndroidStartStableDeviceLifecycleTarget(
      "emulator-5554",
      Date.now() + 60_000,
      adbDownDeviceManager(),
      new FakeTimer(),
      undefined,
    ).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeDefined();
    expect(knownProvisionDeviceError(error)?.code).toBe("discovery_incomplete");
  });
});
