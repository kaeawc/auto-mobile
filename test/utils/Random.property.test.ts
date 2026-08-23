import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { CryptoRandom } from "../../src/utils/Random";

// Property-based tests. See Backoff.property.test.ts for the pinned-seed rationale.
//
// CryptoRandom draws from the crypto RNG and is intentionally NOT seedable, so
// the pinned fast-check seed makes only the *generated inputs* deterministic.
// Every property asserted here is invariant over the random draw itself (a value
// in [0, 1) always lands on a valid index), so the outcome never flakes.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

const nonEmptyArray = fc.array(fc.anything(), { minLength: 1, maxLength: 32 });

describe("CryptoRandom (property-based)", () => {
  test("next() always returns a value in [0, 1)", () => {
    fc.assert(
      // The generated integer is unused: it just drives 300 fresh draws.
      fc.property(fc.integer(), () => {
        const value = new CryptoRandom().next();
        return value >= 0 && value < 1;
      }),
      RUN_OPTIONS,
    );
  });

  test("pick() always returns a member of the input array", () => {
    fc.assert(
      fc.property(nonEmptyArray, (items) => items.includes(new CryptoRandom().pick(items))),
      RUN_OPTIONS,
    );
  });

  test("pick() from a single-element array returns that element", () => {
    fc.assert(
      // includes() uses SameValueZero so a NaN element still matches itself.
      fc.property(fc.anything(), (only) => [only].includes(new CryptoRandom().pick([only]))),
      RUN_OPTIONS,
    );
  });

  test("pick() from an empty array always throws", () => {
    const random = new CryptoRandom();
    fc.assert(
      fc.property(fc.constant(null), () => {
        expect(() => random.pick([])).toThrow(/empty array/);
        return true;
      }),
      RUN_OPTIONS,
    );
  });
});
