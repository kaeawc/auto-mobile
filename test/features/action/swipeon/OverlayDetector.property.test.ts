import { describe, test } from "bun:test";
import fc from "fast-check";
import { OverlayDetector } from "../../../../src/features/action/swipeon/OverlayDetector";
import { DefaultElementGeometry } from "../../../../src/features/utility/ElementGeometry";
import type { ElementBounds } from "../../../../src/models";

// Property-based tests. See test/utils/Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

// `finder`/`elementParser` are unused by intersectBounds/computeSafeSwipeCoordinates,
// so minimal stubs are sufficient; `geometry` is the real implementation because
// computeSafeSwipeCoordinates delegates to its getSwipeWithinBounds.
const detector = new OverlayDetector({} as any, new DefaultElementGeometry(), {} as any);

// Arbitrary rectangles, allowing some degenerate/inverted ones (width/height <= 0)
// so intersectBounds's null-handling for non-overlapping/empty rects is exercised.
const rect: fc.Arbitrary<ElementBounds> = fc
  .record({
    left: fc.integer({ min: -500, max: 500 }),
    top: fc.integer({ min: -500, max: 500 }),
    width: fc.integer({ min: -100, max: 400 }),
    height: fc.integer({ min: -100, max: 400 }),
  })
  .map(({ left, top, width, height }) => ({
    left,
    top,
    right: left + width,
    bottom: top + height,
  }));

// A reasonably sized, always-valid container for computeSafeSwipeCoordinates.
const containerBounds: fc.Arbitrary<ElementBounds> = fc
  .record({
    left: fc.integer({ min: 0, max: 100 }),
    top: fc.integer({ min: 0, max: 100 }),
    width: fc.integer({ min: 100, max: 800 }),
    height: fc.integer({ min: 100, max: 800 }),
  })
  .map(({ left, top, width, height }) => ({
    left,
    top,
    right: left + width,
    bottom: top + height,
  }));

const direction = fc.constantFrom("up", "down", "left", "right") as fc.Arbitrary<
  "up" | "down" | "left" | "right"
>;
const overlays = fc.array(rect, { minLength: 0, maxLength: 4 });

describe("OverlayDetector (property-based)", () => {
  test("intersectBounds is commutative", () => {
    fc.assert(
      fc.property(rect, rect, (a, b) => {
        const ab = detector.intersectBounds(a, b);
        const ba = detector.intersectBounds(b, a);
        return JSON.stringify(ab) === JSON.stringify(ba);
      }),
      RUN_OPTIONS,
    );
  });

  test("a non-null intersectBounds result is contained within both inputs", () => {
    fc.assert(
      fc.property(rect, rect, (a, b) => {
        const result = detector.intersectBounds(a, b);
        if (!result) {
          return true;
        }
        return (
          result.left >= a.left &&
          result.right <= a.right &&
          result.top >= a.top &&
          result.bottom <= a.bottom &&
          result.left >= b.left &&
          result.right <= b.right &&
          result.top >= b.top &&
          result.bottom <= b.bottom
        );
      }),
      RUN_OPTIONS,
    );
  });

  test("intersectBounds is null exactly when the rectangles don't overlap with positive area", () => {
    fc.assert(
      fc.property(rect, rect, (a, b) => {
        const noOverlap =
          Math.min(a.right, b.right) <= Math.max(a.left, b.left) ||
          Math.min(a.bottom, b.bottom) <= Math.max(a.top, b.top);
        const result = detector.intersectBounds(a, b);

        if (noOverlap) {
          return result === null;
        }

        return result !== null && result.right > result.left && result.bottom > result.top;
      }),
      RUN_OPTIONS,
    );
  });

  test("computeSafeSwipeCoordinates keeps a non-null result within the container bounds", () => {
    fc.assert(
      fc.property(direction, containerBounds, overlays, (dir, bounds, overlayBounds) => {
        const result = detector.computeSafeSwipeCoordinates(dir, bounds, overlayBounds);
        if (!result) {
          return true;
        }

        return (
          result.startX >= bounds.left &&
          result.startX <= bounds.right &&
          result.endX >= bounds.left &&
          result.endX <= bounds.right &&
          result.startY >= bounds.top &&
          result.startY <= bounds.bottom &&
          result.endY >= bounds.top &&
          result.endY <= bounds.bottom
        );
      }),
      RUN_OPTIONS,
    );
  });

  test("computeSafeSwipeCoordinates never throws, including with empty or degenerate overlays", () => {
    fc.assert(
      fc.property(direction, containerBounds, overlays, (dir, bounds, overlayBounds) => {
        detector.computeSafeSwipeCoordinates(dir, bounds, overlayBounds);
        return true;
      }),
      RUN_OPTIONS,
    );
  });
});
