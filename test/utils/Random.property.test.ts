import { beforeAll, describe, expect, test } from "bun:test";
import fc from "fast-check";
import { CryptoRandom } from "../../src/utils/Random";

// Property-based tests. See Backoff.property.test.ts for the pinned-seed rationale.
//
// CryptoRandom draws from the crypto RNG and is intentionally NOT seedable, so
// the pinned fast-check seed makes only the *generated inputs* deterministic.
// Every property asserted here is invariant over the random draw itself (a value
// in [0, 1) always lands on a valid index), so the outcome never flakes.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

// Array inputs cost far more to generate than scalar ones, and `pick()` depends
// on nothing but the array's LENGTH, so a third of the runs covers the same
// index range for a third of the work. A 300-run array property was measured at
// 101.76ms on a loaded CI runner and turned Node Unit Tests red (issue #6837).
const ARRAY_RUN_OPTIONS = { seed: 1_234_567, numRuns: 100 } as const;

// Index selection only depends on array length, but these values retain the
// SameValueZero and object-identity cases without recursively generating data.
const representativeObject = { kind: "object" };
const representativeArray = ["array"];
const representativeValue = fc.constantFrom<unknown>(
  undefined,
  null,
  false,
  true,
  -1,
  0,
  1,
  Number.NaN,
  "",
  "value",
  representativeObject,
  representativeArray,
);
const nonEmptyArray = fc.array(representativeValue, { minLength: 1, maxLength: 32 });

describe("CryptoRandom (property-based)", () => {
  // fast-check's runner, its arbitraries, and Bun's module/JIT paths all warm up
  // on the first assertion in the process. Paying that here makes it fixture
  // work the JUnit reporter excludes, instead of billing whichever property
  // happens to run first — which is how a ~3ms property measured 101.76ms when
  // the timing gate re-ran it alone (issue #6837).
  beforeAll(() => {
    fc.assert(
      fc.property(nonEmptyArray, (items) => items.length > 0),
      { seed: 1_234_567, numRuns: 5 },
    );
  });

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
      ARRAY_RUN_OPTIONS,
    );
  });

  test("pick() from a single-element array returns that element", () => {
    fc.assert(
      // includes() uses SameValueZero so a NaN element still matches itself.
      fc.property(representativeValue, (only) => [only].includes(new CryptoRandom().pick([only]))),
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
