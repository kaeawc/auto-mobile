import { expect, test } from "bun:test";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { TapAnyElement } from "../../../src/features/action/TapAnyElement";
import { DefaultElementParser } from "../../../src/features/utility/ElementParser";
import { resolveElementScreenSize } from "../../../src/features/utility/ElementGeometry";
import { projectActionableHierarchy } from "../../../src/features/observe/HierarchyNormalization";
import type { ObserveResult } from "../../../src/models";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeHierarchyCapture } from "../../fakes/FakeHierarchyCapture";
import { FakeTapStrategy } from "../../fakes/FakeTapStrategy";
import { FakeElementSelector } from "../../fakes/FakeElementSelector";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  duoSelectionBounds,
  duoSelectionText,
  issue8379SelectionHierarchy,
  selectionFixtureDevice,
} from "../../fixtures/issue8379SelectionHierarchy";
import portraitCapture from "../../fixtures/observe/ios-reminders-xctest-noise-before.json";
import { issue8379Hierarchy } from "../../fixtures/issue8379Hierarchy";

test.each([false, true])(
  "tapAny keeps the right-hand target and sizes selection at 951x669 (projected=%s)",
  (projected) => {
    const raw = issue8379SelectionHierarchy();
    const hierarchy = projected ? projectActionableHierarchy("ios", raw, true) : raw;
    const target = new DefaultElementParser().parseNodeBounds(raw.hierarchy.node!.node![1])!;
    const selector = new FakeElementSelector(target);
    let selectedSize: ObserveResult["screenSize"] | undefined;
    selector.selectClickable = (capture) => {
      selectedSize = { width: capture.screenWidth!, height: capture.screenHeight! };
      return { element: target, totalMatches: 1, indexInMatches: 0, strategy: "first" };
    };
    const tap = new TapAnyElement(selectionFixtureDevice(), new FakeAdbExecutor(), {
      timer: new FakeTimer(),
      elementSelector: selector,
    });
    // A fake selector returns the target even when the feature's off-screen check rejects it.
    expect(tap["findClickableElement"]({ action: "tap" }, hierarchy).element?.bounds).toEqual(
      duoSelectionBounds,
    );
    expect(selectedSize).toEqual({ width: 951, height: 669 });
    const real = new TapAnyElement(selectionFixtureDevice(), new FakeAdbExecutor(), {
      timer: new FakeTimer(),
    });
    expect(real["findClickableElement"]({ action: "tap" }, hierarchy).element?.bounds).toEqual(
      duoSelectionBounds,
    );
  },
);

test("tapAny single-panel iOS and Android retain metadata precedence even when bounds/pixels disagree", () => {
  const hierarchy = issue8379Hierarchy();
  const selector = new FakeElementSelector();
  let selectedSize: ObserveResult["screenSize"] | undefined;
  selector.selectClickable = (capture) => {
    selectedSize = { width: capture.screenWidth!, height: capture.screenHeight! };
    return { element: null, totalMatches: 0, indexInMatches: -1, strategy: "first" };
  };
  for (const device of [
    selectionFixtureDevice("ios", 1),
    selectionFixtureDevice("android", 1),
    selectionFixtureDevice("android", 2),
  ]) {
    const tap = new TapAnyElement(device, new FakeAdbExecutor(), {
      timer: new FakeTimer(),
      elementSelector: selector,
    });
    tap["findClickableElement"]({ action: "tap" }, hierarchy, { width: 951, height: 669 });
    expect(selectedSize).toEqual(resolveElementScreenSize(hierarchy));
  }
});

test("tapOn text selection dispatches the derived right-hand target's centre with the real selector", async () => {
  const hierarchy = issue8379SelectionHierarchy();
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const tap = new TapOnElement(selectionFixtureDevice(), new FakeAdbExecutor(), {
    timer,
    hierarchyCapture: new FakeHierarchyCapture(() => hierarchy, "ios"),
    tapStrategy: new FakeTapStrategy(),
    selectionStateTracker: { prepare: async () => null, finalize: async () => [] },
  });
  const observation: ObserveResult = {
    observationId: "derived-geometry",
    updatedAt: 1,
    viewHierarchy: hierarchy,
    screenSize: { width: 951, height: 669 },
  };
  const points: Array<{ x: number; y: number }> = [];
  tap.observedInteraction = async (action) => ({ ...(await action(observation)), observation });
  tap.executeiOSTap = async (_action, x, y) => {
    points.push({ x, y });
  };
  tap.prepareSelectionCapture = async () => null;
  tap.deriveTapEffectAfterPostTapObservation = async (_before, current) => ({
    observation: current,
  });
  tap.captureTerminalObservationScreenshot = async () => {};
  tap.recordDeferredPredictionOutcome = async () => {};
  tap.enforceFreshnessConsistencyWithEffect = () => {};
  const result = await tap.execute({ text: duoSelectionText, action: "tap" });
  expect(result.success).toBe(true);
  expect(points).toEqual([{ x: 750, y: 53 }]);
});

test("tapAny folded portrait stand-in, single iPhone and Android preserve the previous size/offscreen decision", () => {
  // Portrait iPhone capture is a folded-Duo stand-in.
  const hierarchy = structuredClone(portraitCapture.viewHierarchy);
  const selector = new FakeElementSelector();
  let selectedSize: ObserveResult["screenSize"] | undefined;
  selector.selectClickable = (capture) => {
    selectedSize = { width: capture.screenWidth!, height: capture.screenHeight! };
    return { element: null, totalMatches: 0, indexInMatches: -1, strategy: "first" };
  };
  for (const device of [
    selectionFixtureDevice(),
    selectionFixtureDevice("ios", 1),
    selectionFixtureDevice("android"),
  ]) {
    const tap = new TapAnyElement(device, new FakeAdbExecutor(), {
      timer: new FakeTimer(),
      elementSelector: selector,
    });
    tap["findClickableElement"]({ action: "tap" }, hierarchy);
    expect(selectedSize).toEqual(resolveElementScreenSize(hierarchy));
  }
});
