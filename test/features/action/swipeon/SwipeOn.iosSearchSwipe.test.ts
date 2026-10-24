import { runBlockWithEnvelope } from "../../../helpers/observedInteractionStub";
import { buildObserveResult, viewHierarchyFromFixture } from "../../../helpers/observeFixture";
import { FakeScrollableElementsQuery } from "../../../fakes/FakeElementTraitQueries";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { SwipeOn } from "../../../../src/features/action/swipeon/SwipeOn";
import { FakeObserveScreen } from "../../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeTalkBackSwipeExecutor } from "../../../fakes/FakeTalkBackSwipeExecutor";
import { FakeAccessibilityDetector } from "../../../fakes/FakeAccessibilityDetector";
import fixture from "../../../fixtures/ios-safari-url-field/hierarchy-compact.json";
import { SearchableHierarchy } from "../../../../src/features/utility/SearchableNode";
import { DefaultElementGeometry } from "../../../../src/features/utility/ElementGeometry";
import type { ElementBounds } from "../../../../src/models";
import { FakeAdbClient } from "../../../fakes/FakeAdbClient";
import { FakeGestureExecutor } from "../../../fakes/FakeGestureExecutor";
import { FakeScreenshotCapturer } from "../../../fakes/FakeScreenshotCapturer";
import { FakeFeatureFlagRepository } from "../../../fakes/FakeFeatureFlagRepository";
import { FakeFeatureFlagApplier } from "../../../fakes/FakeFeatureFlagApplier";
import { FeatureFlagService } from "../../../../src/features/featureFlags/FeatureFlagService";
import { screenshotPathProtection } from "../../../../src/features/observe/ScreenshotPathProtection";
import {
  effectiveSwipeInsets,
  insetSwipeBounds,
} from "../../../../src/features/action/swipeon/iosChromeInsets";
import { defaultTimer } from "../../../../src/utils/SystemTimer";

// An injected observer must also prevent constructor-time screenshot directory I/O
// and retention intervals, including the cold first test in this file.
let restoreHostWorkGuards = () => {};
beforeEach(() => {
  const guards = [
    spyOn(screenshotPathProtection, "start"),
    spyOn(defaultTimer, "sleep"),
    spyOn(defaultTimer, "setTimeout"),
    spyOn(defaultTimer, "setInterval"),
  ];
  for (const guard of guards) {
    guard.mockImplementation(() => {
      throw new Error("iOS chrome tests must not start real retention or timer waits");
    });
  }
  restoreHostWorkGuards = () => guards.forEach((guard) => guard.mockRestore());
});
afterEach(() => restoreHostWorkGuards());

function harness() {
  const observation = buildObserveResult({
    viewHierarchy: viewHierarchyFromFixture(fixture),
    updatedAt: 0,
    screenSize: { width: 402, height: 874 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  });
  const observeScreen = new FakeObserveScreen();
  observeScreen.setObserveResult(observation);
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const voiceOverExecutor = new FakeTalkBackSwipeExecutor();
  const finder = new FakeScrollableElementsQuery();
  const action = new SwipeOn(
    { name: "iOS fake", deviceId: "ios-chrome", platform: "ios" },
    new FakeAdbClient(),
    {
      observeScreen,
      executeGesture: new FakeGestureExecutor(),
      screenshotCapturer: new FakeScreenshotCapturer(),
      featureFlags: new FeatureFlagService(
        new FakeFeatureFlagRepository(),
        new FakeFeatureFlagApplier(),
      ),
      scrollables: finder,
      timer,
      voiceOverExecutor,
      accessibilityDetector: new FakeAccessibilityDetector(),
    },
  );
  action.observedInteraction = runBlockWithEnvelope(() => observation, { observation });
  return { action, voiceOverExecutor, finder, observation };
}

const safeBounds = { left: 0, top: 0, right: 402, bottom: 792 };
for (const mode of ["anonymous", "screen", "container", "partial", "degenerate"] as const) {
  for (const direction of ["down", "up"] as const) {
    test(`Safari search ${direction} avoids capsule via ${mode}`, async () => {
      const { action, voiceOverExecutor, finder, observation } = harness();
      const captured = new SearchableHierarchy()
        .project(observation.viewHierarchy!)
        .find((node) => node.className === "UIScrollView")!.element!;
      let expectedBounds: ElementBounds = safeBounds;
      if (mode === "partial") {
        // Narrow only the finder-returned captured scroll frame, not the hierarchy.
        expectedBounds = { left: 20, top: 150, right: 380, bottom: 650 };
      }
      const frame =
        mode === "degenerate" ? { ...safeBounds, top: 820, bottom: 850 } : expectedBounds;
      finder.nextScrollableElements = [
        { ...captured, bounds: mode === "anonymous" ? captured.bounds : frame },
      ];
      const result = await action.execute({
        direction,
        gestureType: "scrollTowardsDirection",
        ...(mode === "screen" ? { autoTarget: false } : {}),
        ...(mode === "container" ? { container: { elementId: "WebView" } } : {}),
      });
      expect(result.success).toBe(true);
      const call = voiceOverExecutor.getSwipeCalls()[0];
      const fingerDirection = direction === "down" ? "up" : "down";
      const expected = new DefaultElementGeometry().getSwipeWithinBounds(
        fingerDirection,
        expectedBounds,
      );
      expect(call.y1).toBe(expected.startY);
      expect(call.y2).toBe(expected.endY);
      expect(Math.min(call.y1, call.y2)).toBeGreaterThanOrEqual(40);
      expect(Math.max(call.y1, call.y2)).toBeLessThanOrEqual(752);
      if (mode === "anonymous" || mode === "partial") {
        expect(result.targetType).toBe("screen");
        expect(result.warning).toContain("lacks a usable identifier; swiping the screen");
      }
    });
  }
}

test("Safari fromEdge bottom starts at the chrome-only screen edge", async () => {
  const { action, voiceOverExecutor, observation } = harness();
  expect(
    effectiveSwipeInsets({ observation, platform: "ios", includeFloatingBars: false }),
  ).toEqual({
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  });
  const result = await action.execute({ direction: "up", fromEdge: "bottom" });
  expect(result.success).toBe(true);
  expect(voiceOverExecutor.getSwipeCalls()[0].y1).toBe(869);
});

for (const id of ["TabBarItemTitle", "TabOverviewButton"]) {
  test(`Safari ${id} container falls back to chrome-only bounds`, () => {
    const { observation } = harness();
    const bounds = new SearchableHierarchy()
      .project(observation.viewHierarchy!)
      .find((node) => node.nativeId === id)!.bounds!;
    const options = { observation, platform: "ios" as const, bounds };
    expect(insetSwipeBounds(options)).toEqual(
      insetSwipeBounds({ ...options, includeFloatingBars: false }),
    );
    expect(insetSwipeBounds(options)).toEqual(bounds);
  });
}
