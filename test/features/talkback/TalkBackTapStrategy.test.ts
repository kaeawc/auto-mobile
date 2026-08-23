import { beforeEach, describe, expect, test, spyOn } from "bun:test";
import { TalkBackTapStrategy } from "../../../src/features/talkback/TalkBackTapStrategy";
import { FakeTalkBackNavigationDriver } from "../../fakes/FakeTalkBackNavigationDriver";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FocusNavigationExecutor } from "../../../src/features/talkback/FocusNavigationExecutor";
import { FocusPathCalculator } from "../../../src/features/talkback/FocusPathCalculator";
import { FocusElementMatcher } from "../../../src/features/talkback/FocusElementMatcher";
import type { Element } from "../../../src/models/Element";

describe("TalkBackTapStrategy", () => {
  let strategy: TalkBackTapStrategy;
  let driver: FakeTalkBackNavigationDriver;
  let fakeTimer: FakeTimer;
  let mockExecutor: FocusNavigationExecutor;
  let mockPathCalculator: FocusPathCalculator;
  let matcher: FocusElementMatcher;

  beforeEach(() => {
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    matcher = new FocusElementMatcher();
    mockPathCalculator = new FocusPathCalculator(matcher);
    mockExecutor = new FocusNavigationExecutor({
      matcher,
      pathCalculator: mockPathCalculator,
      timer: fakeTimer
    });

    strategy = new TalkBackTapStrategy({
      matcher,
      pathCalculator: mockPathCalculator,
      executor: mockExecutor,
      timer: fakeTimer
    });

    driver = new FakeTalkBackNavigationDriver();
  });

  describe("executeTap", () => {
    test("returns error when element has no identifying information", async () => {
      const element = {
        bounds: { left: 0, top: 0, right: 100, bottom: 100 }
        // no text, no resource-id, no content-desc
      } as Element;

      const result = await strategy.executeTap("device-1", element, driver);

      expect(result.success).toBe(false);
      expect(result.method).toBe("focus-navigation");
      expect(result.error).toBeDefined();
    });

    test("navigates using text match when element has no resource-id", async () => {
      const element = {
        bounds: { left: 0, top: 0, right: 100, bottom: 100 },
        text: "Button"
      } as Element;

      driver.setElements([element], 0);

      const navigateToElement = spyOn(mockExecutor, "navigateToElement")
        .mockResolvedValue(true);

      const result = await strategy.executeTap("device-1", element, driver);

      expect(result.success).toBe(true);
      expect(result.method).toBe("focus-navigation");
      expect(result.screenReaderNavigation).toMatchObject({
        reachable: true,
        focusTrapDetected: false,
        traversalOrder: [element]
      });
      expect(navigateToElement).toHaveBeenCalledTimes(1);
      expect(navigateToElement).toHaveBeenCalledWith(
        "device-1",
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ verificationInterval: 1 })
      );
      expect(driver.getTapCount()).toBe(2); // Double-tap to activate
    });

    test("navigates using content-desc match when element has no resource-id", async () => {
      const element = {
        "bounds": { left: 0, top: 0, right: 100, bottom: 100 },
        "content-desc": "Close dialog"
      } as Element;

      driver.setElements([element], 0);

      const navigateToElement = spyOn(mockExecutor, "navigateToElement")
        .mockResolvedValue(true);

      const result = await strategy.executeTap("device-1", element, driver);

      expect(result.success).toBe(true);
      expect(result.method).toBe("focus-navigation");
      expect(navigateToElement).toHaveBeenCalledTimes(1);
    });

    test("uses focus navigation for tap action", async () => {
      const element = {
        "resource-id": "test:id/button",
        "bounds": { left: 0, top: 0, right: 100, bottom: 100 }
      } as Element;

      // Set up driver with element in traversal order
      driver.setElements([element], 0);

      const navigateToElement = spyOn(mockExecutor, "navigateToElement")
        .mockResolvedValue(true);

      const result = await strategy.executeTap("device-1", element, driver);

      expect(result.success).toBe(true);
      expect(result.method).toBe("focus-navigation");
      expect(navigateToElement).toHaveBeenCalledTimes(1);
      expect(driver.getTapCount()).toBe(2); // Double-tap to activate
    });

    test("returns error when focus navigation fails", async () => {
      const element = {
        "resource-id": "test:id/button",
        "bounds": { left: 0, top: 0, right: 100, bottom: 100 }
      } as Element;

      driver.setElements([element], 0);

      const navigateToElement = spyOn(mockExecutor, "navigateToElement")
        .mockRejectedValue(new Error("Navigation failed"));

      const result = await strategy.executeTap("device-1", element, driver);

      expect(result.success).toBe(false);
      expect(result.method).toBe("focus-navigation");
      expect(result.error).toContain("Navigation failed");
      expect(result.screenReaderNavigation).toMatchObject({
        reachable: false,
        focusTrapDetected: false,
        traversalOrder: [element]
      });
      expect(navigateToElement).toHaveBeenCalledTimes(1);
    });

    test("reports a focus trap when the convergence guard stops navigation", async () => {
      const element = {
        "resource-id": "test:id/button",
        "bounds": { left: 0, top: 0, right: 100, bottom: 100 }
      } as Element;
      driver.setElements([element], 0);
      spyOn(mockExecutor, "navigateToElement").mockRejectedValue(
        new Error("Focus navigation is not converging on the target.")
      );

      const result = await strategy.executeTap("device-1", element, driver);

      expect(result.screenReaderNavigation).toMatchObject({
        reachable: false,
        focusTrapDetected: true,
        traversalOrder: [element]
      });
    });

    // isFocusTrapError classifies exactly the three navigation-failure messages
    // the FocusNavigationExecutor can throw; any other error is NOT a focus trap.
    // Asserted via the observable focusTrapDetected flag on the result.
    test.each([
      ["Focus did not move after multiple swipes. Try scrolling the container.", true],
      ["Focus navigation could not track the TalkBack cursor position. Try narrowing.", true],
      ["Focus navigation is not converging on the target. Try scrolling.", true],
      ["Navigation failed for an unrelated reason", false],
    ])(
      "maps navigation error %j to focusTrapDetected=%p",
      async (message, expectedTrap) => {
        const element = {
          "resource-id": "test:id/button",
          "bounds": { left: 0, top: 0, right: 100, bottom: 100 }
        } as Element;
        driver.setElements([element], 0);
        spyOn(mockExecutor, "navigateToElement").mockRejectedValue(new Error(message as string));

        const result = await strategy.executeTap("device-1", element, driver);

        expect(result.screenReaderNavigation?.focusTrapDetected).toBe(expectedTrap as boolean);
      }
    );

    test("uses ACTION_CLICK fallback if double-tap activation fails", async () => {
      const element = {
        "resource-id": "test:id/button",
        "bounds": { left: 0, top: 0, right: 100, bottom: 100 }
      } as Element;

      driver.setElements([element], 0);

      spyOn(mockExecutor, "navigateToElement").mockResolvedValue(true);
      driver.queueTapResult({ success: false, totalTimeMs: 1, error: "tap failed" });
      driver.setActionResult({ success: true, action: "click", totalTimeMs: 1 });

      const result = await strategy.executeTap("device-1", element, driver);

      expect(result.success).toBe(true);
      expect(result.method).toBe("accessibility-action");
      expect(driver.getTapCount()).toBe(1); // Only first tap attempted
      expect(driver.getActionCount()).toBe(1); // ACTION_CLICK fallback
      expect(driver.actionHistory[0]).toEqual({ action: "click", resourceId: "test:id/button" });
    });

    test("returns failure when text-only element activation double-tap fails (no ACTION_CLICK fallback)", async () => {
      const element = {
        bounds: { left: 0, top: 0, right: 100, bottom: 100 },
        text: "Button"
      } as Element;

      driver.setElements([element], 0);

      spyOn(mockExecutor, "navigateToElement").mockResolvedValue(true);
      driver.setTapResult({ success: false, totalTimeMs: 1, error: "tap failed" });

      const result = await strategy.executeTap("device-1", element, driver);

      expect(result.success).toBe(false);
      expect(result.method).toBe("focus-navigation");
      expect(driver.getActionCount()).toBe(0); // No ACTION_CLICK attempted without resource-id
    });

    test("returns failure when text-only element second tap fails (no ACTION_CLICK fallback)", async () => {
      const element = {
        bounds: { left: 0, top: 0, right: 100, bottom: 100 },
        text: "Button"
      } as Element;

      driver.setElements([element], 0);

      spyOn(mockExecutor, "navigateToElement").mockResolvedValue(true);
      driver.queueTapResult({ success: true, totalTimeMs: 1 }); // first tap succeeds
      driver.setTapResult({ success: false, totalTimeMs: 1, error: "second tap failed" });

      const result = await strategy.executeTap("device-1", element, driver);

      expect(result.success).toBe(false);
      expect(result.method).toBe("focus-navigation");
      expect(driver.getActionCount()).toBe(0); // No ACTION_CLICK attempted without resource-id
    });

    test("returns error if both double-tap and ACTION_CLICK fail", async () => {
      const element = {
        "resource-id": "test:id/button",
        "bounds": { left: 0, top: 0, right: 100, bottom: 100 }
      } as Element;

      driver.setElements([element], 0);

      spyOn(mockExecutor, "navigateToElement").mockResolvedValue(true);
      driver.queueTapResult({ success: false, totalTimeMs: 1, error: "tap failed" });
      driver.setActionResult({ success: false, action: "click", totalTimeMs: 1, error: "click failed" });

      const result = await strategy.executeTap("device-1", element, driver);

      expect(result.success).toBe(false);
      expect(result.method).toBe("focus-navigation");
      expect(result.error).toContain("both failed");
    });

    // Regression for #3918: activation must double-tap the node TalkBack
    // actually focused (live bounds), not the caller's stored element whose
    // bounds may be stale.
    test("activates at the live focused node's coordinates, not the passed element's stale bounds", async () => {
      // The caller's element carries stale bounds (center 5,5)...
      const staleElement = {
        "resource-id": "test:id/button",
        "bounds": { left: 0, top: 0, right: 10, bottom: 10 }
      } as Element;
      // ...while the node TalkBack actually focused is elsewhere (center 600,700).
      const liveFocusedElement = {
        "resource-id": "test:id/button",
        "bounds": { left: 500, top: 600, right: 700, bottom: 800 }
      } as Element;

      driver.setElements([liveFocusedElement], 0);
      spyOn(mockExecutor, "navigateToElement").mockResolvedValue(true);

      const result = await strategy.executeTap("device-1", staleElement, driver);

      expect(result.success).toBe(true);
      expect(result.method).toBe("focus-navigation");
      expect(driver.getTapCount()).toBe(2);
      // Both taps land on the live focused node, not (5,5).
      expect(driver.tapHistory[0]).toMatchObject({ x: 600, y: 700 });
      expect(driver.tapHistory[1]).toMatchObject({ x: 600, y: 700 });
    });

    // Regression for #3918: a bounds-less activation target must never tap (0,0).
    test("falls back to ACTION_CLICK (never taps 0,0) when the target has no bounds", async () => {
      const boundsLessElement = {
        "resource-id": "test:id/button"
        // no bounds on the caller's element...
      } as Element;
      // ...and the live focused node also has no bounds.
      const boundsLessFocused = { "resource-id": "test:id/button" } as Element;

      driver.setElements([boundsLessFocused], 0);
      spyOn(mockExecutor, "navigateToElement").mockResolvedValue(true);
      driver.setActionResult({ success: true, action: "click", totalTimeMs: 1 });

      const result = await strategy.executeTap("device-1", boundsLessElement, driver);

      expect(result.success).toBe(true);
      expect(result.method).toBe("accessibility-action");
      expect(driver.getTapCount()).toBe(0); // never tapped (0,0)
      expect(driver.actionHistory[0]).toEqual({ action: "click", resourceId: "test:id/button" });
    });

    test("fails explicitly (no 0,0 tap, no ACTION_CLICK) when a bounds-less target has no resource-id", async () => {
      const boundsLessTextElement = { text: "Button" } as Element;
      const boundsLessFocused = { text: "Button" } as Element;

      driver.setElements([boundsLessFocused], 0);
      spyOn(mockExecutor, "navigateToElement").mockResolvedValue(true);

      const result = await strategy.executeTap("device-1", boundsLessTextElement, driver);

      expect(result.success).toBe(false);
      expect(result.method).toBe("focus-navigation");
      expect(result.error).toContain("no bounds");
      expect(driver.getTapCount()).toBe(0);
      expect(driver.getActionCount()).toBe(0);
    });

    test("returns error when navigation path cannot be calculated", async () => {
      const element = {
        "resource-id": "test:id/nonexistent",
        "bounds": { left: 0, top: 0, right: 100, bottom: 100 }
      } as Element;

      // Element not in traversal order
      driver.setElements([
        { "resource-id": "test:id/other", "bounds": { left: 0, top: 0, right: 50, bottom: 50 } } as Element
      ], 0);

      const result = await strategy.executeTap("device-1", element, driver);

      expect(result.success).toBe(false);
      expect(result.method).toBe("focus-navigation");
      expect(result.error).toContain("calculate navigation path");
    });

    test("returns error when traversal order request fails", async () => {
      const element = {
        "resource-id": "test:id/button",
        "bounds": { left: 0, top: 0, right: 100, bottom: 100 }
      } as Element;

      driver.queueTraversalResult({ error: "Service unavailable", totalTimeMs: 1 });

      const result = await strategy.executeTap("device-1", element, driver);

      expect(result.success).toBe(false);
      expect(result.method).toBe("focus-navigation");
      expect(result.error).toContain("traversal order");
    });
  });

  describe("executeLongPress", () => {
    test("uses ACTION_LONG_CLICK when element has resource-id", async () => {
      const element = {
        "resource-id": "test:id/button",
        "bounds": { left: 0, top: 0, right: 100, bottom: 100 }
      } as Element;

      driver.setActionResult({ success: true, action: "long_click", totalTimeMs: 1 });

      const result = await strategy.executeLongPress(50, 50, 1000, element, driver);

      expect(result.success).toBe(true);
      expect(result.method).toBe("accessibility-action");
      expect(driver.actionHistory).toHaveLength(1);
      expect(driver.actionHistory[0]).toEqual({ action: "long_click", resourceId: "test:id/button" });
      expect(driver.getTapCount()).toBe(0); // No coordinate taps
    });

    test("does not fall back when an advertised semantic long click fails", async () => {
      const element = {
        "test-tag": "message_row_42",
        "actions": ["long_click"],
        "bounds": { left: 0, top: 0, right: 100, bottom: 100 }
      } as Element;

      driver.setActionResult({ success: false, action: "long_click", totalTimeMs: 1, error: "service unavailable" });

      const result = await strategy.executeLongPress(50, 50, 1000, element, driver);

      expect(result.success).toBe(false);
      expect(result.method).toBe("accessibility-action");
      expect(result.error).toContain("service unavailable");
      expect(driver.actionHistory).toEqual([
        { action: "long_click", selector: { testTag: "message_row_42" } }
      ]);
      expect(driver.getTapCount()).toBe(0);
    });

    test("uses a coordinate fallback for a test tag when the runner lacks selector support", async () => {
      const element = {
        "test-tag": "message_row_42",
        "actions": ["long_click"],
        "bounds": { left: 0, top: 0, right: 100, bottom: 100 }
      } as Element;
      driver.setNodeActionSelectorsSupported(false);

      const result = await strategy.executeLongPress(50, 50, 1000, element, driver);

      expect(result).toEqual({ success: true, method: "coordinate-fallback" });
      expect(driver.getActionCount()).toBe(0);
      expect(driver.tapHistory).toEqual([{ x: 50, y: 50, durationMs: 1000 }]);
    });

    test("does not use collection coordinates without another stable identity", async () => {
      const element = {
        "collection-row-index": 0,
        "collection-column-index": 0,
        "actions": ["long_click"],
        "bounds": { left: 0, top: 0, right: 100, bottom: 100 }
      } as Element;

      const result = await strategy.executeLongPress(50, 50, 1000, element, driver);

      expect(result).toEqual({ success: true, method: "coordinate-fallback" });
      expect(driver.getActionCount()).toBe(0);
      expect(driver.tapHistory).toEqual([{ x: 50, y: 50, durationMs: 1000 }]);
    });

    test("uses coordinate gesture directly when element has no resource-id", async () => {
      const element = {
        bounds: { left: 0, top: 0, right: 100, bottom: 100 },
        text: "Button"
      } as Element;

      const result = await strategy.executeLongPress(50, 50, 1000, element, driver);

      expect(result.success).toBe(true);
      expect(result.method).toBe("coordinate-fallback");
      expect(driver.getActionCount()).toBe(0); // No ACTION_LONG_CLICK attempted
      expect(driver.getTapCount()).toBe(1);
      expect(driver.tapHistory[0]).toEqual({ x: 50, y: 50, durationMs: 1000 });
    });

    test("returns error when coordinate fallback also fails", async () => {
      const element = {
        "resource-id": "test:id/button",
        "bounds": { left: 0, top: 0, right: 100, bottom: 100 }
      } as Element;

      driver.setActionResult({ success: false, action: "long_click", totalTimeMs: 1, error: "failed" });
      driver.setTapResult({ success: false, totalTimeMs: 1, error: "gesture failed" });

      const result = await strategy.executeLongPress(50, 50, 1000, element, driver);

      expect(result.success).toBe(false);
      expect(result.method).toBe("coordinate-fallback");
    });
  });

  describe("executeCoordinateFallback", () => {
    test("performs single tap for tap action", async () => {
      const result = await strategy.executeCoordinateFallback(50, 50, "tap", 500, driver);

      expect(result.success).toBe(true);
      expect(result.method).toBe("coordinate-fallback");
      expect(driver.getTapCount()).toBe(1);
      expect(driver.tapHistory[0]).toEqual({ x: 50, y: 50, durationMs: 50 }); // Short duration for tap
    });

    test("performs double tap for doubleTap action", async () => {
      const result = await strategy.executeCoordinateFallback(50, 50, "doubleTap", 500, driver);

      expect(result.success).toBe(true);
      expect(result.method).toBe("coordinate-fallback");
      expect(driver.getTapCount()).toBe(2);
      expect(driver.tapHistory[0]).toEqual({ x: 50, y: 50, durationMs: 50 });
      expect(driver.tapHistory[1]).toEqual({ x: 50, y: 50, durationMs: 50 });
    });

    test("uses full duration for longPress action", async () => {
      const result = await strategy.executeCoordinateFallback(50, 50, "longPress", 1000, driver);

      expect(result.success).toBe(true);
      expect(result.method).toBe("coordinate-fallback");
      expect(driver.getTapCount()).toBe(1);
      expect(driver.tapHistory[0]).toEqual({ x: 50, y: 50, durationMs: 1000 }); // Full duration
    });

    test("returns error when first tap of doubleTap fails", async () => {
      driver.queueTapResult({ success: false, totalTimeMs: 1, error: "tap failed" });

      const result = await strategy.executeCoordinateFallback(50, 50, "doubleTap", 500, driver);

      expect(result.success).toBe(false);
      expect(result.method).toBe("coordinate-fallback");
      expect(result.error).toContain("First tap failed");
      expect(result.completedTaps).toBe(0);
      expect(driver.getTapCount()).toBe(1);
    });

    test("returns error when second tap of doubleTap fails", async () => {
      driver.queueTapResult({ success: true, totalTimeMs: 1 });
      driver.queueTapResult({ success: false, totalTimeMs: 1, error: "second tap failed" });

      const result = await strategy.executeCoordinateFallback(50, 50, "doubleTap", 500, driver);

      expect(result.success).toBe(false);
      expect(result.method).toBe("coordinate-fallback");
      expect(result.error).toContain("Second tap failed");
      expect(result.completedTaps).toBe(1);
      expect(driver.getTapCount()).toBe(2);
    });

    test("returns error when single tap fails", async () => {
      driver.setTapResult({ success: false, totalTimeMs: 1, error: "tap failed" });

      const result = await strategy.executeCoordinateFallback(50, 50, "tap", 500, driver);

      expect(result.success).toBe(false);
      expect(result.method).toBe("coordinate-fallback");
      expect(result.error).toContain("tap failed");
    });
  });

  describe("executePreciseTap", () => {
    test("focuses the requested coordinate before the activation double-tap", async () => {
      const result = await strategy.executePreciseTap(80, 40, driver);

      expect(result).toMatchObject({
        success: true,
        method: "coordinate-fallback",
        focusCompleted: true,
        completedTaps: 2,
      });
      expect(driver.tapHistory).toEqual([
        { x: 80, y: 40, durationMs: 50 },
        { x: 80, y: 40, durationMs: 50 },
        { x: 80, y: 40, durationMs: 50 },
      ]);
    });

    test("reports when the focus tap fails before activation", async () => {
      driver.queueTapResult({ success: false, totalTimeMs: 1, error: "focus failed" });

      const result = await strategy.executePreciseTap(80, 40, driver);

      expect(result).toMatchObject({
        success: false,
        focusCompleted: false,
        completedTaps: 0,
      });
      expect(driver.getTapCount()).toBe(1);
    });
  });

  describe("executeDirectActivation", () => {
    test("activates via ACTION_CLICK when element has a resource-id", async () => {
      const element = {
        "resource-id": "test:id/button",
        "bounds": { left: 0, top: 0, right: 100, bottom: 100 }
      } as Element;

      driver.setActionResult({ success: true, action: "click", totalTimeMs: 1 });

      const result = await strategy.executeDirectActivation(element, driver);

      expect(result.success).toBe(true);
      expect(result.method).toBe("accessibility-action");
      expect(driver.actionHistory).toHaveLength(1);
      expect(driver.actionHistory[0]).toEqual({ action: "click", resourceId: "test:id/button" });
      expect(driver.getTapCount()).toBe(0); // no cursor stepping, no coordinate taps
    });

    test("returns failure without attempting an action when element has no resource-id", async () => {
      const element = {
        bounds: { left: 0, top: 0, right: 100, bottom: 100 },
        text: "Button"
      } as Element;

      const result = await strategy.executeDirectActivation(element, driver);

      expect(result.success).toBe(false);
      expect(result.method).toBe("accessibility-action");
      expect(result.error).toBeDefined();
      expect(driver.getActionCount()).toBe(0);
    });

    test("returns failure when ACTION_CLICK is rejected", async () => {
      const element = {
        "resource-id": "test:id/button",
        "bounds": { left: 0, top: 0, right: 100, bottom: 100 }
      } as Element;

      driver.setActionResult({ success: false, action: "click", totalTimeMs: 1, error: "node not found" });

      const result = await strategy.executeDirectActivation(element, driver);

      expect(result.success).toBe(false);
      expect(result.method).toBe("accessibility-action");
      expect(result.error).toContain("node not found");
      expect(driver.actionHistory[0]).toEqual({ action: "click", resourceId: "test:id/button" });
    });
  });
});
