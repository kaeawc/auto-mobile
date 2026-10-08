import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { SwipeOn } from "../../../../src/features/action/swipeon/SwipeOn";
import { AutoTargetSelector } from "../../../../src/features/action/swipeon/AutoTargetSelector";
import type { AutoTargetSelectorService } from "../../../../src/features/action/swipeon/types";
import { DefaultElementFinder } from "../../../../src/features/utility/ElementFinder";
import { DefaultScrollableElementsQuery } from "../../../../src/features/utility/InteractiveElementQueries";
import { DefaultElementGeometry } from "../../../../src/features/utility/ElementGeometry";
import { AndroidCtrlProxyClient } from "../../../../src/features/observe/android";
import type { Element, ObserveResult, SwipeOnOptions } from "../../../../src/models";
import { FakeAccessibilityDetector } from "../../../fakes/FakeAccessibilityDetector";
import type { AdbClient } from "../../../../src/utils/android-cmdline-tools/AdbClient";
import { FakeAdbClient } from "../../../fakes/FakeAdbClient";
import { FakeAwaitIdle } from "../../../fakes/FakeAwaitIdle";
import { FakeCtrlProxy } from "../../../fakes/FakeCtrlProxy";
import { FakeGestureExecutor } from "../../../fakes/FakeGestureExecutor";
import { FakeScrollableElementsQuery } from "../../../fakes/FakeElementTraitQueries";
import { FakeObserveScreen } from "../../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeWindow } from "../../../fakes/FakeWindow";
import { encodeAndroidFlat } from "../../../fixtures/hierarchyArbitraries";
import textCapture from "../../../fixtures/android-focus/playground-text-field-pre-tap.json";
import changedTextCapture from "../../../fixtures/android-focus/playground-text-field-post-tap.json";
import scrollBefore from "../../../fixtures/observe/diff/scroll-before.json";
import scrollAfter from "../../../fixtures/observe/diff/scroll-after.json";
import noScrollCapture from "../../../fixtures/observe/android-playground-raw-trim-candidates.json";
import { harness as displayHarness } from "./displaySwipeHarness";

const textObservation: ObserveResult = {
  ...textCapture,
  timestamp: 0,
  screenSize: { width: 1080, height: 2400 },
  systemInsets: { top: 63, bottom: 63, left: 0, right: 0 },
};
const finder = new DefaultScrollableElementsQuery();
const scrollables = finder.findScrollableElements(textObservation.viewHierarchy!);
const largest = new AutoTargetSelector().pickLargestScrollable(scrollables)!;

function harness({
  before = textObservation,
  after = before,
  selector = new AutoTargetSelector(),
  geometry = new DefaultElementGeometry(),
  elementFinder,
  accessibilityDetector = new FakeAccessibilityDetector(),
}: {
  before?: ObserveResult;
  after?: ObserveResult;
  selector?: AutoTargetSelectorService;
  geometry?: DefaultElementGeometry;
  elementFinder?: FakeScrollableElementsQuery;
  accessibilityDetector?: FakeAccessibilityDetector;
} = {}) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const ctrl = new FakeCtrlProxy(timer);
  spyOn(AndroidCtrlProxyClient, "getInstance").mockReturnValue(
    ctrl as unknown as AndroidCtrlProxyClient,
  );
  const gesture = new FakeGestureExecutor();
  const observe = new FakeObserveScreen();
  observe.setObserveResult(() => (gesture.getSwipeCalls().length ? after : before));
  const action = new SwipeOn(
    { name: "fake", platform: "android", deviceId: "unnamed" },
    new FakeAdbClient() as unknown as AdbClient,
    {
      timer,
      observeScreen: observe,
      executeGesture: gesture,
      accessibilityDetector,
      autoTargetSelector: selector,
      geometry,
      scrollables: elementFinder,
    },
  );
  action.awaitIdle = new FakeAwaitIdle() as unknown as typeof action.awaitIdle;
  action.window = new FakeWindow() as unknown as typeof action.window;
  return { action, gesture, ctrl };
}

afterEach(() => mock.restore());

describe("Android unchanged swipe warning", () => {
  for (const target of ["screen", "element", "display-ctrlproxy", "display-adb"] as const) {
    test.each([true, false])(`${target} unchanged swipe with boomerang=%s`, async (boomerang) => {
      const options: SwipeOnOptions = { direction: "up", boomerang };
      const h =
        target === "screen" || target === "element"
          ? harness()
          : displayHarness({
              route: target === "display-adb" ? "adb" : "ctrlproxy",
              unchanged: true,
              foundAfter: Infinity,
            });
      if (target === "screen") {
        options.autoTarget = false;
      } else if (target !== "element") {
        options.display = "external";
      }
      const result = await h.action.execute(options);
      expect(result.success).toBe(true);
      expect(result.effect).toEqual({ screenChanged: false, basis: "viewHierarchy unchanged" });
      if (boomerang) {
        expect(result.warning ?? "").not.toContain("Swipe did not change the screen");
      } else {
        expect(result.warning).toContain("Swipe did not change the screen");
      }
      if (target === "element") {
        expect(result.warning).toContain("lacks a usable identifier; swiping within its bounds");
      }
    });
  }

  test.each([false, true])(
    "changed boomerang swipe with autoTarget=%s keeps its effect",
    async (autoTarget) => {
      const after = { ...textObservation, ...changedTextCapture, timestamp: 1 };
      const result = await harness({ after }).action.execute({
        direction: "up",
        boomerang: true,
        autoTarget,
      });
      expect(result.success).toBe(true);
      expect(result.effect).toEqual({ screenChanged: true, basis: "viewHierarchy changed" });
      expect(result.warning ?? "").not.toContain("Swipe did not change the screen");
    },
  );

  test.each([true, false])("TalkBack named container with boomerang=%s", async (boomerang) => {
    const accessibilityDetector = new FakeAccessibilityDetector();
    accessibilityDetector.setTalkBackEnabled(true);
    const before = { ...scrollBefore, timestamp: 0 } as ObserveResult;
    const h = harness({ before, accessibilityDetector });
    spyOn(h.ctrl, "getAccessibilityHierarchy").mockResolvedValue(before.viewHierarchy);
    const result = await h.action.execute({
      direction: "up",
      container: { elementId: "tap_screen_content" },
      boomerang,
    });
    expect(result.success).toBe(true);
    expect(result.effect).toEqual({ screenChanged: false, basis: "activeWindow unchanged" });
    expect(h.ctrl.getActionHistory()).toMatchObject([
      { action: boomerang ? "focus" : "scroll_forward", resourceId: "tap_screen_content" },
    ]);
    expect(h.gesture.getSwipeCalls()).toHaveLength(0);
    expect(h.ctrl.getTwoFingerSwipeHistory()).toHaveLength(0);
    if (boomerang) {
      expect(result.warning ?? "").not.toContain("Swipe did not change the screen");
    } else {
      expect(result.warning).toContain("Swipe did not change the screen");
    }
  });

  test("TalkBack two-finger scroll retains the unchanged warning", async () => {
    const accessibilityDetector = new FakeAccessibilityDetector();
    accessibilityDetector.setTalkBackEnabled(true);
    const h = harness({ accessibilityDetector });
    const result = await h.action.execute({ direction: "up", autoTarget: false });
    expect(result.success).toBe(true);
    expect(result.effect?.screenChanged).toBe(false);
    expect(h.ctrl.getTwoFingerSwipeHistory()).toHaveLength(1);
    expect(h.ctrl.getActionHistory()).toHaveLength(0);
    expect(h.gesture.getSwipeCalls()).toHaveLength(0);
    expect(result.warning).toContain("Swipe did not change the screen");
  });
});

function expectEndpointsInside(
  result: { x1: number; y1: number; x2: number; y2: number },
  element: Element,
) {
  const geometry = new DefaultElementGeometry();
  expect(geometry.isPointInElement(element, result.x1, result.y1)).toBe(true);
  expect(geometry.isPointInElement(element, result.x2, result.y2)).toBe(true);
}

describe("Android unnamed auto-target capture regression", () => {
  test.each(["up", "down", "left", "right"] as const)(
    "nested unnamed pager and list select the capable container for %s",
    async (direction) => {
      const pagerBounds = { left: 0, top: 0, right: 1080, bottom: 2400 };
      const listBounds = { left: 80, top: 400, right: 1000, bottom: 1800 };
      const before: ObserveResult = {
        ...textObservation,
        systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
        viewHierarchy: {
          hierarchy: {
            node: [
              encodeAndroidFlat({
                attrs: { scrollable: "true", class: "androidx.viewpager2.widget.ViewPager2" },
                bounds: pagerBounds,
                children: [
                  {
                    attrs: { scrollable: "true", class: "androidx.core.widget.NestedScrollView" },
                    bounds: listBounds,
                    children: [],
                  },
                ],
              }),
            ],
          },
        },
      };
      const result = await harness({ before }).action.execute({ direction, autoTarget: true });
      const vertical = direction === "up" || direction === "down";
      expect(result.targetType).toBe("element");
      expect(result.element?.bounds).toEqual(vertical ? listBounds : pagerBounds);
      expectEndpointsInside(result, { bounds: vertical ? listBounds : pagerBounds });
      expect(result.warning).toContain("lacks a usable identifier; swiping within its bounds");
    },
  );

  test("up selects the smaller unnamed vertical sibling through the real parser", async () => {
    const horizontalBounds = { left: 0, top: 0, right: 1000, bottom: 100 };
    const verticalBounds = { left: 450, top: 900, right: 550, bottom: 1400 };
    const before: ObserveResult = {
      ...textObservation,
      viewHierarchy: {
        hierarchy: {
          node: [
            encodeAndroidFlat({
              attrs: { scrollable: "true", class: "android.widget.HorizontalScrollView" },
              bounds: horizontalBounds,
              children: [],
            }),
            encodeAndroidFlat({
              attrs: { scrollable: "true", class: "android.widget.ScrollView" },
              bounds: verticalBounds,
              children: [],
            }),
          ],
        },
      },
    };
    const result = await harness({ before }).action.execute({ direction: "up", autoTarget: true });
    expect(result.element?.bounds).toEqual(verticalBounds);
    expectEndpointsInside(result, { bounds: verticalBounds });
  });

  for (const autoTarget of [undefined, false] as const) {
    test.each(["up", "down", "left", "right"] as const)(
      `screen swipe with autoTarget=${autoTarget} preserves main coordinates for %s`,
      async (direction) => {
        const selector = new AutoTargetSelector();
        // Undefined retains legacy automatic selection; model its screen decision
        // while leaving the captured scrollable present to catch any second search.
        const select = spyOn(selector, "selectAutoTargetScrollable").mockReturnValue(null);
        const result = await harness({ selector }).action.execute({ direction, autoTarget });
        const coordinates = new DefaultElementGeometry().getSwipeWithinBounds(direction, {
          left: 0,
          top: 63,
          right: 1080,
          bottom: 2337,
        });
        expect(result.targetType).toBe("screen");
        expect([result.x1, result.y1, result.x2, result.y2]).toEqual([
          coordinates.startX,
          coordinates.startY,
          coordinates.endX,
          coordinates.endY,
        ]);
        expect(select).toHaveBeenCalledTimes(autoTarget === false ? 0 : 1);
      },
    );
  }

  test("starts inside the captured Text scrollable, not the bottom strip", async () => {
    expect(largest.bounds).toEqual({ left: 0, top: 652, right: 1080, bottom: 2064 });
    const h = harness();
    const result = await h.action.execute({ direction: "up" });
    expect(result.y1).toBeLessThan(largest.bounds.bottom);
    expect(result.y2).toBeGreaterThan(largest.bounds.top);
    expectEndpointsInside(result, largest);
    expect(result.targetType).toBe("element");
    // The capture contains an inner scrollable at the screen centre; selection
    // now prefers it over its larger, also-scrollable parent.
    expect(result.element?.bounds).toEqual({ left: 42, top: 694, right: 1038, bottom: 2022 });
    expectEndpointsInside(result, {
      bounds: { left: 42, top: 694, right: 1038, bottom: 2022 },
    });
    expect(result.warning).toContain("lacks a usable identifier; swiping within its bounds");
    expect(result.warning).not.toContain("swiping the screen");
    expect(h.gesture.getSwipeCalls()).toHaveLength(1);
  });

  test("passes the selected unnamed element directly without a selector lookup", async () => {
    const lookup = spyOn(DefaultElementFinder.prototype, "findElementByText");
    const idLookup = spyOn(DefaultElementFinder.prototype, "findElementByResourceId");
    const result = await harness().action.execute({ direction: "up" });
    expect(result.targetType).toBe("element");
    expect(lookup).not.toHaveBeenCalled();
    expect(idLookup).not.toHaveBeenCalled();
  });

  test("keeps named auto-target and explicit-container coordinates identical", async () => {
    const before = { ...scrollBefore, timestamp: 0 } as ObserveResult;
    const after = { ...scrollAfter, timestamp: 1 } as ObserveResult;
    const named = finder
      .findScrollableElements(before.viewHierarchy!)
      .find((element) => element["resource-id"] === "tap_screen_content")!;
    spyOn(DefaultScrollableElementsQuery.prototype, "findScrollableElements").mockReturnValue([
      named,
    ]);
    const auto = await harness({ before, after }).action.execute({ direction: "up" });
    const explicit = await harness({ before, after }).action.execute({
      direction: "up",
      container: { elementId: "tap_screen_content" },
    });
    expect(auto.targetType).toBe("element");
    expect(auto.element?.["resource-id"]).toBe("tap_screen_content");
    expect([auto.x1, auto.y1, auto.x2, auto.y2]).toEqual([
      explicit.x1,
      explicit.y1,
      explicit.x2,
      explicit.y2,
    ]);
    expect(auto.effect?.screenChanged).toBe(true);
    expect(auto.warning).not.toContain("did not change");
  });

  test("no scrollable uses screen coordinates inside all four safe edges", async () => {
    const before = {
      ...noScrollCapture,
      timestamp: 0,
      systemInsets: { top: 300, bottom: 400, left: 100, right: 120 },
    } as ObserveResult;
    expect(finder.findScrollableElements(before.viewHierarchy!)).toEqual([]);
    for (const direction of ["up", "down", "left", "right"] as const) {
      const result = await harness({ before }).action.execute({ direction });
      expect(result.targetType).toBe("screen");
      expect(result.warning).toContain("no scrollable region was found");
      expect(result.warning).not.toContain("geometry");
      expectEndpointsInside(result, {
        bounds: {
          left: 100,
          top: 300,
          right: before.screenSize.width - 120,
          bottom: before.screenSize.height - 400,
        },
      });
    }
  });

  test("single direction mismatch preserves screen fallback in the safe area", async () => {
    const before = { ...scrollBefore, timestamp: 0 } as ObserveResult;
    // Add explicit axis metadata to the real captured container for this
    // synthetic direction-mismatch case; its shape no longer implies an axis.
    const only = finder
      .findScrollableElements(before.viewHierarchy!)
      .find((element) => element["resource-id"] === "tap_screen_content")!;
    const h = harness({ before });
    spyOn(DefaultScrollableElementsQuery.prototype, "findScrollableElements").mockReturnValue([
      { ...only, orientation: "vertical" },
    ]);
    const result = await h.action.execute({ direction: "left" });
    expect(result.targetType).toBe("screen");
    expect(result.warning).toContain("none matched the swipe direction");
    expectEndpointsInside(result, { bounds: { left: 0, top: 63, right: 1080, bottom: 2337 } });
  });

  test("screen fallback preserves main geometry when selection declines it", async () => {
    const selector = new AutoTargetSelector();
    spyOn(selector, "selectAutoTargetScrollable").mockReturnValue(null);
    const result = await harness({ selector }).action.execute({ direction: "up" });
    expect(result.targetType).toBe("screen");
    const coordinates = new DefaultElementGeometry().getSwipeWithinBounds("up", {
      left: 0,
      top: 63,
      right: 1080,
      bottom: 2337,
    });
    expect([result.x1, result.y1, result.x2, result.y2]).toEqual([
      coordinates.startX,
      coordinates.startY,
      coordinates.endX,
      coordinates.endY,
    ]);
  });

  test("unnamed auto-target uses the injected selector's chosen element without reselecting", async () => {
    const smaller: Element = {
      ...largest,
      bounds: { left: 80, top: 1000, right: 280, bottom: 1600 },
    };
    const elementFinder = new FakeScrollableElementsQuery();
    elementFinder.nextScrollableElements = [largest, smaller];
    const realSelector = new AutoTargetSelector();
    const selector: AutoTargetSelectorService = {
      selectAutoTargetScrollable: mock(() => smaller),
      getScreenBounds: realSelector.getScreenBounds.bind(realSelector),
      describeContainer: realSelector.describeContainer.bind(realSelector),
      mergeWarnings: realSelector.mergeWarnings.bind(realSelector),
    };
    const before: ObserveResult = {
      ...textObservation,
      viewHierarchy: { hierarchy: { node: [] } },
    };
    const h = harness({ before, selector, elementFinder });
    const result = await h.action.execute({ direction: "up" });
    expect(selector.selectAutoTargetScrollable).toHaveBeenCalledTimes(1);
    expect(selector.selectAutoTargetScrollable).toHaveBeenCalledWith(
      elementFinder.nextScrollableElements,
      { left: 0, top: 63, right: 1080, bottom: 2337 },
      "up",
    );
    expect(result.targetType).toBe("element");
    expect(result.element).toBe(smaller);
    expectEndpointsInside(result, smaller);
    const coordinates = new DefaultElementGeometry().getSwipeWithinBounds("up", smaller.bounds);
    expect([result.x1, result.y1, result.x2, result.y2]).toEqual([
      coordinates.startX,
      coordinates.startY,
      coordinates.endX,
      coordinates.endY,
    ]);
    expect(h.gesture.getSwipeCalls()[0]).toMatchObject({ x1: 180, x2: 180 });
  });

  test("unchanged hierarchy reports effect and an inside-scrollable end-of-list warning", async () => {
    const result = await harness().action.execute({ direction: "up" });
    expect(result.success).toBe(true);
    expect(result.effect).toEqual({ screenChanged: false, basis: "viewHierarchy unchanged" });
    expect(result.warning).toContain("Swipe did not change the screen");
    expect(result.warning).toContain("inside the scrollable");
    expect(result.warning).toContain("end of the scrollable content");
    expect(result.warning).not.toContain("outside");
  });

  test("known outside-scrollable no-op reports geometry distinctly", async () => {
    const geometry = new DefaultElementGeometry();
    // Model the old issue geometry using the injected geometry seam.
    spyOn(geometry, "getSwipeWithinBounds").mockReturnValue({
      startX: 540,
      startY: 2101,
      endX: 540,
      endY: 382,
    });
    const result = await harness({ geometry }).action.execute({ direction: "up" });
    expect(result.effect?.screenChanged).toBe(false);
    expect(result.warning).toContain("start point was outside every scrollable region");
    expect(result.warning).not.toContain("end of the scrollable content");
  });

  test("changed hierarchy reports the existing effect without a no-op warning", async () => {
    const after = { ...textObservation, ...changedTextCapture, timestamp: 1 };
    const result = await harness({ after }).action.execute({ direction: "up" });
    expect(result.effect).toEqual({ screenChanged: true, basis: "viewHierarchy changed" });
    expect(result.warning).not.toContain("did not change");
  });

  test("legacy forced-screen swipe also attaches the effect", async () => {
    const options: SwipeOnOptions = { direction: "up", autoTarget: false };
    const result = await harness().action.execute(options);
    expect(result.targetType).toBe("screen");
    expect(result.effect?.screenChanged).toBe(false);
    expect(result.warning).toContain("outside every scrollable region");
  });
});

test("unnamed capture respects intersected system insets", async () => {
  const before = {
    ...textObservation,
    systemInsets: { top: 800, bottom: 600, left: 70, right: 90 },
  };
  const result = await harness({ before }).action.execute({ direction: "up" });
  expectEndpointsInside(result, { bounds: { left: 70, top: 800, right: 990, bottom: 1800 } });
});

test("unnamed captured container avoids a clickable sibling overlay using bounds identity", async () => {
  const overlay = encodeAndroidFlat({
    attrs: { clickable: "true" },
    bounds: { left: 0, top: 1700, right: 1080, bottom: 2064 },
    children: [],
  });
  const before: ObserveResult = {
    ...textObservation,
    viewHierarchy: {
      ...textObservation.viewHierarchy,
      windows: undefined,
      hierarchy: { node: [...textCapture.viewHierarchy.hierarchy.node, overlay] },
    },
  };
  const result = await harness({ before }).action.execute({ direction: "up" });
  expect(result.y1).toBeLessThan(1700);
  expectEndpointsInside(result, largest);
  expect(result.warning).not.toContain("No unobstructed swipe area");
});
