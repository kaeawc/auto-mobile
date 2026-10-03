import { expect, test } from "bun:test";
import {
  normalizedAxis,
  translatedNormalizedAxis,
} from "../../../src/features/action/coordinateAxis";

test("normalized coordinates preserve zero, interior values and empty extents", () => {
  for (const size of [0, 1, 100, 1e15]) {
    expect(normalizedAxis(0, size)).toBe(0);
    expect(normalizedAxis(0.25, size)).toBe(size * 0.25);
    expect(normalizedAxis(0.75, size)).toBe(size * 0.75);
  }
  expect(normalizedAxis(1, 0)).toBe(0);
});

test("inclusive endpoint stays strictly inside positive extents", () => {
  for (const size of [1, 100, 1e15]) {
    expect(normalizedAxis(1, size)).toBeLessThan(size);
    expect(normalizedAxis(1, size)).toBeGreaterThan(size * 0.999999999999);
  }
});

test("translation keeps near-end values inside even when addition rounds to end", () => {
  for (const [start, end] of [
    [10, 11],
    [1e15, 1e15 + 1],
    [-100, -50],
    [-1, 0],
    [0, 1e15],
  ]) {
    for (const value of [1, 1 - Number.EPSILON / 2, 1 - Number.EPSILON]) {
      const result = translatedNormalizedAxis(value, start, end);
      expect(result).toBeLessThan(end);
      expect(result).toBeGreaterThanOrEqual(start);
    }
    expect(translatedNormalizedAxis(0, start, end)).toBe(start);
    expect(translatedNormalizedAxis(0.5, start, end)).toBe(start + (end - start) / 2);
  }
});

test("degenerate translation returns its origin", () => {
  for (const start of [-100, 0, 100]) {
    expect(translatedNormalizedAxis(1, start, start)).toBe(start);
    expect(translatedNormalizedAxis(0.5, start, start)).toBe(start);
  }
});

test("out-of-range normalization is not clamped; translation guards the upper edge", () => {
  expect(normalizedAxis(-0.5, 100)).toBe(-50);
  expect(normalizedAxis(2, 100)).toBe(200);
  expect(translatedNormalizedAxis(-0.5, 10, 110)).toBe(-40);
  // Translation applies its upper-edge guard even to values above one.
  expect(translatedNormalizedAxis(2, 10, 110)).toBeLessThan(110);
  expect(translatedNormalizedAxis(2, 10, 110)).toBeGreaterThan(109.999999);
});
