import { describe, expect, test } from "bun:test";
import {
  didSourceSucceedForDevice,
  discoverySourceFor,
  discoverySourceOutcome,
  isDeviceSourceIncomplete,
  sourcesForPlatform,
} from "../../src/utils/discoverySource";
import {
  isScanAuthoritativeFor,
  lifecycleIdentityForDevice,
} from "../../src/daemon/readiness/readinessLifecycleIdentity";
import type { BootedDevice } from "../../src/models";

// A watch is listed only by the watch simulator source. An iOS sweep, however complete, never
// lists watches, so it must never count as proof that a pooled or pinned watch is gone (#14908).

const WATCH_UDID = "6B1F3C2E-0000-4000-8000-00000000A7C1";
const watch: BootedDevice = {
  name: "Apple Watch Series 10 (46mm)",
  platform: "watchos",
  deviceId: WATCH_UDID,
};
const iosSweepComplete = {
  succeededPlatforms: new Set(["ios"] as const),
  succeededSources: new Set(["ios-simulator", "ios-physical"] as const),
};

describe("watchOS discovery source", () => {
  test("a watch belongs to its own source, never an iOS one", () => {
    expect(discoverySourceFor("watchos", WATCH_UDID)).toBe("watchos-simulator");
    expect(discoverySourceFor("watchos", undefined)).toBe("watchos-simulator");
    expect(sourcesForPlatform("watchos")).toEqual(["watchos-simulator"]);
    expect(sourcesForPlatform("ios")).toEqual(["ios-simulator", "ios-physical"]);
  });

  test("a complete iOS sweep says nothing about a watch", () => {
    expect(didSourceSucceedForDevice(iosSweepComplete, "watchos", WATCH_UDID)).toBe(false);
    expect(isDeviceSourceIncomplete(iosSweepComplete, "watchos", WATCH_UDID)).toBe(true);
    expect(
      isScanAuthoritativeFor(
        {
          devices: [],
          scanned: { android: true, ios: true, watchos: false },
          scannedSources: { android: true, "ios-simulator": true, "ios-physical": true },
        },
        watch,
      ),
    ).toBe(false);
  });

  test("the watch source reports its own platform's errors, not iOS's", () => {
    const iosUnavailable = {
      succeededPlatforms: new Set<never>(),
      discoveryErrors: { ios: { code: "unavailable" } },
    };
    const watchUnavailable = {
      succeededPlatforms: new Set<never>(),
      discoveryErrors: { watchos: { code: "unavailable" } },
    };

    expect(discoverySourceOutcome(iosUnavailable, "watchos-simulator")).toBe("incomplete");
    expect(discoverySourceOutcome(watchUnavailable, "watchos-simulator")).toBe("not_applicable");
    expect(
      discoverySourceOutcome({ succeededPlatforms: new Set(["watchos"]) }, "watchos-simulator"),
    ).toBe("complete");
  });

  test("a watch has its own stable lifecycle identity", () => {
    expect(lifecycleIdentityForDevice(watch)).toEqual({
      platform: "watchos",
      stableId: WATCH_UDID,
    });
  });
});
