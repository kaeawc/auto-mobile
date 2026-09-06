import { describe, test, expect } from "bun:test";
import fc from "fast-check";
import { GestureClassifier } from "../../../../src/features/record/android/GestureClassifier";
import { GESTURE_THRESHOLDS } from "../../../../src/features/record/android/types";
import type { RawTouchFrame } from "../../../../src/features/record/android/types";
import type { CoordScaler } from "../../../../src/features/record/android/AxisRanges";

// Property-based tests for GestureClassifier's pure classification geometry.
// The example-based suite (GestureClassifier.test.ts) pins specific gestures;
// these assert the invariants the classifier *promises* over the whole input
// space: the tap/longPress/swipe partition, direction derivation, pinch
// scale/direction agreement, and the guard that a completed gesture never
// carries a non-finite number. See Backoff.property.test.ts / ElementGeometry
// .property.test.ts for the pinned-seed rationale — the same generated cases
// run every CI invocation, so any counterexample is reproducible.
const RUN_OPTIONS = { seed: 0x6e_57_1a_2f, numRuns: 400 } as const;

// Identity scaler: raw sensor coordinates == logical screen pixels, so the
// test can reason about geometry in a single coordinate space.
const identityScaler: CoordScaler = {
  toScreenX: (x: number) => x,
  toScreenY: (y: number) => y,
};

function makeFrame(
  arrivedAt: number,
  activeSlots: Array<{ slotId: number; trackingId: number; x: number; y: number }>,
  releasedSlots: number[] = [],
): RawTouchFrame {
  return {
    arrivedAt,
    activeSlots: activeSlots.map((s) => ({ ...s, pressure: 0 })),
    releasedSlots,
  };
}

const dist = (x1: number, y1: number, x2: number, y2: number): number =>
  Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);

// Density in the range real Android screens report (mdpi..xxxhdpi ≈ 1..4).
const density = fc.integer({ min: 10, max: 40 }).map((d) => d / 10);
const coord = fc.integer({ min: 0, max: 2000 });

/**
 * Drive a single finger through DOWN → (optional MOVE) → UP against a fresh
 * classifier and return the completed gesture. A fresh classifier means
 * `lastTap` is null, so a low-displacement short contact can only be a `tap`,
 * never a `doubleTap`.
 */
function singleFinger(
  d: number,
  down: { x: number; y: number },
  up: { x: number; y: number },
  durationMs: number,
) {
  const c = new GestureClassifier(identityScaler, d);
  c.feedFrame(makeFrame(0, [{ slotId: 0, trackingId: 1, x: down.x, y: down.y }]));
  c.feedFrame(makeFrame(1, [{ slotId: 0, trackingId: 1, x: up.x, y: up.y }]));
  return c.feedFrame(makeFrame(durationMs, [], [0]));
}

/** Drive two fingers through DOWN → MOVE → simultaneous UP against a fresh classifier. */
function twoFinger(
  d: number,
  a0: { x: number; y: number },
  b0: { x: number; y: number },
  a1: { x: number; y: number },
  b1: { x: number; y: number },
) {
  const c = new GestureClassifier(identityScaler, d);
  c.feedFrame(
    makeFrame(0, [
      { slotId: 0, trackingId: 1, x: a0.x, y: a0.y },
      { slotId: 1, trackingId: 2, x: b0.x, y: b0.y },
    ]),
  );
  c.feedFrame(
    makeFrame(100, [
      { slotId: 0, trackingId: 1, x: a1.x, y: a1.y },
      { slotId: 1, trackingId: 2, x: b1.x, y: b1.y },
    ]),
  );
  return c.feedFrame(makeFrame(200, [], [0, 1]));
}

describe("GestureClassifier (property-based)", () => {
  // -------------------------------------------------------------------------
  // Single-finger classification partition
  // -------------------------------------------------------------------------

  test("a zero-displacement contact is a tap iff short, a longPress iff long", () => {
    fc.assert(
      fc.property(
        density,
        coord,
        coord,
        fc.integer({ min: 0, max: 3000 }),
        (d, x, y, durationMs) => {
          // start == end ⇒ displacement 0 < slop for every positive density,
          // so the swipe branch is never taken and classification hinges only
          // on duration vs LONG_PRESS_MS.
          const g = singleFinger(d, { x, y }, { x, y }, durationMs);
          if (durationMs >= GESTURE_THRESHOLDS.LONG_PRESS_MS) {
            expect(g?.type).toBe("longPress");
            expect(g?.durationMs).toBe(durationMs);
          } else {
            expect(g?.type).toBe("tap");
          }
          // Tap-family coordinates round-trip through the identity scaler.
          expect(g?.screenX).toBe(x);
          expect(g?.screenY).toBe(y);
        },
      ),
      RUN_OPTIONS,
    );
  });

  test("a contact whose displacement clears touch-slop is always a swipe", () => {
    fc.assert(
      fc.property(
        density,
        coord,
        coord,
        // Offsets large enough that displacement > slop for the whole density
        // range: max slop = TOUCH_SLOP_DP(8) * 4 = 32px, and requiring one axis
        // >= 40 forces displacement >= 40 > 32.
        fc.integer({ min: -1500, max: 1500 }),
        fc.integer({ min: -1500, max: 1500 }),
        fc.integer({ min: 1, max: 5000 }),
        (d, x, y, dx, dy, durationMs) => {
          fc.pre(Math.max(Math.abs(dx), Math.abs(dy)) >= 40);
          const upX = Math.min(Math.max(x + dx, 0), 4000);
          const upY = Math.min(Math.max(y + dy, 0), 4000);
          // Recompute the real offset after clamping so the geometry assertions
          // below reason about what the classifier actually saw.
          const realDx = upX - x;
          const realDy = upY - y;
          fc.pre(dist(x, y, upX, upY) >= 40);

          const g = singleFinger(d, { x, y }, { x: upX, y: upY }, durationMs);
          expect(g?.type).toBe("swipe");
          expect(g?.startX).toBe(x);
          expect(g?.startY).toBe(y);
          expect(g?.endX).toBe(upX);
          expect(g?.endY).toBe(upY);

          // Direction: dominant axis wins, ties go horizontal (mirrors the impl).
          const expected =
            Math.abs(realDx) >= Math.abs(realDy)
              ? realDx > 0
                ? "right"
                : "left"
              : realDy > 0
                ? "down"
                : "up";
          expect(g?.direction).toBe(expected);

          // Speed threshold agrees with the velocity formula.
          const displacement = dist(x, y, upX, upY);
          const velocity = durationMs > 0 ? (displacement / durationMs) * 1000 : 0;
          const flingThreshPx = GESTURE_THRESHOLDS.FLING_MIN_DP_PER_S * d;
          expect(g?.speed).toBe(velocity >= flingThreshPx ? "fast" : "normal");
        },
      ),
      RUN_OPTIONS,
    );
  });

  test("a completed single-finger contact is never null and never a two-finger type", () => {
    fc.assert(
      fc.property(
        density,
        coord,
        coord,
        coord,
        coord,
        fc.integer({ min: 0, max: 3000 }),
        (d, x0, y0, x1, y1, durationMs) => {
          const g = singleFinger(d, { x: x0, y: y0 }, { x: x1, y: y1 }, durationMs);
          expect(g).not.toBeNull();
          expect(["tap", "longPress", "swipe"]).toContain(g?.type);
        },
      ),
      RUN_OPTIONS,
    );
  });

  // -------------------------------------------------------------------------
  // Two-finger (pinch) invariants
  // -------------------------------------------------------------------------

  test("an emitted pinch reports scale == final/initial and a direction agreeing with it", () => {
    fc.assert(
      fc.property(
        density,
        coord,
        coord,
        coord,
        coord,
        coord,
        coord,
        coord,
        coord,
        (d, ax0, ay0, bx0, by0, ax1, ay1, bx1, by1) => {
          const initialDist = dist(ax0, ay0, bx0, by0);
          const finalDist = dist(ax1, ay1, bx1, by1);
          fc.pre(initialDist > 0);
          const scale = finalDist / initialDist;
          // Only cases the classifier will actually emit: a meaningful scale change.
          fc.pre(Math.abs(scale - 1) >= GESTURE_THRESHOLDS.PINCH_MIN_SCALE_DELTA);

          const g = twoFinger(
            d,
            { x: ax0, y: ay0 },
            { x: bx0, y: by0 },
            { x: ax1, y: ay1 },
            { x: bx1, y: by1 },
          );
          expect(g?.type).toBe("pinch");
          expect(Number.isFinite(g?.scale)).toBe(true);
          expect(g!.scale!).toBeGreaterThan(0);
          expect(g!.scale!).toBeCloseTo(scale, 6);
          expect(g?.pinchDirection).toBe(scale < 1 ? "in" : "out");
        },
      ),
      RUN_OPTIONS,
    );
  });

  test("two fingers starting coincident never emit a non-finite scale (divide-by-zero guard)", () => {
    fc.assert(
      fc.property(
        density,
        coord,
        coord,
        coord,
        coord,
        coord,
        coord,
        (d, px, py, ax1, ay1, bx1, by1) => {
          // Both fingers begin at the same point ⇒ initialDist === 0. The guard
          // must suppress the pinch rather than emit scale = n/0 = Infinity.
          const g = twoFinger(
            d,
            { x: px, y: py },
            { x: px, y: py },
            { x: ax1, y: ay1 },
            { x: bx1, y: by1 },
          );
          expect(g).toBeNull();
        },
      ),
      RUN_OPTIONS,
    );
  });

  test("a two-finger sequence only ever emits a pinch or nothing — never a single-finger type", () => {
    fc.assert(
      fc.property(
        density,
        coord,
        coord,
        coord,
        coord,
        coord,
        coord,
        coord,
        coord,
        (d, ax0, ay0, bx0, by0, ax1, ay1, bx1, by1) => {
          const g = twoFinger(
            d,
            { x: ax0, y: ay0 },
            { x: bx0, y: by0 },
            { x: ax1, y: ay1 },
            { x: bx1, y: by1 },
          );
          if (g !== null) {
            expect(g.type).toBe("pinch");
          }
        },
      ),
      RUN_OPTIONS,
    );
  });

  // -------------------------------------------------------------------------
  // Umbrella guard: no completed gesture ever carries a non-finite number.
  // -------------------------------------------------------------------------

  test("no emitted gesture's numeric fields are ever non-finite", () => {
    const finiteOrAbsent = (v: number | undefined): boolean =>
      v === undefined || Number.isFinite(v);
    fc.assert(
      fc.property(
        density,
        coord,
        coord,
        coord,
        coord,
        fc.integer({ min: 0, max: 5000 }),
        (d, x0, y0, x1, y1, durationMs) => {
          const g = singleFinger(d, { x: x0, y: y0 }, { x: x1, y: y1 }, durationMs);
          if (g === null) {
            return true;
          }
          return (
            finiteOrAbsent(g.screenX) &&
            finiteOrAbsent(g.screenY) &&
            finiteOrAbsent(g.startX) &&
            finiteOrAbsent(g.startY) &&
            finiteOrAbsent(g.endX) &&
            finiteOrAbsent(g.endY) &&
            finiteOrAbsent(g.durationMs) &&
            finiteOrAbsent(g.scale)
          );
        },
      ),
      RUN_OPTIONS,
    );
  });
});
