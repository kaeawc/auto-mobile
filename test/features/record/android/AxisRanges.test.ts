import { logger } from "../../../../src/utils/logger";
import { describe, expect, test, spyOn } from "bun:test";
import { buildScaler, queryDensity } from "../../../../src/features/record/android/AxisRanges";
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
    [0, { x: 0, y: 0 }, { x: 999, y: 0 }, { x: 0, y: 1999 }],
    [1, { x: 0, y: 999 }, { x: 0, y: 0 }, { x: 1999, y: 999 }],
    [2, { x: 999, y: 1999 }, { x: 0, y: 1999 }, { x: 999, y: 0 }],
    [3, { x: 1999, y: 0 }, { x: 1999, y: 999 }, { x: 0, y: 0 }],
  ])("rotation %i maps raw X and Y with Android axis direction", (rotation, origin, xMax, yMax) => {
    const scaler = buildScaler(ranges({ xMin: 10, xMax: 4105, yMin: 20, yMax: 4115, rotation }));
    expect(scaler.toScreenPoint(10, 20)).toEqual(origin);
    expect(scaler.toScreenPoint(4105, 20)).toEqual(xMax);
    expect(scaler.toScreenPoint(10, 4115)).toEqual(yMax);
  });

  test.each([0, 1, 2, 3])(
    "rotation %i never maps the axis limits outside the half-open display bounds",
    (rotation) => {
      const scaler = buildScaler(ranges({ displayWidth: 1080, displayHeight: 2400, rotation }));
      const [w, h] = rotation % 2 === 0 ? [1080, 2400] : [2400, 1080];
      for (const rawX of [0, 4095]) {
        for (const rawY of [0, 4095]) {
          const { x, y } = scaler.toScreenPoint(rawX, rawY);
          expect(x).toBeGreaterThanOrEqual(0);
          expect(x).toBeLessThan(w);
          expect(y).toBeGreaterThanOrEqual(0);
          expect(y).toBeLessThan(h);
        }
      }
    },
  );

  test("the +1 span divisor keeps a max-raw value just inside the display bound", () => {
    // 4095 raw across [0, 4095] over a 2400px axis lands at 2399, not 2400 —
    // the off-by-one that a naive (xMax - xMin) divisor would produce.
    const scaler = buildScaler(ranges({ displayWidth: 2400, rotation: 0 }));
    expect(scaler.toScreenPoint(4095, 0).x).toBe(2399);
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
