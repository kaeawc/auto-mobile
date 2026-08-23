import { describe, expect, test } from "bun:test";
import {
  DeviceCriteriaMatcher,
  DeviceAllocationRequest,
  DeviceAllocationCriteria,
} from "../../src/daemon/DeviceCriteriaMatcher";
import type { PooledDevice } from "../../src/daemon/devicePool";
import { BootedDevice, DeviceInfo, Platform } from "../../src/models";

const matcher = new DeviceCriteriaMatcher();

const pooledDevice = (overrides: Partial<PooledDevice> & { id: string }): PooledDevice => ({
  name: overrides.id,
  platform: "ios",
  sessionId: null,
  status: "idle",
  lastUsedAt: 0,
  assignmentCount: 0,
  errorCount: 0,
  ...overrides,
});

const deviceImage = (
  overrides: Partial<DeviceInfo> & { name: string; platform: Platform },
): DeviceInfo => ({
  isRunning: false,
  ...overrides,
});

describe("DeviceCriteriaMatcher", () => {
  describe("sortBySpecificity", () => {
    test("orders most specific criteria first and is stable for equal scores", () => {
      const loose: DeviceAllocationRequest = { sessionId: "a", criteria: { platform: "ios" } };
      const specific: DeviceAllocationRequest = {
        sessionId: "b",
        criteria: { platform: "ios", simulatorType: "iPhone 15 Pro", iosVersion: "17.5" },
      };
      const none: DeviceAllocationRequest = { sessionId: "c" };

      const sorted = matcher.sortBySpecificity([none, loose, specific]);

      expect(sorted.map((r) => r.sessionId)).toEqual(["b", "a", "c"]);
    });

    test("does not mutate the input array", () => {
      const input: DeviceAllocationRequest[] = [
        { sessionId: "a" },
        { sessionId: "b", criteria: { platform: "ios", iosVersion: "17.5" } },
      ];
      matcher.sortBySpecificity(input);
      expect(input.map((r) => r.sessionId)).toEqual(["a", "b"]);
    });
  });

  describe("filterDevices", () => {
    const devices = [
      pooledDevice({ id: "android-1", platform: "android", name: "Pixel 7" }),
      pooledDevice({
        id: "sim-1",
        platform: "ios",
        name: "iPhone 15 Pro",
        iosVersion: "17.5",
        simulatorType: "iPhone 15 Pro",
      }),
      pooledDevice({
        id: "sim-2",
        platform: "ios",
        name: "iPhone 15",
        iosVersion: "17.4",
        simulatorType: "iPhone 15",
      }),
    ];

    test("returns all devices when criteria is undefined", () => {
      expect(matcher.filterDevices(devices).length).toBe(3);
    });

    test("filters by platform", () => {
      const result = matcher.filterDevices(devices, { platform: "ios" });
      expect(result.map((d) => d.id)).toEqual(["sim-1", "sim-2"]);
    });

    test("matches simulator type case-insensitively against name or simulatorType", () => {
      const result = matcher.filterDevices(devices, {
        platform: "ios",
        simulatorType: "iphone 15 pro",
      });
      expect(result.map((d) => d.id)).toEqual(["sim-1"]);
    });

    test("filters by iOS version", () => {
      const result = matcher.filterDevices(devices, { iosVersion: "17.4" });
      expect(result.map((d) => d.id)).toEqual(["sim-2"]);
    });

    test("returns nothing when type and version cannot both be satisfied", () => {
      const result = matcher.filterDevices(devices, {
        simulatorType: "iPhone 15 Pro",
        iosVersion: "17.4",
      });
      expect(result).toEqual([]);
    });

    // Boundary rows (PARAM-4/5/7). Each is traced against filterDevices +
    // normalizeValue (trim + lowercase, empty → undefined → "match any").
    const boundaryRows: Array<{
      name: string;
      criteria: DeviceAllocationCriteria;
      expected: string[];
    }> = [
      {
        name: "an empty-string iosVersion normalizes away and matches every device",
        criteria: { iosVersion: "" },
        expected: ["android-1", "sim-1", "sim-2"],
      },
      {
        name: "a whitespace-only simulatorType normalizes away and does not filter",
        criteria: { simulatorType: "   " },
        expected: ["android-1", "sim-1", "sim-2"],
      },
      {
        name: "a padded simulatorType is trimmed before matching",
        criteria: { simulatorType: "  iPhone 15 Pro  " },
        expected: ["sim-1"],
      },
      {
        name: "a padded iosVersion is trimmed before the exact compare",
        criteria: { iosVersion: " 17.4 " },
        expected: ["sim-2"],
      },
      {
        name: "a partial version like '17' does not match '17.4'/'17.5' (exact compare)",
        criteria: { iosVersion: "17" },
        expected: [],
      },
      {
        name: "the simulatorType prefix 'iPhone 15' matches only the exact-named device",
        criteria: { simulatorType: "iPhone 15" },
        expected: ["sim-2"],
      },
      {
        name: "an exponent-looking version string is compared literally, not numerically",
        criteria: { iosVersion: "1e10" },
        expected: [],
      },
    ];

    for (const row of boundaryRows) {
      test(`filterDevices: ${row.name}`, () => {
        const result = matcher.filterDevices(devices, row.criteria);
        expect(result.map((d) => d.id).sort()).toEqual([...row.expected].sort());
      });
    }

    test("does not deduplicate devices that share an id (filtering is not a pool invariant)", () => {
      const dup = pooledDevice({
        id: "sim-1",
        platform: "ios",
        name: "iPhone 15 Pro",
        iosVersion: "17.5",
        simulatorType: "iPhone 15 Pro",
      });
      const result = matcher.filterDevices([devices[1], dup], {
        platform: "ios",
        simulatorType: "iPhone 15 Pro",
      });
      expect(result.length).toBe(2);
    });
  });

  describe("deviceImageMatchesCriteria", () => {
    test("matches simulator type via deviceType identifier suffix", () => {
      const image = deviceImage({
        name: "iPhone 15 Pro",
        platform: "ios",
        deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-15-Pro",
      });
      expect(matcher.deviceImageMatchesCriteria(image, { simulatorType: "iPhone 15 Pro" })).toBe(
        true,
      );
    });

    test("matches iOS version derived from runtime", () => {
      const image = deviceImage({
        name: "iPhone 15",
        platform: "ios",
        runtime: "com.apple.CoreSimulator.SimRuntime.iOS-17-5",
      });
      expect(matcher.deviceImageMatchesCriteria(image, { iosVersion: "17.5" })).toBe(true);
      expect(matcher.deviceImageMatchesCriteria(image, { iosVersion: "16.0" })).toBe(false);
    });

    test("rejects platform mismatch", () => {
      const image = deviceImage({ name: "Pixel", platform: "android" });
      expect(matcher.deviceImageMatchesCriteria(image, { platform: "ios" })).toBe(false);
    });
  });

  describe("isStartableDeviceImage", () => {
    test("rejects unavailable images", () => {
      expect(
        matcher.isStartableDeviceImage(
          deviceImage({ name: "x", platform: "ios", deviceId: "u", isAvailable: false }),
        ),
      ).toBe(false);
    });

    test("requires a deviceId and Shutdown state for iOS", () => {
      expect(matcher.isStartableDeviceImage(deviceImage({ name: "x", platform: "ios" }))).toBe(
        false,
      );
      expect(
        matcher.isStartableDeviceImage(
          deviceImage({ name: "x", platform: "ios", deviceId: "u", state: "Booted" }),
        ),
      ).toBe(false);
      expect(
        matcher.isStartableDeviceImage(
          deviceImage({ name: "x", platform: "ios", deviceId: "u", state: "Shutdown" }),
        ),
      ).toBe(true);
    });

    test("accepts android images without iOS constraints", () => {
      expect(
        matcher.isStartableDeviceImage(deviceImage({ name: "Pixel", platform: "android" })),
      ).toBe(true);
    });
  });

  describe("getDeviceImageKey", () => {
    test("prefers deviceId, falling back to platform:name", () => {
      expect(
        matcher.getDeviceImageKey(deviceImage({ name: "x", platform: "ios", deviceId: "udid" })),
      ).toBe("udid");
      expect(matcher.getDeviceImageKey(deviceImage({ name: "Pixel", platform: "android" }))).toBe(
        "android:Pixel",
      );
    });
  });

  describe("withDeviceImageMetadata", () => {
    test("backfills missing fields from the image without overwriting booted values", () => {
      const ready: BootedDevice = {
        name: "sim",
        platform: "ios",
        deviceId: "udid",
        iosVersion: "17.5",
      };
      const image = deviceImage({
        name: "iPhone 15 Pro",
        platform: "ios",
        deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-15-Pro",
        runtime: "com.apple.CoreSimulator.SimRuntime.iOS-17-4",
        screenWidth: 393,
      });

      const merged = matcher.withDeviceImageMetadata(ready, image);

      expect(merged.iosVersion).toBe("17.5"); // booted value preserved
      expect(merged.osVersion).toBe("17.4"); // backfilled from runtime
      expect(merged.screenWidth).toBe(393);
      expect(merged.simulatorType).toBe("iPhone 15 Pro");
    });
  });

  describe("getBootedDeviceSimulatorType", () => {
    test("prefers explicit simulatorType then derives from deviceType", () => {
      expect(
        matcher.getBootedDeviceSimulatorType({
          name: "s",
          platform: "ios",
          deviceId: "u",
          simulatorType: "iPhone 15",
        } as BootedDevice),
      ).toBe("iPhone 15");
      expect(
        matcher.getBootedDeviceSimulatorType({
          name: "s",
          platform: "ios",
          deviceId: "u",
          deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-15-Pro",
        } as BootedDevice),
      ).toBe("iPhone 15 Pro");
      expect(
        matcher.getBootedDeviceSimulatorType({ name: "s", platform: "android", deviceId: "u" }),
      ).toBeUndefined();
    });
  });

  describe("formatCriteriaSummary", () => {
    test("returns empty string when no criteria", () => {
      expect(matcher.formatCriteriaSummary()).toBe("");
      expect(matcher.formatCriteriaSummary({})).toBe("");
    });

    test("joins present criteria fields", () => {
      expect(
        matcher.formatCriteriaSummary({
          platform: "ios",
          simulatorType: "iPhone 15",
          iosVersion: "17.5",
        }),
      ).toBe(" (platform=ios, simulatorType=iPhone 15, iosVersion=17.5)");
    });
  });
});
