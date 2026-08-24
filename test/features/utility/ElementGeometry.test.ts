import { describe, expect, test, it } from "bun:test";
import { DefaultElementGeometry } from "../../../src/features/utility/ElementGeometry";
import type { Element } from "../../../src/models/Element";

function elementWithBounds(bounds: {
  left: number;
  top: number;
  right: number;
  bottom: number;
}): Element {
  return { bounds } as unknown as Element;
}

describe("ElementGeometry getSwipeWithinBounds", () => {
  test("uses element height for vertical swipe padding", () => {
    const geometry = new DefaultElementGeometry();
    const bounds = { left: 0, top: 378, right: 1000, bottom: 513 };

    const swipe = geometry.getSwipeWithinBounds("down", bounds);

    expect(swipe.startX).toBe(500);
    expect(swipe.endX).toBe(500);
    expect(swipe.startY).toBeCloseTo(391.5, 3);
    expect(swipe.endY).toBeCloseTo(499.5, 3);
  });

  test("uses element width for horizontal swipe padding", () => {
    const geometry = new DefaultElementGeometry();
    const bounds = { left: 800, top: 200, right: 1200, bottom: 600 };

    const swipe = geometry.getSwipeWithinBounds("left", bounds);

    expect(swipe.startY).toBe(400);
    expect(swipe.endY).toBe(400);
    expect(swipe.startX).toBe(1160);
    expect(swipe.endX).toBe(840);
  });
});

describe("ElementGeometry getSwipeDirectionForScroll", () => {
  const cases: Array<["up" | "down" | "left" | "right", "up" | "down" | "left" | "right"]> = [
    ["up", "down"],
    ["down", "up"],
    ["left", "right"],
    ["right", "left"],
  ];
  const geometry = new DefaultElementGeometry();
  it.each(cases)("scrolling %s swipes %s (inverse of content movement)", (scroll, expected) => {
    expect(geometry.getSwipeDirectionForScroll(scroll)).toBe(expected);
  });
});

describe("ElementGeometry getSwipeDurationFromSpeed", () => {
  const geometry = new DefaultElementGeometry();
  const cases: Array<[string, "slow" | "fast" | "normal" | undefined, number]> = [
    ["slow", "slow", 600],
    ["fast", "fast", 100],
    ["normal", "normal", 300],
    ["default (undefined)", undefined, 300],
  ];
  it.each(cases)("returns %s duration", (_name, speed, expected) => {
    expect(geometry.getSwipeDurationFromSpeed(speed)).toBe(expected);
  });
});

describe("ElementGeometry isElementVisible", () => {
  const geometry = new DefaultElementGeometry();
  const cases: Array<
    [string, { left: number; top: number; right: number; bottom: number }, boolean]
  > = [
    ["fully on screen", { left: 10, top: 10, right: 100, bottom: 100 }, true],
    ["partially clipped left edge", { left: -50, top: 10, right: 20, bottom: 100 }, true],
    ["entirely off the left edge", { left: -100, top: 10, right: 0, bottom: 100 }, false],
    ["entirely off the top edge", { left: 10, top: -100, right: 100, bottom: 0 }, false],
    ["entirely past the right edge", { left: 1080, top: 10, right: 1200, bottom: 100 }, false],
    ["entirely past the bottom edge", { left: 10, top: 1920, right: 100, bottom: 2000 }, false],
  ];
  it.each(cases)("%s", (_name, bounds, expected) => {
    expect(geometry.isElementVisible(elementWithBounds(bounds), 1080, 1920)).toBe(expected);
  });
});

describe("ElementGeometry getVisibleBounds", () => {
  const geometry = new DefaultElementGeometry();

  it("returns null for an off-screen element", () => {
    const bounds = { left: -100, top: 10, right: 0, bottom: 100 };
    expect(geometry.getVisibleBounds(elementWithBounds(bounds), 1080, 1920)).toBeNull();
  });

  it("clamps a partially off-screen element to the screen", () => {
    const bounds = { left: -50, top: -30, right: 1200, bottom: 2000 };
    expect(geometry.getVisibleBounds(elementWithBounds(bounds), 1080, 1920)).toEqual({
      left: 0,
      top: 0,
      right: 1080,
      bottom: 1920,
    });
  });

  it("returns the element bounds unchanged when fully on screen", () => {
    const bounds = { left: 10, top: 20, right: 100, bottom: 200 };
    expect(geometry.getVisibleBounds(elementWithBounds(bounds), 1080, 1920)).toEqual(bounds);
  });
});
