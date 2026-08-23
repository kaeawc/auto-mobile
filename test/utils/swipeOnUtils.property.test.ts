import { describe, test } from "bun:test";
import fc from "fast-check";
import { SwipeDirection } from "../../src/models";
import { resolveSwipeDirection, SCROLL_TO_FINGER_DIRECTION } from "../../src/utils/swipeOnUtils";

// Property-based tests. See Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;

const direction = fc.constantFrom<SwipeDirection>("up", "down", "left", "right");
const gestureType = fc.constantFrom(
  "swipeFingerTowardsDirection",
  "scrollTowardsDirection",
  undefined,
);

describe("SCROLL_TO_FINGER_DIRECTION (property-based)", () => {
  test("is an involution: inverting a scroll direction twice returns the original", () => {
    fc.assert(
      fc.property(
        direction,
        (d) => SCROLL_TO_FINGER_DIRECTION[SCROLL_TO_FINGER_DIRECTION[d]] === d,
      ),
      RUN_OPTIONS,
    );
  });

  test("has no fixed points: content direction and finger direction always differ", () => {
    fc.assert(
      fc.property(direction, (d) => SCROLL_TO_FINGER_DIRECTION[d] !== d),
      RUN_OPTIONS,
    );
  });

  test("is a permutation of the four directions (bijective)", () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        const images = (["up", "down", "left", "right"] as const).map(
          (d) => SCROLL_TO_FINGER_DIRECTION[d],
        );
        return new Set(images).size === 4;
      }),
      RUN_OPTIONS,
    );
  });
});

describe("resolveSwipeDirection (property-based)", () => {
  test("a finger gesture (or default) passes the direction through unchanged", () => {
    const fingerGesture = fc.constantFrom("swipeFingerTowardsDirection", undefined);
    fc.assert(
      fc.property(direction, fingerGesture, (d, gt) => {
        const result = resolveSwipeDirection({ direction: d, gestureType: gt });
        return (
          result.direction === d && result.error === undefined && typeof result.message === "string"
        );
      }),
      RUN_OPTIONS,
    );
  });

  test("a scroll gesture inverts the direction to finger movement", () => {
    fc.assert(
      fc.property(direction, (d) => {
        const result = resolveSwipeDirection({
          direction: d,
          gestureType: "scrollTowardsDirection",
        });
        return (
          result.direction === SCROLL_TO_FINGER_DIRECTION[d] &&
          result.error === undefined &&
          typeof result.message === "string"
        );
      }),
      RUN_OPTIONS,
    );
  });

  test("a resolved scroll direction is recoverable via the inverse map (round-trip)", () => {
    fc.assert(
      fc.property(direction, (d) => {
        const resolved = resolveSwipeDirection({
          direction: d,
          gestureType: "scrollTowardsDirection",
        }).direction!;
        return SCROLL_TO_FINGER_DIRECTION[resolved] === d;
      }),
      RUN_OPTIONS,
    );
  });

  test("a missing direction is always an error with no resolved direction", () => {
    fc.assert(
      fc.property(gestureType, (gt) => {
        const result = resolveSwipeDirection({
          direction: undefined as unknown as SwipeDirection,
          gestureType: gt,
        });
        return result.error === "direction is required" && result.direction === undefined;
      }),
      RUN_OPTIONS,
    );
  });

  test("resolution never throws for any direction/gestureType combination", () => {
    const anyGesture = fc.constantFrom(
      "swipeFingerTowardsDirection",
      "scrollTowardsDirection",
      undefined,
    );
    const anyDirection = fc.constantFrom<SwipeDirection | undefined>(
      "up",
      "down",
      "left",
      "right",
      undefined,
    );
    fc.assert(
      fc.property(anyDirection, anyGesture, (d, gt) => {
        resolveSwipeDirection({ direction: d as SwipeDirection, gestureType: gt });
        return true;
      }),
      RUN_OPTIONS,
    );
  });
});
