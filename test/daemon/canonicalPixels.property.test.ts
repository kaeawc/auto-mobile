import { describe, test } from "bun:test";
import fc from "fast-check";
import { roundHalfAwayFromZero } from "../../src/daemon/canonicalPixels";

// Property-based tests. See test/utils/Backoff.property.test.ts for the
// pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

const finiteNumber = fc.double({ noNaN: true, noDefaultInfinity: true, min: -1e9, max: 1e9 });

describe("roundHalfAwayFromZero (property-based)", () => {
  test("always returns an integer for finite input", () => {
    fc.assert(
      fc.property(finiteNumber, value => Number.isInteger(roundHalfAwayFromZero(value))),
      RUN_OPTIONS
    );
  });

  test("result is within 1 of the input (rounds, never truncates further)", () => {
    fc.assert(
      fc.property(finiteNumber, value => Math.abs(roundHalfAwayFromZero(value) - value) <= 1),
      RUN_OPTIONS
    );
  });

  test("sign is preserved for non-zero results, and -0 never appears", () => {
    fc.assert(
      fc.property(finiteNumber, value => {
        const result = roundHalfAwayFromZero(value);
        if (result === 0) {
          return !Object.is(result, -0);
        }
        return Math.sign(result) === Math.sign(value);
      }),
      RUN_OPTIONS
    );
  });

  test("idempotent: rounding an already-integer value is a no-op", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1_000_000_000, max: 1_000_000_000 }),
        value => roundHalfAwayFromZero(value) === value
      ),
      RUN_OPTIONS
    );
  });

  test("idempotent: re-rounding the output changes nothing (fixed point)", () => {
    fc.assert(
      fc.property(finiteNumber, value => {
        const once = roundHalfAwayFromZero(value);
        return roundHalfAwayFromZero(once) === once;
      }),
      RUN_OPTIONS
    );
  });

  test("exact .5 ties (integer + 0.5) round away from zero", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        base => {
          const value = base >= 0 ? base + 0.5 : base - 0.5;
          const expected = base >= 0 ? base + 1 : base - 1;
          return roundHalfAwayFromZero(value) === expected;
        }
      ),
      RUN_OPTIONS
    );
  });

  test("non-finite input passes through unchanged", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(Infinity, -Infinity, NaN),
        value => {
          const result = roundHalfAwayFromZero(value);
          return Number.isNaN(value) ? Number.isNaN(result) : result === value;
        }
      ),
      RUN_OPTIONS
    );
  });
});
