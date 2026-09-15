import { expect, test } from "bun:test";
import { ScrollUntilVisible } from "../../../../src/features/action/swipeon/ScrollUntilVisible";
import { DefaultElementFinder } from "../../../../src/features/utility/ElementFinder";
import { DefaultElementGeometry } from "../../../../src/features/utility/ElementGeometry";
import { FakeObserveScreen } from "../../../fakes/FakeObserveScreen";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeTalkBackSwipeExecutor } from "../../../fakes/FakeTalkBackSwipeExecutor";
import { FakeAccessibilityDetector } from "../../../fakes/FakeAccessibilityDetector";
import { FakeScrollAccessibilityService } from "../../../fakes/FakeScrollAccessibilityService";
import { FakeOverlayDetector } from "../../../fakes/FakeOverlayDetector";
import { FakeAdbClient } from "../../../fakes/FakeAdbClient";
import type { ObserveResult, ViewHierarchyNode } from "../../../../src/models";

const node = (id: string, left: number, children: ViewHierarchyNode[] = []): ViewHierarchyNode => ({
  $: {
    "resource-id": id,
    bounds: { left, top: 10, right: left + 80, bottom: 90 },
    scrollable: id === "list",
  },
  node: children,
});
const observation = (left: number, found = false, missing = false): ObserveResult => ({
  timestamp: 0,
  screenSize: { width: 400, height: 100 },
  viewHierarchy: {
    hierarchy: {
      node: node("root", 0, [
        node(
          "cart_A",
          left,
          missing ? [] : [node("list", left, found ? [node("target", left)] : [])],
        ),
        node("cart_B", 200, [node("list", 200, [node("target", 200)])]),
      ]),
    },
    screenWidth: 400,
    screenHeight: 100,
  },
});
const container = {
  elementId: "list",
  container: { elementId: "cart_A" },
  selectionStrategy: "unique" as const,
};

function fixture(current: ObserveResult, next: ObserveResult) {
  const observer = new FakeObserveScreen();
  observer.setObserveResult(observation(10));
  const timer = new FakeTimer();
  const runner = new FakeTalkBackSwipeExecutor();
  const scroll = new ScrollUntilVisible({
    device: { deviceId: "nested-scroll", platform: "android", name: "test" },
    finder: new DefaultElementFinder(),
    geometry: new DefaultElementGeometry(),
    observeScreen: observer,
    accessibilityDetector: new FakeAccessibilityDetector(),
    accessibilityService: new FakeScrollAccessibilityService(),
    overlayDetector: new FakeOverlayDetector(),
    adb: new FakeAdbClient(),
    talkBackExecutor: runner,
    timer,
    getDuration: () => 10,
    resolveBoomerangConfig: () => undefined,
    buildPredictionArgs: () => ({}),
    observedInteraction: async (action) => {
      const result = await action(current);
      timer.advanceTime(100);
      return { ...result, observation: next };
    },
  });
  return { scroll, runner };
}

test("lookFor cannot match an overlapping peer in a different list, even with auto selection", async () => {
  const { scroll } = fixture(observation(10), observation(10));
  const tree = observation(10).viewHierarchy!;
  expect(await scroll.findElementInHierarchy({ elementId: "target" }, tree, container)).toBeNull();
  expect(await scroll.findElementInHierarchy({ elementId: "target" }, tree)).toBeNull();
});

test("scroll dispatch and post-scroll search re-resolve the complete container chain", async () => {
  const { scroll, runner } = fixture(observation(100), observation(100, true));
  const result = await scroll.execute({
    direction: "up",
    container,
    lookFor: { elementId: "target", maxTime: 100 },
  });
  expect(result.found).toBe(true);
  expect(result.element?.bounds.left).toBe(100);
  expect(runner.getSwipeCalls()[0].containerElement?.bounds.left).toBe(100);
  expect(runner.getSwipeCalls()[0].x1).toBeGreaterThan(100);
});

test("removing the requested list before dispatch sends no swipe to its peer", async () => {
  const { scroll, runner } = fixture(observation(100, false, true), observation(100));
  await expect(
    scroll.execute({
      direction: "up",
      container,
      lookFor: { elementId: "target", maxTime: 100 },
    }),
  ).rejects.toThrow("target_not_found");
  expect(runner.getCallCount()).toBe(0);
});
