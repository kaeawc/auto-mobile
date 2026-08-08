import { describe, test } from "bun:test";
import fc from "fast-check";
import { calculateMedian, calculateMode, calculateWeightedAverage } from "../../../src/features/shared/MetricsUtils";

// Property-based tests. See test/utils/Backoff.property.test.ts for the
// pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

const finiteNumber = fc.double({ noNaN: true, noDefaultInfinity: true, min: -1e6, max: 1e6 });
const numberArray = fc.array(finiteNumber, { minLength: 1, maxLength: 50 });

describe("calculateMedian (property-based)", () => {
  test("permutation invariant: shuffling the input never changes the result", () => {
    fc.assert(
      fc.property(numberArray, values => {
        const original = calculateMedian(values);
        const reversed = calculateMedian([...values].reverse());
        return original === reversed;
      }),
      RUN_OPTIONS
    );
  });

  test("does not mutate its input array", () => {
    fc.assert(
      fc.property(numberArray, values => {
        const before = [...values];
        calculateMedian(values);
        return values.every((v, i) => Object.is(v, before[i]));
      }),
      RUN_OPTIONS
    );
  });

  test("bounded: the median always lies within [min, max] of the input", () => {
    fc.assert(
      fc.property(numberArray, values => {
        const median = calculateMedian(values);
        return median !== undefined && median >= Math.min(...values) && median <= Math.max(...values);
      }),
      RUN_OPTIONS
    );
  });

  test("empty array yields undefined (totality)", () => {
    fc.assert(fc.property(fc.constant([]), values => calculateMedian(values) === undefined), RUN_OPTIONS);
  });
});

describe("calculateMode (property-based)", () => {
  test("permutation invariant: shuffling the input never changes the frequency of the reported mode", () => {
    fc.assert(
      fc.property(numberArray, values => {
        const frequency = (target: number) => values.filter(v => v === target).length;
        const original = calculateMode(values);
        const reversed = calculateMode([...values].reverse());
        return original !== undefined && reversed !== undefined && frequency(original) === frequency(reversed);
      }),
      RUN_OPTIONS
    );
  });

  test("the reported mode is always a value present in the input", () => {
    fc.assert(
      fc.property(numberArray, values => {
        const mode = calculateMode(values);
        return mode !== undefined && values.includes(mode);
      }),
      RUN_OPTIONS
    );
  });

  test("no other value in the input occurs more often than the reported mode", () => {
    fc.assert(
      fc.property(numberArray, values => {
        const mode = calculateMode(values);
        if (mode === undefined) {
          return false;
        }
        const modeFreq = values.filter(v => v === mode).length;
        return values.every(v => values.filter(x => x === v).length <= modeFreq);
      }),
      RUN_OPTIONS
    );
  });
});

describe("calculateWeightedAverage (property-based)", () => {
  const item = fc.record({ value: finiteNumber, weight: fc.double({ min: 0.01, max: 1000, noNaN: true }) });
  const items = fc.array(item, { minLength: 1, maxLength: 50 });

  test("bounded: result always lies within [min(value), max(value)]", () => {
    fc.assert(
      fc.property(items, values => {
        const avg = calculateWeightedAverage(
          values,
          v => v.value,
          v => v.weight
        );
        const min = Math.min(...values.map(v => v.value));
        const max = Math.max(...values.map(v => v.value));
        return avg !== null && avg >= min - 1e-6 && avg <= max + 1e-6;
      }),
      RUN_OPTIONS
    );
  });

  test("equal weights reduce to the plain arithmetic mean", () => {
    fc.assert(
      fc.property(fc.array(finiteNumber, { minLength: 1, maxLength: 50 }), values => {
        const avg = calculateWeightedAverage(
          values,
          v => v,
          () => 1
        );
        const mean = values.reduce((a, b) => a + b, 0) / values.length;
        return avg !== null && Math.abs(avg - mean) < 1e-6;
      }),
      RUN_OPTIONS
    );
  });

  test("empty input yields null (totality)", () => {
    fc.assert(
      fc.property(
        fc.constant([]),
        values =>
          calculateWeightedAverage(
            values,
            (v: { value: number }) => v.value,
            (v: { weight: number }) => v.weight
          ) === null
      ),
      RUN_OPTIONS
    );
  });
});
