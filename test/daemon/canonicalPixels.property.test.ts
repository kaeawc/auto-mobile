import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { roundHalfAwayFromZero } from "../../src/daemon/canonicalPixels";

// Property-based tests for the canonical-pixel rounding rule. A `coordinateSpace:"px"`
// frame is compared exactly, so a drift at the .5 boundary between hierarchy bounds and
// reported screenshot dimensions is a real correctness bug. The invariants below are
// deliberately ORACLE-FREE — asserting the defining properties of round-to-nearest-
// ties-away-from-zero rather than comparing to `Math.round(x + 0.5)`, whose own
// representation artifacts would make a disagreement ambiguous. See
// test/utils/Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

/** Arbitrary finite double (excludes NaN and ±Infinity, which are tested separately). */
const finite = fc.double({ noNaN: true, noDefaultInfinity: true });

describe("roundHalfAwayFromZero (property-based)", () => {
  test("result is always an integer", () => {
    fc.assert(
      fc.property(finite, (x) => Number.isInteger(roundHalfAwayFromZero(x))),
      RUN_OPTIONS,
    );
  });

  test("nearest: |round(x) - x| <= 0.5 (the defining round-to-nearest property)", () => {
    fc.assert(
      fc.property(finite, (x) => Math.abs(roundHalfAwayFromZero(x) - x) <= 0.5),
      RUN_OPTIONS,
    );
  });

  test("sign is preserved (or zero); never flips", () => {
    fc.assert(
      fc.property(finite, (x) => {
        const r = roundHalfAwayFromZero(x);
        return r === 0 || Math.sign(r) === Math.sign(x);
      }),
      RUN_OPTIONS,
    );
  });

  test("never returns negative zero", () => {
    fc.assert(
      fc.property(
        fc.oneof(finite, fc.constant(-0)),
        (x) => !Object.is(roundHalfAwayFromZero(x), -0),
      ),
      RUN_OPTIONS,
    );
  });

  test("idempotence: round(round(x)) === round(x)", () => {
    fc.assert(
      fc.property(finite, (x) => {
        const once = roundHalfAwayFromZero(x);
        return roundHalfAwayFromZero(once) === once;
      }),
      RUN_OPTIONS,
    );
  });

  // Exact ties, built from a non-negative magnitude base and a sign so the tie is
  // exactly at .5 (m + 0.5 is representable for m well below 2^52): magnitude m + 0.5
  // must round to magnitude m + 1, away from zero.
  test("exact .5 ties round away from zero", () => {
    const tie = fc
      .tuple(fc.nat({ max: 2 ** 30 }), fc.constantFrom(1, -1))
      .map(([m, sign]) => ({ x: sign * (m + 0.5), expectedMagnitude: m + 1 }));
    fc.assert(
      fc.property(tie, ({ x, expectedMagnitude }) => {
        return Math.abs(roundHalfAwayFromZero(x)) === expectedMagnitude;
      }),
      RUN_OPTIONS,
    );
  });

  test("non-finite values pass through unchanged", () => {
    expect(roundHalfAwayFromZero(Infinity)).toBe(Infinity);
    expect(roundHalfAwayFromZero(-Infinity)).toBe(-Infinity);
    expect(Number.isNaN(roundHalfAwayFromZero(NaN))).toBe(true);
  });
});
