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

const finite = fc.double({ noNaN: true, noDefaultInfinity: true });

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
      fc.property(withKeys(finite, { minLength: 1, maxLength: 12 }), ({ items, keys }) => {
        expect(calculateMedian(permuteBy(items, keys))).toBe(calculateMedian(items));
      }),
      RUN_OPTIONS,
    );
  });

  test("non-mutation: the input array is unchanged", () => {
    fc.assert(
      fc.property(fc.array(finite, { minLength: 1, maxLength: 12 }), (values) => {
        const snapshot = [...values];
        calculateMedian(values);
        expect(values).toEqual(snapshot);
      }),
      RUN_OPTIONS,
    );
  });

  test("bounds: median lies within [min, max]", () => {
    fc.assert(
      fc.property(fc.array(finite, { minLength: 1, maxLength: 12 }), (values) => {
        const m = calculateMedian(values)!;
        expect(m).toBeGreaterThanOrEqual(Math.min(...values));
        expect(m).toBeLessThanOrEqual(Math.max(...values));
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
});

describe("empty-input null/undefined contracts", () => {
  test("median and mode are undefined for the empty array", () => {
    expect(calculateMedian([])).toBeUndefined();
    expect(calculateMode([])).toBeUndefined();
  });
});
