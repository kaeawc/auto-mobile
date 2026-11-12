import { wireHierarchyFrom } from "../../../helpers/androidHierarchyConverter";
import { AutoTargetSelector } from "../../../../src/features/action/swipeon/AutoTargetSelector";
import type { Element } from "../../../../src/models";
import { SearchableHierarchy } from "../../../../src/features/utility/SearchableNode";
import { TalkBackSwipeExecutor } from "../../../../src/features/action/swipeon/TalkBackSwipeExecutor";
import { DefaultScrollableElementsQuery } from "../../../../src/features/utility/InteractiveElementQueries";
import { expect, test } from "bun:test";
import { SwipeOn } from "../../../../src/features/action/swipeon/SwipeOn";
import type { SwipeOnOptions } from "../../../../src/models";
import { recordObservationRead } from "../../../../src/features/observe/observationReadScope";
import { DEFAULT_VISION_CONFIG } from "../../../../src/vision";
import { FakeAccessibilityDetector } from "../../../fakes/FakeAccessibilityDetector";
import { FakeAdbClient } from "../../../fakes/FakeAdbClient";
import { FakeAndroidXrDetector } from "../../../fakes/FakeAndroidXrDetector";
import { FakeCtrlProxy } from "../../../fakes/FakeCtrlProxy";
import { FakeGestureExecutor } from "../../../fakes/FakeGestureExecutor";
import { FakeObserveScreen } from "../../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { runBlockWithEnvelope } from "../../../helpers/observedInteractionStub";
import { spatialPanelObservation } from "../../../helpers/xrSpatialPanelFixture";

const device = { name: "fake", platform: "android", deviceId: "fake-spatial-swipe" } as const;
const refusal =
  "display-input swipe scrolling is unsupported on XR spatial panels; use tapOn/tapAny node click or keyboard focus keys instead";

class RecordingAutoTargetSelector extends AutoTargetSelector {
  readonly candidates: Element[][] = [];

  override selectAutoTargetScrollable(
    ...args: Parameters<AutoTargetSelector["selectAutoTargetScrollable"]>
  ): Element | null {
    this.candidates.push(args[0]);
    return super.selectAutoTargetScrollable(...args);
  }
}

function setup(
  spatial = true,
  talkBack = false,
  xr = true,
  capture: boolean | "host-missing" = false,
) {
  const observation = spatialPanelObservation(capture);
  if (!spatial) {
    const panel = observation.viewHierarchy!.windows!.find((window) => window.id === 93)!;
    panel.bounds = structuredClone(observation.backStack!.tasks[0]!.bounds);
  }
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const adb = new FakeAdbClient();
  const service = new FakeCtrlProxy(timer);
  service.setHierarchyData(
    wireHierarchyFrom({
      updatedAt: 0,
      packageName: observation.activeWindow!.appId!,
      hierarchy: observation.viewHierarchy!.windows![0]!.hierarchy!,
    }),
  );
  service.setViewHierarchyResult(observation.viewHierarchy!);
  service.setSupportsNodeActionSelectors(true);
  service.setActionResult({ success: true, action: "scroll_forward", totalTimeMs: 1 });
  const gesture = new FakeGestureExecutor();
  const observe = new FakeObserveScreen();
  observe.setObserveResult(observation);
  const accessibilityDetector = new FakeAccessibilityDetector();
  accessibilityDetector.setDefaultResult(talkBack, talkBack ? "talkback" : "unknown");
  const selector = new RecordingAutoTargetSelector();
  const swipe = new SwipeOn(device, adb, {
    autoTargetSelector: selector,
    timer,
    observeScreen: observe,
    xrDetector: new FakeAndroidXrDetector(xr),
    executeGesture: gesture,
    accessibilityService: service,
    accessibilityDetector,
    lastRenderedObservation: () => observation,
    visionConfig: { ...DEFAULT_VISION_CONFIG, enabled: false },
  });
  swipe.observedInteraction = runBlockWithEnvelope(() => recordObservationRead(observation), {
    observation,
  });
  return { swipe, gesture, service, adb, observation, selector };
}

const paths: Array<[string, SwipeOnOptions]> = [
  ["unscoped auto-target", { direction: "up" }],
  ["container elementId", { direction: "up", container: { elementId: "s2-d4898bda13fe07ef" } }],
  ["container text", { direction: "up", container: { text: "Item 1" } }],
  ["screen", { direction: "up", autoTarget: false }],
  ["boomerang", { direction: "up", boomerang: true }],
  ["scroll search", { direction: "up", lookFor: { text: "uncaptured item", maxTime: 1000 } }],
  [
    "container scroll search",
    {
      direction: "up",
      container: { elementId: "s2-d4898bda13fe07ef" },
      lookFor: { text: "uncaptured item", maxTime: 1000 },
    },
  ],
];

for (const capture of [false, "host-missing"] as const) {
  for (const display of [undefined, "0"]) {
    for (const [path, options] of paths) {
      test(`SpatialPanel refuses ${path} before display input (display=${display}, capture=${capture})`, async () => {
        const { swipe, gesture, service, adb } = setup(true, false, true, capture);
        const result = await swipe.execute({
          ...options,
          display,
          ...(display && path === "unscoped auto-target" ? { autoTarget: true } : {}),
        });
        expect(result.success).toBe(false);
        expect(result.error).toContain(refusal);
        expect(gesture.getSwipeCalls()).toEqual([]);
        expect(service.getSwipeHistory()).toEqual([]);
        expect(service.getDragHistory()).toEqual([]);
        expect(service.getTwoFingerSwipeHistory()).toEqual([]);
        expect(adb.getAllCommands()).toEqual([]);
      });
    }
  }
}

test("ordinary XR panel auto-target skips captured hidden systemui scrollables", async () => {
  const { swipe, gesture } = setup(false);
  const result = await swipe.execute({ direction: "up" });
  expect(result.success).toBe(true);
  expect(result.targetType).toBe("element");
  expect(result.element?.["visible-to-user"]).not.toBe(false);
  expect(result.element?.bounds).toEqual({ left: 96, top: 192, right: 2672, bottom: 2304 });
  expect(gesture.getSwipeCalls()).toHaveLength(1);
});

test("successful TalkBack semantic scroll bypasses XR display-input refusal", async () => {
  const { gesture, service, adb, observation } = setup(true, true);
  const detector = new FakeAccessibilityDetector();
  detector.setDefaultResult(true, "talkback");
  const executor = new TalkBackSwipeExecutor({
    device,
    adb,
    timer: new FakeTimer(),
    executeGesture: gesture,
    accessibilityService: service,
    accessibilityDetector: detector,
    androidXr: async () => true,
  });
  // A full-tree read uses the captured windows without the duplicate merged roots.
  const fullTree = structuredClone(observation.viewHierarchy!);
  delete fullTree.hierarchy.node;
  service.setViewHierarchyResult(fullTree);
  const element = new DefaultScrollableElementsQuery()
    .findScrollableElements(observation.viewHierarchy!)
    .find((node) => node["resource-id"] === "com.android.systemui:id/launcher_item_viewpager")!;
  const result = await executor.executeSwipeGesture({
    x1: 200,
    y1: 500,
    x2: 100,
    y2: 500,
    direction: "left",
    containerElement: element,
    observation,
  });
  expect(result.success).toBe(true);
  expect(service.getActionHistory()).toEqual([
    { action: "scroll_forward", resourceId: element["resource-id"], timeoutMs: 5000 },
  ]);
  expect(service.getNodeActionHistory()).toEqual([]);
  expect(gesture.getSwipeCalls()).toEqual([]);
  expect(service.getTwoFingerSwipeHistory()).toEqual([]);
  expect(adb.getAllCommands()).toEqual([]);
});

for (const capture of [false, "host-missing"] as const) {
  for (const display of [undefined, "0"]) {
    test(`ordinary XR auto-target skips hidden systemui with display=${display}, capture=${capture}`, async () => {
      const { swipe, gesture, service, adb, selector } = setup(false);
      const result = await swipe.execute({ direction: "up", autoTarget: true, display });
      expect(result.success).toBe(true);
      expect(result.targetType).toBe("element");
      expect(selector.candidates).toHaveLength(1);
      expect(selector.candidates[0]!.length).toBeGreaterThan(0);
      for (const candidate of selector.candidates[0]!) {
        expect(candidate["visible-to-user"]).toBe(true);
        expect(candidate.bounds).toEqual({ left: 96, top: 192, right: 2672, bottom: 2304 });
      }
      expect(
        gesture.getSwipeCalls().length +
          service.getSwipeHistory().length +
          adb.getAllCommands().length,
      ).toBeGreaterThan(0);
    });

    test(`SpatialPanel TalkBack two-finger fallback refuses display=${display}, capture=${capture}`, async () => {
      const { swipe, gesture, service, adb } = setup(true, true, true, capture);
      const result = await swipe.execute({
        direction: "up",
        container: { elementId: "s2-d4898bda13fe07ef" },
        display,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain(refusal);
      expect(gesture.getSwipeCalls()).toEqual([]);
      expect(service.getTwoFingerSwipeHistory()).toEqual([]);
      expect(adb.getAllCommands()).toEqual([]);
    });

    test(`scroll-search screen fallback refuses SpatialPanel with display=${display}, capture=${capture}`, async () => {
      const { swipe, gesture, service, adb, observation } = setup(true, false, true, capture);
      // Remove only scroll affordances from the capture; app content and window/task evidence stay.
      for (const entry of new SearchableHierarchy().project(observation.viewHierarchy!)) {
        if (entry.categories.scrollable) {
          Object.assign(entry.source, {
            scrollable: false,
            class: undefined,
            className: undefined,
            actions: [],
          });
        }
      }
      const result = await swipe.execute({
        direction: "up",
        lookFor: { text: "uncaptured item", maxSwipes: 1 },
        display,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain(refusal);
      expect(gesture.getSwipeCalls()).toEqual([]);
      expect(service.getDragHistory()).toEqual([]);
      expect(service.getSwipeHistory()).toEqual([]);
      expect(adb.getAllCommands()).toEqual([]);
    });
  }
}

test("non-XR coordinate container swipe remains available with the same window geometry", async () => {
  const { swipe, gesture } = setup(true, false, false);
  const result = await swipe.execute({
    direction: "up",
    container: { elementId: "s2-d4898bda13fe07ef" },
  });
  expect(result.success).toBe(true);
  expect(gesture.getSwipeCalls()).toHaveLength(1);
});

for (const display of [undefined, "0"]) {
  test(`SpatialPanel search already-visible target needs no display input (display=${display})`, async () => {
    const { swipe, gesture, service, adb } = setup();
    const result = await swipe.execute({
      direction: "up",
      lookFor: { text: "Item 3", maxSwipes: 1 },
      display,
    });
    expect(result.success).toBe(true);
    expect(gesture.getSwipeCalls()).toEqual([]);
    expect(service.getSwipeHistory()).toEqual([]);
    expect(service.getDragHistory()).toEqual([]);
    expect(service.getTwoFingerSwipeHistory()).toEqual([]);
    expect(adb.getAllCommands()).toEqual([]);
  });
}
