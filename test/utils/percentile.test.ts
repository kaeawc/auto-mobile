import { describe, expect, test } from "bun:test";
import { computePercentile } from "../../src/utils/percentile";

describe("computePercentile", () => {
  test("returns 0 for an empty array", () => {
    expect(computePercentile([], 50)).toBe(0);
    expect(computePercentile([], 95)).toBe(0);
  });

  test("returns the single value regardless of percentile", () => {
    expect(computePercentile([42], 50)).toBe(42);
    expect(computePercentile([42], 95)).toBe(42);
  });

  test("picks the exact element when the rank lands on an index", () => {
    // index = 0.5 * (5 - 1) = 2 -> sorted[2]
    expect(computePercentile([100, 200, 300, 400, 500], 50)).toBe(300);
  });

  test("linearly interpolates between the bracketing elements", () => {
    // index = 0.95 * (5 - 1) = 3.8 -> 400 + (500 - 400) * 0.8 = 480
    expect(computePercentile([100, 200, 300, 400, 500], 95)).toBe(480);
  });

  test("assumes an ascending sort (does not re-sort its input)", () => {
    // Contract matches the previous private copies in networkGraph/networkResources:
    // callers sort first. A descending input is read positionally, not corrected.
    expect(computePercentile([500, 400, 300, 200, 100], 50)).toBe(300);
  });
});
