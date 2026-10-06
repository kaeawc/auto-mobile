import { issue8379Hierarchy } from "../../fixtures/issue8379Hierarchy";
import { RealWaitForCondition } from "../../../src/features/observe/WaitForCondition";
import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import type { ObserveResult, ViewHierarchyResult } from "../../../src/models";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { TapAnyElement } from "../../../src/features/action/TapAnyElement";
import { DragAndDrop } from "../../../src/features/action/DragAndDrop";
import { SetUIState } from "../../../src/features/action/SetUIState";
import { SearchableHierarchy } from "../../../src/features/utility/SearchableNode";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAccessibilityDetector } from "../../fakes/FakeAccessibilityDetector";
import { FakeHierarchyCapture } from "../../fakes/FakeHierarchyCapture";
import { FakeObserveScreen } from "../../fakes/FakeObserveScreen";
import { FakeScreenshotCapturer } from "../../fakes/FakeScreenshotCapturer";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  installInMemoryNavManager,
  type InMemoryNavManagerHarness,
} from "../../helpers/navigationTestHarness";
import {
  duoSelectionText,
  duoSelectionBounds,
  selectionFixtureDevice,
} from "../../fixtures/issue8379SelectionHierarchy";
import androidHome from "../../fixtures/observe/android-home.json";

let navigation: InMemoryNavManagerHarness;
const restores: Array<() => void> = [];
beforeAll(async () => {
  navigation = await installInMemoryNavManager();
  // Pay the one-time cold-start cost of the tap/settle path (lazy parse + first JIT, ~10 ms) here,
  // outside the 100 ms per-test budget, with a throwaway tap whose result nothing asserts.
  const { tap } = tapHarness(observation(androidCapture(true)));
  await tap.execute({
    text: "Screen size target",
    action: "tap",
    selectionStrategy: "first",
    searchUntil: { duration: 100 },
    retryIfNoChange: false,
  });
  for (const restore of restores.splice(0)) {
    restore();
  }
});
afterEach(() => {
  for (const restore of restores.splice(0)) {
    restore();
  }
});
afterAll(async () => {
  await navigation.dispose();
});

function androidCapture(duplicates = false): ViewHierarchyResult {
  const capture = structuredClone(androidHome.viewHierarchy);
  const entry = new SearchableHierarchy()
    .project(capture)
    .find((node) => node.affordances.includes("tap") && node.element?.text);
  if (!entry) {
    throw new Error("Captured Android home has no labelled tap target");
  }
  const target = structuredClone(entry.source);
  // Translate and duplicate a captured node to model stale/off-screen geometry.
  // These derived coordinates are not a new parser capture.
  target.text = "Screen size target";
  target.bounds = { left: 40, top: 100, right: 140, bottom: 200 };
  const offscreen = structuredClone(target);
  offscreen.bounds = { left: 40, top: 2500, right: 140, bottom: 2600 };
  offscreen["view-id"] = "derived-offscreen";
  capture.hierarchy.node = duplicates ? [offscreen, target] : [target];
  delete capture.screenWidth;
  delete capture.screenHeight;
  delete capture.packageName;
  return capture;
}

function observation(viewHierarchy: ViewHierarchyResult): ObserveResult {
  return {
    observationId: "screen-size-wiring",
    display: { key: "0", role: "unknown", posture: "unknown", generation: 0 },
    updatedAt: 1,
    screenSize: { width: 1080, height: 2400 },
    systemInsets: { left: 0, right: 0, top: 0, bottom: 0 },
    viewHierarchy,
    activeWindow: { appId: "fixture", activityName: "Before", layoutSeqSum: 1 },
  };
}

function tapHarness(initial: ObserveResult, capturedAfterTap = initial.viewHierarchy!) {
  // The post-tap settle only accepts a capture whose device timestamp is strictly newer than the
  // one it started from. Reads that all carry the fixture's identical timestamp never settle, so
  // the settle polled out its full 2.5 s fake-time budget (17 polls, ~5 ms real) in the first test.
  const baseUpdatedAt = initial.viewHierarchy?.updatedAt ?? 0;
  const capturedAt = (index: number): ViewHierarchyResult => ({
    ...capturedAfterTap,
    updatedAt: baseUpdatedAt + index,
  });
  const refreshed = capturedAt(1);
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const observe = new FakeObserveScreen();
  observe.setObserveResult((index) =>
    index === 0
      ? initial
      : {
          ...initial,
          observationId: "after-tap",
          updatedAt: 2,
          viewHierarchy: capturedAt(index),
          activeWindow: { appId: "fixture", activityName: "After", layoutSeqSum: 2 },
        },
  );
  const device = selectionFixtureDevice("android", 1);
  delete device.displays;
  const tap = new TapOnElement(device, new FakeAdbExecutor(), {
    lastRenderedObservation: () => initial,
    timer,
    waitForCondition: new RealWaitForCondition(observe, timer),
    hierarchyCapture: new FakeHierarchyCapture(() => refreshed),
    accessibilityDetector: new FakeAccessibilityDetector(),
    screenshotCapturer: new FakeScreenshotCapturer(),
  });
  tap.observeScreen = observe;
  const window = spyOn(tap.window, "getCachedActiveWindow").mockResolvedValue(null);
  const dispatch = spyOn(tap["accessibilityService"], "requestTapCoordinates").mockResolvedValue({
    success: true,
  });
  restores.push(
    () => window.mockRestore(),
    () => dispatch.mockRestore(),
  );
  return { tap, dispatch };
}

test("tapOn refreshed Android display without metadata keeps unknown size tappable", async () => {
  const initialCapture = androidCapture();
  initialCapture.hierarchy.node = [];
  initialCapture.displayId = 0;
  initialCapture.panelUniqueId = "default";
  const refreshed = androidCapture();
  refreshed.displayId = 0;
  refreshed.panelUniqueId = "external";
  const initial = observation(initialCapture);
  const { tap, dispatch } = tapHarness(initial, refreshed);
  const result = await tap.execute({
    text: "Screen size target",
    action: "tap",
    display: "0",
    searchUntil: { duration: 100 },
    retryIfNoChange: false,
  });
  expect(result.error).toBeUndefined();
  expect(result.success).toBe(true);
  expect(initial.screenSize).toEqual({ width: 0, height: 0 });
  expect(dispatch).toHaveBeenCalled();
});

test("tapOn first selection filters off-screen duplicate with observation fallback", async () => {
  const initial = observation(androidCapture(true));
  const { tap, dispatch } = tapHarness(initial);
  const result = await tap.execute({
    text: "Screen size target",
    action: "tap",
    selectionStrategy: "first",
    searchUntil: { duration: 100 },
    retryIfNoChange: false,
  });
  expect(result.error).toBeUndefined();
  expect(result.success).toBe(true);
  expect(result.element?.bounds).toEqual({ left: 40, top: 100, right: 140, bottom: 200 });
  expect(dispatch.mock.calls[0].slice(0, 2)).toEqual([90, 150]);
});

test("tapOn incompatible observation size leaves Android matches unfiltered and taps", async () => {
  const initialCapture = androidCapture();
  initialCapture.hierarchy.node = [];
  initialCapture.displayId = 0;
  initialCapture.panelUniqueId = "default";
  const refreshed = androidCapture(true);
  refreshed.displayId = 7;
  refreshed.panelUniqueId = "external";
  const { tap, dispatch } = tapHarness(observation(initialCapture), refreshed);
  const result = await tap.execute({
    text: "Screen size target",
    action: "tap",
    selectionStrategy: "first",
    searchUntil: { duration: 100 },
    retryIfNoChange: false,
  });
  expect(result.error).toBeUndefined();
  expect(result.success).toBe(true);
  expect(result.element?.bounds).toEqual({ left: 40, top: 2500, right: 140, bottom: 2600 });
  expect(dispatch.mock.calls[0].slice(0, 2)).toEqual([90, 2550]);
});

test.each(["TapOnElement", "TapAnyElement", "DragAndDrop", "SetUIState"] as const)(
  "%s constructs its default selector with the iOS screen-size order",
  (action) => {
    const device = selectionFixtureDevice("ios", 1);
    const timer = new FakeTimer();
    const adb = new FakeAdbExecutor();
    const capture = issue8379Hierarchy();
    const target = structuredClone(capture.hierarchy.node!.node![0]);
    target.$ = {
      ...target.$,
      text: duoSelectionText,
      bounds: duoSelectionBounds,
      clickable: "true",
      enabled: "true",
    };
    capture.hierarchy.node!.node = [target];
    const selectors = {
      TapOnElement: () => new TapOnElement(device, adb, { timer })["elementSelector"],
      TapAnyElement: () => new TapAnyElement(device, adb, { timer })["elementSelector"],
      DragAndDrop: () => new DragAndDrop(device, adb, timer)["selector"],
      SetUIState: () => new SetUIState(device, adb, { timer })["selector"],
    };
    // No size or platform options are supplied to the constructed selector.
    expect(selectors[action]().selectByText(capture, duoSelectionText).element?.bounds).toEqual(
      duoSelectionBounds,
    );
  },
);
