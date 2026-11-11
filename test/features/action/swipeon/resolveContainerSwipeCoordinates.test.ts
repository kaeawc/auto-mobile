import { identifyObservedHierarchy } from "../../../../src/features/observe/HierarchyCapture";
import {
  loadAndroidHomeObserve,
  loadIosRemindersNoiseObservePair,
} from "../../../fixtures/observe/observeFixture";
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
): ObserveResult => ({
  updatedAt: 0,
  observationId: "test",
  display: { key: "default", role: "unknown", posture: "unknown", generation: 0 },
  screenSize,
  systemInsets: insets,
  viewHierarchy: { hierarchy: {} },
});

const emptyHierarchy: ViewHierarchyResult = { hierarchy: {} };

const options = (direction: SwipeOnResolvedOptions["direction"]): SwipeOnResolvedOptions =>
  ({ direction }) as SwipeOnResolvedOptions;

describe("resolveContainerSwipeCoordinates system-inset math", () => {
  test("clamps bottom to the safe region, not container.bottom minus the inset", () => {
    // Partial-height list nowhere near the bottom inset: top=100, bottom=400 on a
    // 2000px-tall screen with a 126px bottom gesture bar. The safe boundary is
    // 2000 - 126 = 1874, well below the container, so the container should be
    // untouched. The old buggy math did min(400, 2000) - 126 = 274, chopping 126px.
    const result = resolveContainerSwipeCoordinates({
      geometry,
      overlayDetector: noOverlayAnalyzer,
      options: options("up"),
      viewHierarchy: emptyHierarchy,
      containerElement: containerElement(bounds(100, 100, 900, 400)),
      observeResult: observe(
        { width: 1000, height: 2000 },
        { top: 0, right: 0, bottom: 126, left: 0 },
      ),
    });

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
    const result = resolveContainerSwipeCoordinates({
      geometry,
      overlayDetector: noOverlayAnalyzer,
      options: options("right"),
      viewHierarchy: emptyHierarchy,
      containerElement: containerElement(bounds(300, 100, 350, 400)),
      observeResult: observe(
        { width: 1000, height: 2000 },
        { top: 0, right: 200, bottom: 0, left: 0 },
      ),
    });

    // A "right" swipe must go left -> right with non-negative extent.
    expect(result.endX).toBeGreaterThanOrEqual(result.startX);
    expect(result.startX).toBeGreaterThanOrEqual(300);
    expect(result.endX).toBeLessThanOrEqual(350);
  });

  test("still clamps to the safe region when the container overlaps the inset", () => {
    // Container extends into the bottom inset (bottom=1950 > safe 1874). The
    // effective bottom should be clamped to 1874, so the swipe stays out of the
    // gesture bar.
    const result = resolveContainerSwipeCoordinates({
      geometry,
      overlayDetector: noOverlayAnalyzer,
      options: options("down"),
      viewHierarchy: emptyHierarchy,
      containerElement: containerElement(bounds(100, 100, 900, 1950)),
      observeResult: observe(
        { width: 1000, height: 2000 },
        { top: 0, right: 0, bottom: 126, left: 0 },
      ),
    });

    // "down" ends at bottom - 10% of height; with bottom clamped to 1874 the end
    // must not reach into the inset region below 1874.
    expect(result.endY).toBeLessThanOrEqual(1874);
  });
});

describe("iOS chrome with unavailable system insets", () => {
  test("keeps a full-screen down swipe between the navigation bar and toolbar", () => {
    const fixture = loadIosRemindersNoiseObservePair().after;
    const viewHierarchy = fixture.viewHierarchy!;
    identifyObservedHierarchy("ios", viewHierarchy, "fresh");
    const observation = { ...fixture, systemInsets: { top: 0, right: 0, bottom: 0, left: 0 } };
    const result = resolveContainerSwipeCoordinates({
      geometry,
      overlayDetector: noOverlayAnalyzer,
      options: options("down"),
      viewHierarchy: viewHierarchy,
      containerElement: containerElement(bounds(0, 0, 393, 852)),
      observeResult: observation,
    });
    expect(result.startY).toBeGreaterThanOrEqual(104);
    expect(result.endY).toBeLessThanOrEqual(772);
  });
});

describe("chrome-free container intersection", () => {
  test("preserves Android fixture coordinates and observed insets", () => {
    const fixture = loadAndroidHomeObserve().observe;
    const container = containerElement(
      bounds(0, 0, fixture.screenSize.width, fixture.screenSize.height),
    );
    const observation = { ...fixture, systemInsets: { top: 0, right: 0, bottom: 0, left: 0 } };
    expect(
      resolveContainerSwipeCoordinates({
        geometry,
        overlayDetector: noOverlayAnalyzer,
        options: options("down"),
        viewHierarchy: fixture.viewHierarchy!,
        containerElement: container,
        observeResult: observation,
        platform: "android",
      }),
    ).toEqual(geometry.getSwipeWithinBounds("down", container.bounds));
  });
  test("preserves a partial iOS container entirely between the bars", () => {
    const fixture = loadIosRemindersNoiseObservePair().after;
    const container = containerElement(bounds(20, 150, 350, 600));
    expect(
      resolveContainerSwipeCoordinates({
        geometry,
        overlayDetector: noOverlayAnalyzer,
        options: options("down"),
        viewHierarchy: fixture.viewHierarchy!,
        containerElement: container,
        observeResult: { ...fixture, systemInsets: { top: 0, right: 0, bottom: 0, left: 0 } },
        platform: "ios",
      }),
    ).toEqual(geometry.getSwipeWithinBounds("down", container.bounds));
  });
  test("refuses a container with no chrome-free intersection", () => {
    const fixture = loadIosRemindersNoiseObservePair().after;
    expect(() =>
      resolveContainerSwipeCoordinates({
        geometry,
        overlayDetector: noOverlayAnalyzer,
        options: options("down"),
        viewHierarchy: fixture.viewHierarchy!,
        containerElement: containerElement(bounds(0, 59, 393, 104)),
        observeResult: { ...fixture, systemInsets: { top: 0, right: 0, bottom: 0, left: 0 } },
        platform: "ios",
      }),
    ).toThrow("no area outside iOS system chrome");
  });
});

describe("iOS drag-handle containers", () => {
  const handleInput = {
    geometry,
    overlayDetector: noOverlayAnalyzer,
    options: options("down"),
    viewHierarchy: emptyHierarchy,
    containerElement: containerElement(bounds(164, 617, 237, 641)),
    observeResult: observe({ width: 402, height: 874 }, { top: 0, right: 0, bottom: 0, left: 0 }),
    platform: "ios" as const,
  };

  test("drags the captured sheet grabber 240 points from its integer centre", () => {
    const result = resolveContainerSwipeCoordinates(handleInput);
    expect(result).toEqual({
      startX: 200,
      startY: 629,
      endX: 200,
      endY: 869,
      warning: expect.stringContaining("Container is only 24 pt along the swipe axis"),
    });
    expect(result.warning).toContain("travels 240 pt");
  });

  test.each([
    { direction: "up", b: bounds(164, 617, 237, 641), endX: 200, endY: 389 },
    { direction: "left", b: bounds(300, 617, 324, 641), endX: 72, endY: 629 },
    { direction: "right", b: bounds(60, 617, 84, 641), endX: 312, endY: 629 },
  ] as const)(
    "extends a thin container in the $direction direction",
    ({ direction, b, endX, endY }) => {
      const result = resolveContainerSwipeCoordinates({
        ...handleInput,
        options: options(direction),
        containerElement: containerElement(b),
      });
      expect(result).toMatchObject({
        startX: Math.floor((b.left + b.right) / 2),
        startY: Math.floor((b.top + b.bottom) / 2),
        endX,
        endY,
      });
    },
  );

  test.each([
    { direction: "down", b: bounds(164, 800, 237, 824), endX: 200, endY: 874 },
    { direction: "up", b: bounds(164, 50, 237, 74), endX: 200, endY: 0 },
    { direction: "right", b: bounds(328, 617, 352, 641), endX: 402, endY: 629 },
    { direction: "left", b: bounds(50, 617, 74, 641), endX: 0, endY: 629 },
  ] as const)(
    "clamps $direction travel and warns when fewer than 120 points remain",
    ({ direction, b, endX, endY }) => {
      const result = resolveContainerSwipeCoordinates({
        ...handleInput,
        options: options(direction),
        containerElement: containerElement(b),
      });
      expect(result).toMatchObject({ endX, endY });
      expect(result.warning).toContain("travels 62 pt");
      expect(result.warning).toContain("less than 120 pt");
    },
  );

  test("does not warn about short travel when clamping leaves exactly 120 points", () => {
    const result = resolveContainerSwipeCoordinates({
      ...handleInput,
      containerElement: containerElement(bounds(164, 742, 237, 766)),
    });
    expect(result.endY).toBe(874);
    expect(result.warning).toContain("travels 120 pt");
    expect(result.warning).not.toContain("less than 120 pt");
  });

  test("starts on the handle without consulting overlay candidates", () => {
    const result = resolveContainerSwipeCoordinates({
      ...handleInput,
      overlayDetector: {
        collectOverlayCandidates: () => {
          throw new Error("handle must bypass overlays");
        },
        computeSafeSwipeCoordinates: () => {
          throw new Error("handle must bypass overlays");
        },
      },
    });
    expect(result.endY).toBe(869);
  });

  test.each([48, 300])("preserves a %i point tall iOS container", (height) => {
    const b = bounds(164, 100, 237, 100 + height);
    expect(
      resolveContainerSwipeCoordinates({
        ...handleInput,
        containerElement: containerElement(b),
      }),
    ).toEqual(geometry.getSwipeWithinBounds("down", b));
  });

  test("uses extent along the swipe axis rather than the shortest side", () => {
    expect(
      resolveContainerSwipeCoordinates({
        ...handleInput,
        options: options("right"),
      }),
    ).toEqual(geometry.getSwipeWithinBounds("right", handleInput.containerElement.bounds));
  });

  test("preserves the captured 19 point swipe on Android", () => {
    expect(
      resolveContainerSwipeCoordinates({
        ...handleInput,
        platform: "android",
      }),
    ).toEqual({ startX: 200, startY: 619, endX: 200, endY: 638 });
  });

  test("measures the chrome-inset extent and starts at the exposed centre", () => {
    const result = resolveContainerSwipeCoordinates({
      ...handleInput,
      containerElement: containerElement(bounds(164, 30, 237, 100)),
      observeResult: observe(
        { width: 402, height: 874 },
        { top: 60, right: 0, bottom: 0, left: 0 },
      ),
    });
    expect(result).toMatchObject({ startX: 200, startY: 80, endX: 200, endY: 320 });
    expect(result.warning).toContain("Container is only 40 pt");
  });

  test("infers iOS from the observation and retains the chrome-start warning", () => {
    const observation = loadIosRemindersNoiseObservePair().after;
    identifyObservedHierarchy("ios", observation.viewHierarchy!, "fresh");
    const result = resolveContainerSwipeCoordinates({
      ...handleInput,
      platform: undefined,
      options: { ...options("down"), includeSystemInsets: true },
      viewHierarchy: observation.viewHierarchy!,
      observeResult: observation,
      containerElement: containerElement(bounds(164, 60, 237, 84)),
    });
    expect(result).toMatchObject({ startX: 200, startY: 72, endX: 200, endY: 312 });
    expect(result.warning).toContain("Container is only 24 pt");
    expect(result.warning).toContain("swipe started in the navigation bar");
  });
});
