import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  calculateMedian,
  calculateMode,
  calculateWeightedAverage,
} from "../../../src/features/shared/MetricsUtils";

// Property-based tests for the shared metrics helpers. The invariants asserted are
// the precise ones the code guarantees — e.g. mode is order-independent only under a
// UNIQUE max frequency, and weighted-average order-invariance is exact only with
// integer sums. See test/utils/Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 150 } as const;

// Median values are bounded so the even-length average can't overflow to ±Infinity
// (e.g. (MAX_VALUE + MAX_VALUE) / 2), and permutation-invariance is compared with
// `===` rather than `toBe`/Object.is so a `-0` result equals a `+0` result.
const medianValue = fc.double({ min: -1e6, max: 1e6, noNaN: true });

/** Reorder `items` by an independently generated key vector (a pseudo-permutation). */
function permuteBy<T>(items: T[], keys: number[]): T[] {
  return items
    .map((item, i) => ({ item, key: keys[i] }))
    .sort((a, b) => a.key - b.key)
    .map(({ item }) => item);
}

/** Attach a same-length key vector to an array so it can be permuted deterministically. */
function withKeys<T>(elements: fc.Arbitrary<T>, opts: fc.ArrayConstraints) {
  return fc.array(elements, opts).chain((items) =>
    fc
      .array(fc.double({ noNaN: true, noDefaultInfinity: true }), {
        minLength: items.length,
        maxLength: items.length,
      })
      .map((keys) => ({ items, keys })),
  );
}

describe("calculateMedian (property-based)", () => {
  test("permutation invariance: median is independent of input order", () => {
    fc.assert(
      fc.property(withKeys(medianValue, { minLength: 1, maxLength: 12 }), ({ items, keys }) => {
        // `===` treats -0 and +0 as equal; median can return either depending on order.
        expect(calculateMedian(permuteBy(items, keys)) === calculateMedian(items)).toBe(true);
      }),
      RUN_OPTIONS,
    );
  });

  test("non-mutation: the input array is unchanged", () => {
    fc.assert(
      fc.property(fc.array(medianValue, { minLength: 1, maxLength: 12 }), (values) => {
        const snapshot = [...values];
        calculateMedian(values);
        expect(values).toEqual(snapshot);
      }),
      RUN_OPTIONS,
    );
  });

  test("bounds: median lies within [min, max]", () => {
    fc.assert(
      fc.property(fc.array(medianValue, { minLength: 1, maxLength: 12 }), (values) => {
        const m = calculateMedian(values)!;
        expect(m).toBeGreaterThanOrEqual(Math.min(...values));
        expect(m).toBeLessThanOrEqual(Math.max(...values));
      }),
      RUN_OPTIONS,
    );
  });

  test("numeric rank: at most half the values fall on either side (catches a non-numeric sort)", () => {
    // A regression to JS's default lexicographic `.sort()` would still pass the
    // bounds and permutation properties, but produces a value of the wrong numeric
    // rank — so pin the rank directly (oracle-free).
    fc.assert(
      fc.property(fc.array(medianValue, { minLength: 1, maxLength: 12 }), (values) => {
        const m = calculateMedian(values)!;
        const half = Math.floor(values.length / 2);
        expect(values.filter((v) => v < m).length).toBeLessThanOrEqual(half);
        expect(values.filter((v) => v > m).length).toBeLessThanOrEqual(half);
      }),
      RUN_OPTIONS,
    );
  });
});

describe("calculateMode (property-based)", () => {
  const smallInts = fc.integer({ min: 0, max: 5 });

  function frequency(values: number[]): Map<number, number> {
    const freq = new Map<number, number>();
    for (const v of values) {
      freq.set(v, (freq.get(v) ?? 0) + 1);
    }
    return freq;
  }

  test("returns a value present in the array with the maximum frequency", () => {
    fc.assert(
      fc.property(fc.array(smallInts, { minLength: 1, maxLength: 16 }), (values) => {
        const mode = calculateMode(values)!;
        const freq = frequency(values);
        const maxFreq = Math.max(...freq.values());
        expect(values).toContain(mode);
        expect(freq.get(mode)).toBe(maxFreq);
      }),
      RUN_OPTIONS,
    );
  });

  test("permutation invariance holds when the max frequency is unique", () => {
    fc.assert(
      fc.property(withKeys(smallInts, { minLength: 1, maxLength: 16 }), ({ items, keys }) => {
        const freq = frequency(items);
        const maxFreq = Math.max(...freq.values());
        const winners = [...freq.values()].filter((f) => f === maxFreq).length;
        if (winners !== 1) {
          return; // tie — order-dependent by construction, covered by the membership test
        }
        expect(calculateMode(permuteBy(items, keys))).toBe(calculateMode(items));
      }),
      RUN_OPTIONS,
    );
  });
});

describe("calculateWeightedAverage (property-based)", () => {
  const intValue = fc.integer({ min: -1000, max: 1000 });
  const posWeight = fc.integer({ min: 1, max: 100 });
  const item = fc.record({ value: intValue, weight: posWeight });
  const getValue = (i: { value: number; weight: number }) => i.value;
  const getWeight = (i: { value: number; weight: number }) => i.weight;

  test("bounds: with positive weights the result lies within [min, max]", () => {
    fc.assert(
      fc.property(fc.array(item, { minLength: 1, maxLength: 12 }), (items) => {
        const avg = calculateWeightedAverage(items, getValue, getWeight)!;
        const values = items.map(getValue);
        const min = Math.min(...values);
        const max = Math.max(...values);
        const eps = 1e-9 * (Math.abs(min) + Math.abs(max) + 1);
        expect(avg).toBeGreaterThanOrEqual(min - eps);
        expect(avg).toBeLessThanOrEqual(max + eps);
      }),
      RUN_OPTIONS,
    );
  });

  test("order invariance: exact with integer values and weights", () => {
    fc.assert(
      fc.property(withKeys(item, { minLength: 1, maxLength: 12 }), ({ items, keys }) => {
        const base = calculateWeightedAverage(items, getValue, getWeight);
        const permuted = calculateWeightedAverage(permuteBy(items, keys), getValue, getWeight);
        expect(permuted).toBe(base);
      }),
      RUN_OPTIONS,
    );
  });

  test("null cases: empty input and zero total weight", () => {
    expect(calculateWeightedAverage([], getValue, getWeight)).toBeNull();
    fc.assert(
      fc.property(fc.array(intValue, { minLength: 1, maxLength: 8 }), (values) => {
        const zeroWeighted = values.map((value) => ({ value, weight: 0 }));
        expect(calculateWeightedAverage(zeroWeighted, getValue, getWeight)).toBeNull();
      }),
      RUN_OPTIONS,
    );
  });

  test("null when nonzero weights cancel to a zero total (with a nonzero numerator)", () => {
    // The contract is total-weight === 0, not every-weight-zero and not weightedSum
    // === 0. Pair each +w with a -w on a DIFFERENT value so Σweight === 0 while
    // Σ(value·weight) stays nonzero — distinguishing a correct total-weight guard
    // from one that keys on the numerator.
    const pair = fc.record({ value: intValue, weight: fc.integer({ min: 1, max: 100 }) });
    fc.assert(
      fc.property(fc.array(pair, { minLength: 1, maxLength: 6 }), (items) => {
        const canceling = items.flatMap((i) => [
          { value: i.value, weight: i.weight },
          { value: i.value + 1, weight: -i.weight }, // different value → nonzero numerator
        ]);
        expect(calculateWeightedAverage(canceling, getValue, getWeight)).toBeNull();
      }),
      RUN_OPTIONS,
    );
  });
});

describe("empty-input null/undefined contracts", () => {
  test("median and mode are undefined for the empty array", () => {
    expect(calculateMedian([])).toBeUndefined();
    expect(calculateMode([])).toBeUndefined();
  });
});
