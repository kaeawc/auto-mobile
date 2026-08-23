import { describe, expect, test } from "bun:test";
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
  test("portrait maps sensor X to display width and sensor Y to display height", () => {
    const scaler = buildScaler(ranges({ rotation: 0 }));
    // norm(4095) = 4095 / (4095 - 0 + 1) = 4095/4096
    expect(scaler.toScreenX(4095)).toBe(1000);
    expect(scaler.toScreenY(4095)).toBe(2000);
    expect(scaler.toScreenX(2048)).toBe(500);
  });

  test("landscape (rotation 1) swaps the axes: sensor X maps to display height", () => {
    const scaler = buildScaler(ranges({ rotation: 1 }));
    expect(scaler.toScreenX(4095)).toBe(2000); // height, not width
    expect(scaler.toScreenY(4095)).toBe(1000); // width, not height
  });

  test("landscape (rotation 3) swaps the axes just like rotation 1", () => {
    const scaler = buildScaler(ranges({ rotation: 3 }));
    expect(scaler.toScreenX(4095)).toBe(2000);
    expect(scaler.toScreenY(4095)).toBe(1000);
  });

  test("reverse-portrait (rotation 2) keeps the portrait axis mapping", () => {
    const scaler = buildScaler(ranges({ rotation: 2 }));
    expect(scaler.toScreenX(4095)).toBe(1000);
    expect(scaler.toScreenY(4095)).toBe(2000);
  });

  test("the +1 span divisor keeps a max-raw value just inside the display bound", () => {
    // 4095 raw across [0, 4095] over a 2400px axis lands at 2399, not 2400 —
    // the off-by-one that a naive (xMax - xMin) divisor would produce.
    const scaler = buildScaler(ranges({ displayWidth: 2400, rotation: 0 }));
    expect(scaler.toScreenX(4095)).toBe(2399);
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
    adb.setCommandError("shell dumpsys window displays", new Error("device offline"));
    expect(await queryRotation(adb)).toBe(0);
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
    adb.setCommandError("shell wm density", new Error("device offline"));
    expect(await queryDensity(adb)).toBe(2.75);
  });
});
