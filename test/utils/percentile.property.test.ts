import { describe, test } from "bun:test";
import fc from "fast-check";
import { computePercentile } from "../../src/utils/percentile";

// Property-based tests. See Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

// Non-empty ascending arrays of finite, bounded values (the function's contract:
// the caller sorts ascending first). Bounding keeps interpolation error tiny so
// the monotonicity tolerance below is safe.
const sortedValues = fc
  .array(fc.integer({ min: -1_000_000, max: 1_000_000 }), { minLength: 1, maxLength: 64 })
  .map((xs) => [...xs].sort((a, b) => a - b));

const percentileP = fc.double({ min: 0, max: 100, noNaN: true });

describe("computePercentile (property-based)", () => {
  test("result is bounded by the min and max of the sorted input", () => {
    fc.assert(
      fc.property(sortedValues, percentileP, (sorted, p) => {
        const result = computePercentile(sorted, p);
        return result >= sorted[0] && result <= sorted[sorted.length - 1];
      }),
      RUN_OPTIONS,
    );
  });

  test("the endpoints select the first and last elements", () => {
    fc.assert(
      fc.property(sortedValues, (sorted) => {
        return (
          computePercentile(sorted, 0) === sorted[0] &&
          computePercentile(sorted, 100) === sorted[sorted.length - 1]
        );
      }),
      RUN_OPTIONS,
    );
  });

  test("is monotonic non-decreasing in the requested percentile", () => {
    fc.assert(
      fc.property(sortedValues, percentileP, percentileP, (sorted, a, b) => {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        // Interpolating over an ascending sequence can only rise; allow a small
        // absolute epsilon for floating-point rounding at the segment joins.
        return computePercentile(sorted, lo) <= computePercentile(sorted, hi) + 1e-6;
      }),
      RUN_OPTIONS,
    );
  });

  test("returns 0 for an empty array regardless of the percentile", () => {
    fc.assert(
      fc.property(percentileP, (p) => computePercentile([], p) === 0),
      RUN_OPTIONS,
    );
  });
});
