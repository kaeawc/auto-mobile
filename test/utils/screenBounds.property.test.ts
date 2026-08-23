import { describe, test } from "bun:test";
import fc from "fast-check";
import { getScreenBounds } from "../../src/utils/screenBounds";

// Property-based tests. See Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

const dimension = fc.integer({ min: 0, max: 8_000 });
const screenSize = fc.record({ width: dimension, height: dimension });
const inset = fc.integer({ min: 0, max: 8_000 });
const systemInsets = fc.record({ top: inset, right: inset, bottom: inset, left: inset });

describe("getScreenBounds (property-based)", () => {
  test("includeSystemInsets=true always yields the full screen, ignoring insets", () => {
    fc.assert(
      fc.property(screenSize, systemInsets, (size, insets) => {
        const bounds = getScreenBounds(size, insets, true);
        return (
          bounds.left === 0 &&
          bounds.top === 0 &&
          bounds.right === size.width &&
          bounds.bottom === size.height
        );
      }),
      RUN_OPTIONS,
    );
  });

  test("insets are irrelevant when included: two inset sets give the same bounds", () => {
    fc.assert(
      fc.property(screenSize, systemInsets, systemInsets, (size, a, b) => {
        const x = getScreenBounds(size, a, true);
        const y = getScreenBounds(size, b, true);
        return x.left === y.left && x.top === y.top && x.right === y.right && x.bottom === y.bottom;
      }),
      RUN_OPTIONS,
    );
  });

  test("null/omitted insets (not included) collapse to the full screen", () => {
    fc.assert(
      fc.property(screenSize, fc.constantFrom(null, undefined), (size, missingInsets) => {
        const bounds = getScreenBounds(size, missingInsets, false);
        return (
          bounds.left === 0 &&
          bounds.top === 0 &&
          bounds.right === size.width &&
          bounds.bottom === size.height
        );
      }),
      RUN_OPTIONS,
    );
  });

  test("insets that fit inside the screen produce a non-degenerate region", () => {
    // Bound each axis so left+right <= width and top+bottom <= height — the
    // realistic case where the visible content region is well-formed.
    const fittingCase = screenSize.chain((size) =>
      fc
        .record({
          size: fc.constant(size),
          insets: fc.record({
            left: fc.integer({ min: 0, max: size.width }),
            right: fc.integer({ min: 0, max: size.width }),
            top: fc.integer({ min: 0, max: size.height }),
            bottom: fc.integer({ min: 0, max: size.height }),
          }),
        })
        .filter(
          ({ insets }) =>
            insets.left + insets.right <= size.width && insets.top + insets.bottom <= size.height,
        ),
    );
    fc.assert(
      fc.property(fittingCase, ({ size, insets }) => {
        const b = getScreenBounds(size, insets, false);
        return (
          b.left >= 0 &&
          b.left <= b.right &&
          b.right <= size.width &&
          b.top >= 0 &&
          b.top <= b.bottom &&
          b.bottom <= size.height
        );
      }),
      RUN_OPTIONS,
    );
  });

  test("the right/bottom edges are monotonic non-increasing as the trailing insets grow", () => {
    fc.assert(
      fc.property(screenSize, systemInsets, inset, (size, base, delta) => {
        const smaller = getScreenBounds(size, base, false);
        const larger = getScreenBounds(
          size,
          { ...base, right: base.right + delta, bottom: base.bottom + delta },
          false,
        );
        return larger.right <= smaller.right && larger.bottom <= smaller.bottom;
      }),
      RUN_OPTIONS,
    );
  });
});
