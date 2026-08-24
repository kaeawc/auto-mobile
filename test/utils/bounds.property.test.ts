import { describe, test } from "bun:test";
import fc from "fast-check";
import { ElementBounds } from "../../src/models/ElementBounds";
import {
  boundsArea,
  boundsEqual,
  boundsNearlyEqual,
  clamp,
  isElementBounds,
  parseBounds,
  parseBoundsString,
} from "../../src/utils/bounds";

// Property-based testing proof-of-concept. See Backoff.property.test.ts for the
// rationale behind the pinned seed.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

// parseInt is exact for values in the safe-integer range, so bound coordinates
// there to keep the round-trip meaningful.
const coord = fc.integer({ min: -1_000_000, max: 1_000_000 });
const boundsArb: fc.Arbitrary<ElementBounds> = fc.record({
  left: coord,
  top: coord,
  right: coord,
  bottom: coord,
});

const formatBounds = (b: ElementBounds): string => `[${b.left},${b.top}][${b.right},${b.bottom}]`;

describe("bounds (property-based)", () => {
  test("parseBoundsString round-trips any formatted bounds", () => {
    fc.assert(
      fc.property(boundsArb, (b) => {
        const parsed = parseBoundsString(formatBounds(b));
        return parsed !== null && boundsEqual(parsed, b);
      }),
      RUN_OPTIONS,
    );
  });

  test("parseBounds never throws and returns null or valid bounds for arbitrary strings", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const result = parseBounds(s);
        return result === null || isElementBounds(result);
      }),
      RUN_OPTIONS,
    );
  });

  test("parseBounds passes through objects that already satisfy isElementBounds", () => {
    fc.assert(
      fc.property(boundsArb, (b) => parseBounds(b) === b),
      RUN_OPTIONS,
    );
  });

  test("boundsEqual is reflexive and symmetric", () => {
    fc.assert(
      fc.property(boundsArb, boundsArb, (a, b) => {
        const reflexive = boundsEqual(a, a) && boundsEqual(b, b);
        const symmetric = boundsEqual(a, b) === boundsEqual(b, a);
        return reflexive && symmetric;
      }),
      RUN_OPTIONS,
    );
  });

  test("boundsNearlyEqual is symmetric, reflexive at any epsilon, and monotonic in epsilon", () => {
    const epsilon = fc.integer({ min: 0, max: 5000 });
    fc.assert(
      fc.property(
        boundsArb,
        boundsArb,
        epsilon,
        fc.integer({ min: 0, max: 5000 }),
        (a, b, e1, delta) => {
          const symmetric = boundsNearlyEqual(a, b, e1) === boundsNearlyEqual(b, a, e1);
          const reflexive = boundsNearlyEqual(a, a, e1);
          // Widening epsilon can only ever keep or gain a match, never lose one.
          const monotonic = !boundsNearlyEqual(a, b, e1) || boundsNearlyEqual(a, b, e1 + delta);
          return symmetric && reflexive && monotonic;
        },
      ),
      RUN_OPTIONS,
    );
  });

  test("boundsArea is always non-negative", () => {
    fc.assert(
      fc.property(boundsArb, (b) => boundsArea(b) >= 0),
      RUN_OPTIONS,
    );
  });

  test("clamp keeps the value within [min, max] and is idempotent", () => {
    const range = fc
      .tuple(fc.integer({ min: -10_000, max: 10_000 }), fc.integer({ min: -10_000, max: 10_000 }))
      .map(([a, b]) => (a <= b ? [a, b] : [b, a]) as [number, number]);
    fc.assert(
      fc.property(
        fc.double({ min: -20_000, max: 20_000, noNaN: true }),
        range,
        (value, [min, max]) => {
          const once = clamp(value, min, max);
          const twice = clamp(once, min, max);
          return once >= min && once <= max && once === twice;
        },
      ),
      RUN_OPTIONS,
    );
  });

  test("clamp maps NaN to min", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -10_000, max: 10_000 }),
        fc.integer({ min: -10_000, max: 10_000 }),
        (a, b) => {
          const min = Math.min(a, b);
          const max = Math.max(a, b);
          return clamp(Number.NaN, min, max) === min;
        },
      ),
      RUN_OPTIONS,
    );
  });
});
