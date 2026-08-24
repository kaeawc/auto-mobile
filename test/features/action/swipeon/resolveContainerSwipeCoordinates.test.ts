import { describe, expect, test } from "bun:test";
import { resolveContainerSwipeCoordinates } from "../../../../src/features/action/swipeon/resolveContainerSwipeCoordinates";
import { DefaultElementGeometry } from "../../../../src/features/utility/ElementGeometry";
import type {
  OverlayAnalyzer,
  SwipeOnResolvedOptions,
} from "../../../../src/features/action/swipeon/types";
import type {
  Element,
  ElementBounds,
  ObserveResult,
  ViewHierarchyResult,
} from "../../../../src/models";

// No-overlay analyzer so resolveContainerSwipeCoordinates returns the default
// (inset-clamped) swipe straight from getSwipeWithinBounds — this is the path
// that carries the system-inset math under test.
const noOverlayAnalyzer: OverlayAnalyzer = {
  collectOverlayCandidates: () => [],
  computeSafeSwipeCoordinates: () => null,
};

const geometry = new DefaultElementGeometry();

const bounds = (left: number, top: number, right: number, bottom: number): ElementBounds => ({
  left,
  top,
  right,
  bottom,
});

const containerElement = (b: ElementBounds): Element => ({ bounds: b }) as Element;

const observe = (
  screenSize: { width: number; height: number },
  insets: { top: number; right: number; bottom: number; left: number },
): ObserveResult =>
  ({
    timestamp: 0,
    screenSize,
    systemInsets: insets,
    viewHierarchy: { hierarchy: {} } as unknown as ViewHierarchyResult,
  }) as ObserveResult;

const emptyHierarchy = { hierarchy: {} } as unknown as ViewHierarchyResult;

const options = (direction: SwipeOnResolvedOptions["direction"]): SwipeOnResolvedOptions =>
  ({ direction }) as SwipeOnResolvedOptions;

describe("resolveContainerSwipeCoordinates system-inset math", () => {
  test("clamps bottom to the safe region, not container.bottom minus the inset", () => {
    // Partial-height list nowhere near the bottom inset: top=100, bottom=400 on a
    // 2000px-tall screen with a 126px bottom gesture bar. The safe boundary is
    // 2000 - 126 = 1874, well below the container, so the container should be
    // untouched. The old buggy math did min(400, 2000) - 126 = 274, chopping 126px.
    const result = resolveContainerSwipeCoordinates(
      geometry,
      noOverlayAnalyzer,
      options("up"),
      emptyHierarchy,
      containerElement(bounds(100, 100, 900, 400)),
      observe({ width: 1000, height: 2000 }, { top: 0, right: 0, bottom: 126, left: 0 }),
    );

    // With effective bounds == container bounds, an "up" swipe stays within [100, 400].
    expect(result.startY).toBeLessThanOrEqual(400);
    expect(result.endY).toBeGreaterThanOrEqual(100);
    // The lost-126px bug would have shrunk the region to [100, 274]; assert we
    // still swipe below that ceiling.
    expect(result.startY).toBeGreaterThan(274);
  });

  test("does not invert bounds for a narrow left-positioned container with a large right inset", () => {
    // left=300, right=350 container with a 200px right inset. The old math did
    // min(350, 1000) - 200 = 150, which is < left (300): inverted bounds ->
    // negative-width swipe. The safe boundary 1000 - 200 = 800 is far right of
    // the container, so the container's own right edge should win.
    const result = resolveContainerSwipeCoordinates(
      geometry,
      noOverlayAnalyzer,
      options("right"),
      emptyHierarchy,
      containerElement(bounds(300, 100, 350, 400)),
      observe({ width: 1000, height: 2000 }, { top: 0, right: 200, bottom: 0, left: 0 }),
    );

    // A "right" swipe must go left -> right with non-negative extent.
    expect(result.endX).toBeGreaterThanOrEqual(result.startX);
    expect(result.startX).toBeGreaterThanOrEqual(300);
    expect(result.endX).toBeLessThanOrEqual(350);
  });

  test("still clamps to the safe region when the container overlaps the inset", () => {
    // Container extends into the bottom inset (bottom=1950 > safe 1874). The
    // effective bottom should be clamped to 1874, so the swipe stays out of the
    // gesture bar.
    const result = resolveContainerSwipeCoordinates(
      geometry,
      noOverlayAnalyzer,
      options("down"),
      emptyHierarchy,
      containerElement(bounds(100, 100, 900, 1950)),
      observe({ width: 1000, height: 2000 }, { top: 0, right: 0, bottom: 126, left: 0 }),
    );

    // "down" ends at bottom - 10% of height; with bottom clamped to 1874 the end
    // must not reach into the inset region below 1874.
    expect(result.endY).toBeLessThanOrEqual(1874);
  });
});
