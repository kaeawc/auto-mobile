import { describe, test } from "bun:test";
import fc from "fast-check";
import { DefaultElementGeometry } from "../../../src/features/utility/ElementGeometry";
import type { Element } from "../../../src/models/Element";
import type { ElementBounds } from "../../../src/models/ElementBounds";

// Property-based tests for the pure gesture-geometry helpers. See
// Backoff.property.test.ts for the pinned-seed rationale: the same generated
// cases run every CI invocation, so a counterexample is reproducible.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

const geometry = new DefaultElementGeometry();

const elementWithBounds = (bounds: ElementBounds): Element => ({ bounds }) as unknown as Element;

// Integer coordinates in the safe range; `left <= right` and `top <= bottom`
// so every generated rectangle is non-inverted (the shape all callers pass).
const validBounds: fc.Arbitrary<ElementBounds> = fc
  .tuple(
    fc.integer({ min: -5000, max: 5000 }),
    fc.integer({ min: -5000, max: 5000 }),
    fc.integer({ min: 0, max: 10_000 }),
    fc.integer({ min: 0, max: 10_000 }),
  )
  .map(([x1, y1, w, h]) => ({ left: x1, top: y1, right: x1 + w, bottom: y1 + h }));

// Strictly positive width AND height, so directional swipes make real progress.
const nonDegenerateBounds: fc.Arbitrary<ElementBounds> = fc
  .tuple(
    fc.integer({ min: -5000, max: 5000 }),
    fc.integer({ min: -5000, max: 5000 }),
    fc.integer({ min: 1, max: 10_000 }),
    fc.integer({ min: 1, max: 10_000 }),
  )
  .map(([x1, y1, w, h]) => ({ left: x1, top: y1, right: x1 + w, bottom: y1 + h }));

const direction = fc.constantFrom<"up" | "down" | "left" | "right">("up", "down", "left", "right");

const within = (v: number, lo: number, hi: number): boolean => v >= lo && v <= hi;

describe("DefaultElementGeometry.getElementCenter (property-based)", () => {
  test("center lies within the element's own bounds", () => {
    fc.assert(
      fc.property(validBounds, (b) => {
        const c = geometry.getElementCenter(elementWithBounds(b));
        return within(c.x, b.left, b.right) && within(c.y, b.top, b.bottom);
      }),
      RUN_OPTIONS,
    );
  });

  test("the center point is always classified as inside the element", () => {
    fc.assert(
      fc.property(validBounds, (b) => {
        const el = elementWithBounds(b);
        const c = geometry.getElementCenter(el);
        return geometry.isPointInElement(el, c.x, c.y);
      }),
      RUN_OPTIONS,
    );
  });
});

describe("DefaultElementGeometry.isPointInElement (property-based)", () => {
  test("all four corners are inclusive-inside", () => {
    fc.assert(
      fc.property(validBounds, (b) => {
        const el = elementWithBounds(b);
        return (
          geometry.isPointInElement(el, b.left, b.top) &&
          geometry.isPointInElement(el, b.right, b.bottom) &&
          geometry.isPointInElement(el, b.left, b.bottom) &&
          geometry.isPointInElement(el, b.right, b.top)
        );
      }),
      RUN_OPTIONS,
    );
  });

  test("a point strictly outside any edge is rejected", () => {
    fc.assert(
      fc.property(validBounds, (b) => {
        const el = elementWithBounds(b);
        return (
          !geometry.isPointInElement(el, b.left - 1, b.top) &&
          !geometry.isPointInElement(el, b.right + 1, b.top) &&
          !geometry.isPointInElement(el, b.left, b.top - 1) &&
          !geometry.isPointInElement(el, b.left, b.bottom + 1)
        );
      }),
      RUN_OPTIONS,
    );
  });
});

describe("DefaultElementGeometry.getVisibleBounds (property-based)", () => {
  const screen = fc.tuple(fc.integer({ min: 1, max: 4000 }), fc.integer({ min: 1, max: 4000 }));

  test("returns null exactly when the element is not visible", () => {
    fc.assert(
      fc.property(validBounds, screen, (b, [w, h]) => {
        const el = elementWithBounds(b);
        const visible = geometry.getVisibleBounds(el, w, h);
        return (visible === null) === !geometry.isElementVisible(el, w, h);
      }),
      RUN_OPTIONS,
    );
  });

  test("a non-null visible region is clamped to the screen and is a sub-rect of the element", () => {
    fc.assert(
      fc.property(validBounds, screen, (b, [w, h]) => {
        const visible = geometry.getVisibleBounds(elementWithBounds(b), w, h);
        if (visible === null) {
          return true;
        }
        const onScreen =
          visible.left >= 0 && visible.top >= 0 && visible.right <= w && visible.bottom <= h;
        const subRect =
          visible.left >= b.left &&
          visible.top >= b.top &&
          visible.right <= b.right &&
          visible.bottom <= b.bottom;
        // Clamping a valid, visible rect can never invert it.
        const nonInverted = visible.left <= visible.right && visible.top <= visible.bottom;
        return onScreen && subRect && nonInverted;
      }),
      RUN_OPTIONS,
    );
  });
});

describe("DefaultElementGeometry.getSwipeWithinBounds (property-based)", () => {
  test("every swipe endpoint stays within the container bounds", () => {
    fc.assert(
      fc.property(validBounds, direction, (b, d) => {
        const s = geometry.getSwipeWithinBounds(d, b);
        return (
          within(s.startX, b.left, b.right) &&
          within(s.endX, b.left, b.right) &&
          within(s.startY, b.top, b.bottom) &&
          within(s.endY, b.top, b.bottom)
        );
      }),
      RUN_OPTIONS,
    );
  });

  test("vertical swipes hold X constant; horizontal swipes hold Y constant", () => {
    fc.assert(
      fc.property(validBounds, direction, (b, d) => {
        const s = geometry.getSwipeWithinBounds(d, b);
        const vertical = d === "up" || d === "down";
        return vertical ? s.startX === s.endX : s.startY === s.endY;
      }),
      RUN_OPTIONS,
    );
  });

  test("the finger moves in the requested direction (non-degenerate bounds)", () => {
    fc.assert(
      fc.property(nonDegenerateBounds, direction, (b, d) => {
        const s = geometry.getSwipeWithinBounds(d, b);
        switch (d) {
          case "up":
            // Finger travels toward the top => decreasing Y.
            return s.endY < s.startY;
          case "down":
            return s.endY > s.startY;
          case "left":
            // Finger travels toward the left edge => decreasing X.
            return s.endX < s.startX;
          case "right":
            return s.endX > s.startX;
        }
      }),
      RUN_OPTIONS,
    );
  });
});

describe("DefaultElementGeometry.getSwipeDirectionForScroll (property-based)", () => {
  test("is an involution with no fixed points", () => {
    fc.assert(
      fc.property(direction, (d) => {
        const once = geometry.getSwipeDirectionForScroll(d);
        return geometry.getSwipeDirectionForScroll(once) === d && once !== d;
      }),
      RUN_OPTIONS,
    );
  });

  test("maps the four directions bijectively onto themselves", () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const images = (["up", "down", "left", "right"] as const).map((d) =>
          geometry.getSwipeDirectionForScroll(d),
        );
        return new Set(images).size === 4;
      }),
      RUN_OPTIONS,
    );
  });
});

describe("DefaultElementGeometry.getSwipeDurationFromSpeed (property-based)", () => {
  test("duration is strictly ordered fast < normal < slow", () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const fast = geometry.getSwipeDurationFromSpeed("fast");
        const normal = geometry.getSwipeDurationFromSpeed("normal");
        const slow = geometry.getSwipeDurationFromSpeed("slow");
        return fast > 0 && fast < normal && normal < slow;
      }),
      RUN_OPTIONS,
    );
  });
});
