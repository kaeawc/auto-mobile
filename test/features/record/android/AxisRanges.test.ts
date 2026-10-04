import { logger } from "../../../../src/utils/logger";
import { describe, expect, test, spyOn } from "bun:test";
import {
  buildScaler,
  queryDensity,
  queryRotation,
} from "../../../../src/features/record/android/AxisRanges";
import { FakeAdbClient } from "../../../fakes/FakeAdbClient";

/** Full axis+display description accepted by buildScaler. */
function ranges(
  overrides: Partial<Parameters<typeof buildScaler>[0]> = {},
): Parameters<typeof buildScaler>[0] {
  return {
    xMin: 0,
    xMax: 4095,
    yMin: 0,
    yMax: 4095,
    displayWidth: 1000,
    displayHeight: 2000,
    rotation: 0,
    ...overrides,
  };
}

describe("buildScaler", () => {
  // Raw min/max are offset to prove inversion uses each axis's own range.
  test.each([
    [0, { x: 0, y: 0 }, { x: 1000, y: 0 }, { x: 0, y: 2000 }],
    [1, { x: 0, y: 1000 }, { x: 0, y: 0 }, { x: 2000, y: 1000 }],
    [2, { x: 1000, y: 2000 }, { x: 0, y: 2000 }, { x: 1000, y: 0 }],
    [3, { x: 2000, y: 0 }, { x: 2000, y: 1000 }, { x: 0, y: 0 }],
  ])("rotation %i maps raw X and Y with Android axis direction", (rotation, origin, xMax, yMax) => {
    const scaler = buildScaler(ranges({ xMin: 10, xMax: 4105, yMin: 20, yMax: 4115, rotation }));
    expect(scaler.toScreenPoint(10, 20)).toEqual(origin);
    expect(scaler.toScreenPoint(4105, 20)).toEqual(xMax);
    expect(scaler.toScreenPoint(10, 4115)).toEqual(yMax);
  });

  test("the +1 span divisor keeps a max-raw value just inside the display bound", () => {
    // 4095 raw across [0, 4095] over a 2400px axis lands at 2399, not 2400 —
    // the off-by-one that a naive (xMax - xMin) divisor would produce.
    const scaler = buildScaler(ranges({ displayWidth: 2400, rotation: 0 }));
    expect(scaler.toScreenPoint(4095, 0).x).toBe(2399);
  });
});

describe("queryRotation", () => {
  test.each([
    ["mCurrentRotation=ROTATION_0", 0],
    ["mCurrentRotation=ROTATION_90", 1],
    ["mCurrentRotation=ROTATION_1", 1],
    ["mCurrentRotation=ROTATION_180", 2],
    ["mCurrentRotation=ROTATION_270", 3],
    ["mCurrentRotation=ROTATION_3", 3],
  ])("normalizes %p to rotation index %p", async (stdout, expected) => {
    const adb = new FakeAdbClient();
    adb.setCommandResult("shell dumpsys window displays", stdout);
    expect(await queryRotation(adb)).toBe(expected);
  });

  test("defaults to 0 when the rotation cannot be parsed", async () => {
    const adb = new FakeAdbClient();
    adb.setCommandResult("shell dumpsys window displays", "no rotation here");
    expect(await queryRotation(adb)).toBe(0);
  });

  test("defaults to 0 when the dumpsys command fails", async () => {
    const adb = new FakeAdbClient();
    const failure = new Error("device offline");
    adb.setCommandError("shell dumpsys window displays", failure);
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(await queryRotation(adb)).toBe(0);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Failed to query"), failure);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("queryDensity", () => {
  test("converts a physical density to a dp multiplier", async () => {
    const adb = new FakeAdbClient();
    adb.setCommandResult("shell wm density", "Physical density: 480");
    expect(await queryDensity(adb)).toBe(3);
  });

  test("reads the physical density even when an override density follows", async () => {
    const adb = new FakeAdbClient();
    adb.setCommandResult("shell wm density", "Physical density: 480\nOverride density: 320");
    expect(await queryDensity(adb)).toBe(3);
  });

  test("falls back to 2.75 when the density cannot be parsed", async () => {
    const adb = new FakeAdbClient();
    adb.setCommandResult("shell wm density", "unknown");
    expect(await queryDensity(adb)).toBe(2.75);
  });

  test("falls back to 2.75 when the density command fails", async () => {
    const adb = new FakeAdbClient();
    const failure = new Error("device offline");
    adb.setCommandError("shell wm density", failure);
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(await queryDensity(adb)).toBe(2.75);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Failed to query"), failure);
    } finally {
      warn.mockRestore();
    }
  });
});
