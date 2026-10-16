import { describe, expect, test } from "bun:test";
import {
  MULTI_TOUCH_DURATION_MAX_MS,
  MULTI_TOUCH_MAX_FINGERS,
  MULTI_TOUCH_MIN_FINGERS,
  planMultiTouch,
  validateMultiTouchOptions,
} from "../../../src/features/action/multiTouchGeometry";

const bounds = { width: 1000, height: 2000 };
const center = { x: 500, y: 1000 };

describe("planMultiTouch geometry (#12535)", () => {
  test.each([2, 3, 4, 5])("%d fingers sit in a row centered on the point", (fingers) => {
    const plan = planMultiTouch({ action: "tap", fingers, fingerSpacing: 100 }, center, bounds);
    if ("error" in plan) {
      throw new Error(plan.error);
    }
    expect(plan.points).toHaveLength(fingers);
    expect(plan.points.map((point) => point.x)).toEqual(
      Array.from({ length: fingers }, (_, i) => 500 - (fingers - 1) * 50 + i * 100),
    );
    expect(new Set(plan.points.map((point) => point.y))).toEqual(new Set([1000]));
    expect(plan.end).toEqual(plan.points[0]);
  });

  test("defaults: 2 fingers, 10% spacing clamped 40-160, tap 50 ms", () => {
    const plan = planMultiTouch({ action: "tap" }, center, bounds);
    expect(plan).toMatchObject({ fingers: 2, fingerSpacing: 100, durationMs: 50 });
    const narrow = planMultiTouch(
      { action: "tap" },
      { x: 100, y: 100 },
      { width: 300, height: 600 },
    );
    expect(narrow).toMatchObject({ fingerSpacing: 40 });
    const wide = planMultiTouch({ action: "longPress" }, center, { width: 5000, height: 2000 });
    expect(wide).toMatchObject({ fingerSpacing: 160, durationMs: 1000 });
  });

  test("the row shifts to stay on screen at either edge", () => {
    const left = planMultiTouch(
      { action: "tap", fingers: 3, fingerSpacing: 100 },
      { x: 0, y: 5 },
      bounds,
    );
    const right = planMultiTouch(
      { action: "tap", fingers: 3, fingerSpacing: 100 },
      { x: 999, y: 5 },
      bounds,
    );
    expect("error" in left || left.points.map((p) => p.x)).toEqual([0, 100, 200]);
    expect("error" in right || right.points.map((p) => p.x)).toEqual([799, 899, 999]);
  });

  test("a row wider than the screen is refused", () => {
    const plan = planMultiTouch({ action: "tap", fingers: 5, fingerSpacing: 300 }, center, bounds);
    expect(plan).toMatchObject({
      error: expect.stringContaining("reduce fingers or fingerSpacing"),
    });
  });

  test("swipe travels the default 30% of the axis in each direction", () => {
    const up = planMultiTouch(
      { action: "swipe", fingers: 3, direction: "up", fingerSpacing: 100 },
      center,
      bounds,
    );
    expect(up).toMatchObject({ end: { x: 400, y: 1000 - 600 }, durationMs: 300 });
    const down = planMultiTouch(
      { action: "swipe", direction: "down", fingerSpacing: 100 },
      center,
      bounds,
    );
    expect(down).toMatchObject({ end: { x: 450, y: 1600 } });
    const right = planMultiTouch(
      { action: "swipe", direction: "right", fingerSpacing: 100 },
      { x: 200, y: 500 },
      bounds,
    );
    expect(right).toMatchObject({ end: { x: 150 + 300, y: 500 } });
  });

  test("swipe distance is clamped so the farthest finger stays on screen", () => {
    const plan = planMultiTouch(
      { action: "swipe", fingers: 3, direction: "right", distance: 900, fingerSpacing: 100 },
      { x: 700, y: 500 },
      bounds,
    );
    if ("error" in plan) {
      throw new Error(plan.error);
    }
    // Row is 600/700/800; the last finger has 199 px left, so travel clamps to 199.
    expect(plan.end.x).toBe(600 + 199);
    expect(plan.warning).toContain("clamped from 900 to 199");
  });

  test("a swipe with almost no room is refused", () => {
    const plan = planMultiTouch(
      { action: "swipe", direction: "up", fingerSpacing: 100 },
      { x: 500, y: 5 },
      bounds,
    );
    expect(plan).toMatchObject({ error: expect.stringContaining("farther from that edge") });
  });
});

describe("validateMultiTouchOptions", () => {
  test("rejects finger counts outside 2-5 and non-integers", () => {
    for (const fingers of [0, 1, MULTI_TOUCH_MAX_FINGERS + 1, 2.5, -2]) {
      expect(validateMultiTouchOptions({ action: "tap", fingers })).toContain("fingers must be");
    }
    for (let fingers = MULTI_TOUCH_MIN_FINGERS; fingers <= MULTI_TOUCH_MAX_FINGERS; fingers++) {
      expect(validateMultiTouchOptions({ action: "tap", fingers })).toBeNull();
    }
  });

  test("swipe needs a direction; tap and longPress reject swipe-only fields", () => {
    expect(validateMultiTouchOptions({ action: "swipe" })).toContain("direction is required");
    expect(validateMultiTouchOptions({ action: "tap", direction: "up" })).toContain("only valid");
    expect(validateMultiTouchOptions({ action: "longPress", distance: 5 })).toContain("only valid");
  });

  test("duration bounds depend on the action", () => {
    expect(validateMultiTouchOptions({ action: "longPress", durationMs: 499 })).toContain(
      "durationMs",
    );
    expect(
      validateMultiTouchOptions({ action: "longPress", durationMs: MULTI_TOUCH_DURATION_MAX_MS }),
    ).toBeNull();
    expect(
      validateMultiTouchOptions({
        action: "longPress",
        durationMs: MULTI_TOUCH_DURATION_MAX_MS + 1,
      }),
    ).toContain("durationMs");
    expect(
      validateMultiTouchOptions({ action: "swipe", direction: "up", durationMs: 1 }),
    ).toBeNull();
    expect(validateMultiTouchOptions({ action: "tap", durationMs: 100 })).toContain(
      "not valid with action tap",
    );
    expect(validateMultiTouchOptions({ action: "tap", fingerSpacing: 5 })).toContain(
      "fingerSpacing",
    );
  });
});
