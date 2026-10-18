import { describe, expect, test } from "bun:test";
import type { DeviceHealthMarkers } from "../../src/daemon/deviceHealthMarkers";

export interface DeviceHealthMarkersContractHarness {
  markers: DeviceHealthMarkers;
  /** Advances the injected clock that stamps `since`. */
  advance(ms: number): void;
  /** Current injected time, the value `since` must carry. */
  now(): number;
}

/**
 * Shared contract for every {@link DeviceHealthMarkers}: marks are per device and incarnation,
 * idempotent per reason, ordered oldest first, and a newer incarnation read drops stale marks.
 * Run against InMemoryDeviceHealthMarkers and FakeDeviceHealthMarkers (issue #11868).
 */
export const runDeviceHealthMarkersContract = (
  description: string,
  make: () => DeviceHealthMarkersContractHarness,
): void => {
  describe(`DeviceHealthMarkers contract: ${description}`, function () {
    test("stamps a new mark with the injected time", function () {
      const { markers, advance, now } = make();
      advance(250);

      const marker = markers.mark("emulator-5554", 1, "clock");

      expect(marker).toEqual({ reason: "clock", since: now() });
      expect(markers.get("emulator-5554", 1, "clock")).toEqual(marker);
    });

    test("marking the same reason again keeps the original mark", function () {
      const { markers, advance } = make();
      const first = markers.mark("emulator-5554", 1, "clock");
      advance(500);

      const second = markers.mark("emulator-5554", 1, "clock");

      expect(second.since).toBe(first.since);
      expect(markers.list("emulator-5554", 1)).toHaveLength(1);
    });

    test("lists reasons oldest first and get returns the oldest", function () {
      const { markers, advance } = make();
      markers.mark("emulator-5554", 1, "network-condition");
      advance(10);
      markers.mark("emulator-5554", 1, "clock");

      expect(markers.list("emulator-5554", 1).map((marker) => marker.reason)).toEqual([
        "network-condition",
        "clock",
      ]);
      expect(markers.get("emulator-5554", 1)?.reason).toBe("network-condition");
      expect(markers.get("emulator-5554", 1, "app-cleanup")).toBeUndefined();
    });

    test("list returns a snapshot that later marks do not mutate", function () {
      const { markers } = make();
      markers.mark("emulator-5554", 1, "clock");
      const snapshot = markers.list("emulator-5554", 1);

      markers.mark("emulator-5554", 1, "app-cleanup");

      expect(snapshot).toHaveLength(1);
    });

    test("keeps devices independent", function () {
      const { markers } = make();
      markers.mark("emulator-5554", 1, "clock");

      expect(markers.list("emulator-5556", 1)).toEqual([]);
    });

    test("a read at a newer incarnation drops the stale marks", function () {
      const { markers } = make();
      markers.mark("emulator-5554", 1, "clock");

      expect(markers.list("emulator-5554", 2)).toEqual([]);
      expect(markers.list("emulator-5554", 1)).toEqual([]);
    });

    test("a read at an older incarnation sees nothing and keeps the newer marks", function () {
      const { markers } = make();
      markers.mark("emulator-5554", 2, "clock");

      expect(markers.list("emulator-5554", 1)).toEqual([]);
      expect(markers.get("emulator-5554", 2, "clock")?.reason).toBe("clock");
    });

    test("marking at an older incarnation returns a mark without recording it", function () {
      const { markers, now } = make();
      markers.mark("emulator-5554", 2, "clock");

      const stale = markers.mark("emulator-5554", 1, "app-cleanup");

      expect(stale).toEqual({ reason: "app-cleanup", since: now() });
      expect(markers.list("emulator-5554", 2).map((marker) => marker.reason)).toEqual(["clock"]);
    });

    test("marking at a newer incarnation replaces the stale marks", function () {
      const { markers } = make();
      markers.mark("emulator-5554", 1, "clock");

      markers.mark("emulator-5554", 2, "app-cleanup");

      expect(markers.list("emulator-5554", 2).map((marker) => marker.reason)).toEqual([
        "app-cleanup",
      ]);
    });

    test("clear with a reason removes only that reason", function () {
      const { markers } = make();
      markers.mark("emulator-5554", 1, "clock");
      markers.mark("emulator-5554", 1, "app-cleanup");

      markers.clear("emulator-5554", 1, "clock");

      expect(markers.list("emulator-5554", 1).map((marker) => marker.reason)).toEqual([
        "app-cleanup",
      ]);
    });

    test("clear without a reason removes every mark of that incarnation", function () {
      const { markers } = make();
      markers.mark("emulator-5554", 1, "clock");
      markers.mark("emulator-5554", 1, "app-cleanup");

      markers.clear("emulator-5554", 1);

      expect(markers.list("emulator-5554", 1)).toEqual([]);
    });

    test("clear for a different incarnation leaves the marks alone", function () {
      const { markers } = make();
      markers.mark("emulator-5554", 2, "clock");

      markers.clear("emulator-5554", 1);

      expect(markers.list("emulator-5554", 2)).toHaveLength(1);
    });

    test("clear without an incarnation removes the device's marks", function () {
      const { markers } = make();
      markers.mark("emulator-5554", 3, "clock");

      markers.clear("emulator-5554");

      expect(markers.list("emulator-5554", 3)).toEqual([]);
    });

    test("clearing an unknown device is a no-op", function () {
      const { markers } = make();

      markers.clear("emulator-9999", 1, "clock");

      expect(markers.list("emulator-9999", 1)).toEqual([]);
    });

    test("a cleared reason can be marked again with a fresh time", function () {
      const { markers, advance, now } = make();
      markers.mark("emulator-5554", 1, "clock");
      markers.clear("emulator-5554", 1, "clock");
      advance(40);

      const again = markers.mark("emulator-5554", 1, "clock");

      expect(again.since).toBe(now());
    });
  });
};
