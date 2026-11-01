import { describe, expect, test } from "bun:test";
import { DeviceCriteriaMatcher } from "../../src/daemon/DeviceCriteriaMatcher";
import { assertPoolCapacity } from "../../src/daemon/poolCapacityError";

describe("assertPoolCapacity", () => {
  const stats = { total: 1, idle: 0, assigned: 1, error: 0 };
  const matcher = new DeviceCriteriaMatcher();

  test("throws with the shortfall and pool counts", () => {
    expect(() =>
      assertPoolCapacity(matcher, stats, 3, { recoveringAndroidImages: 0, refreshContext: "" }),
    ).toThrow(
      /^Not enough devices in pool: need 3, have 1\.\nDevice pool status:[\s\S]*Assigned: 1\n[\s\S]*Start 2 more emulator\(s\)/,
    );
  });

  test("places the refresh context before the pool status", () => {
    expect(() =>
      assertPoolCapacity(matcher, stats, 3, {
        recoveringAndroidImages: 0,
        refreshContext: "Could not refresh device list: x.\n",
      }),
    ).toThrow("have 1.\nCould not refresh device list: x.\nDevice pool status:");
  });

  test("counts Android recoveries toward capacity, but not for iOS", () => {
    expect(() =>
      assertPoolCapacity(matcher, stats, 3, { recoveringAndroidImages: 2, refreshContext: "" }),
    ).not.toThrow();
    expect(() =>
      assertPoolCapacity(matcher, stats, 3, {
        platform: "ios",
        recoveringAndroidImages: 2,
        refreshContext: "",
      }),
    ).toThrow();
  });
});
