import { expect, test } from "bun:test";
import { parseAndroidApiLevelBound } from "../../src/utils/androidVersionBounds";

test("integer API bounds start at 21 and allow whitespace and leading zeroes", () => {
  for (const [bound, expected] of [
    ["34", 34],
    ["21", 21],
    [" 34 ", 34],
    ["034", 34],
  ] as const) {
    expect(parseAndroidApiLevelBound(bound)).toBe(expected);
  }
});

test("release versions, signed bounds, blank and malformed strings are rejected", () => {
  for (const bound of ["20", "14", "0", "", "   ", "14.1", "34.0", "+34", "-34", "abc", "34a"]) {
    expect(parseAndroidApiLevelBound(bound)).toBeUndefined();
  }
});

test("huge digit strings retain Number conversion including overflow", () => {
  const huge = "999999999999999999999999999999";
  expect(parseAndroidApiLevelBound(huge)).toBe(Number(huge));
  expect(parseAndroidApiLevelBound("9".repeat(400))).toBe(Infinity);
});
