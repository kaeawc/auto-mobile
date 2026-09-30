import { describe, expect, test } from "bun:test";
import { float32ToJavaString } from "../../src/utils/float32ToJavaString";

describe("float32ToJavaString", () => {
  test.each([
    [0.1, "0.1"],
    [1, "1.0"],
    [3.4028235e38, "3.4028235E38"],
    [1e-5, "1.0E-5"],
    [1e-3, "0.001"],
    [1e7, "1.0E7"],
    [Number.NaN, "NaN"],
    [Number.POSITIVE_INFINITY, "Infinity"],
    [Number.NEGATIVE_INFINITY, "-Infinity"],
    [0, "0.0"],
    [-0, "-0.0"],
    [1.23456789, "1.2345679"],
  ])("formats %s as %s", (value, expected) => {
    expect(float32ToJavaString(value)).toBe(expected);
  });

  test.each([0.1, 3.14, 1.23456789, 16777217, 1e-5, 3.4028235e38])(
    "round-trips %s through float32",
    (value) => {
      const rendered = float32ToJavaString(value);
      expect(Math.fround(Number(rendered))).toBe(Math.fround(value));
      const significantDigits = rendered
        .split("E")[0]!
        .replace(/[.\-+]/g, "")
        .replace(/^0+|0+$/g, "");
      expect(significantDigits.length).toBeLessThanOrEqual(9);
    },
  );
});
