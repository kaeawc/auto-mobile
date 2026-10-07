import { expect, test } from "bun:test";
import { recordObservationRead } from "../../../src/features/observe/observationReadScope";
import { DEFAULT_VISION_CONFIG } from "../../../src/vision";
import { TapAnyElement } from "../../../src/features/action/TapAnyElement";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { resolveTapAtCoordinates } from "../../../src/features/action/TapAtCoordinate";
import { ResolverElementSelector } from "../../../src/features/utility/ResolverElementSelector";
import {
  hasVisibleScreenPart,
  screenSizeForOffscreenCheck,
} from "../../../src/features/utility/ElementGeometry";
import type {
  Element,
  ElementSelectionResult,
  ObserveResult,
  ViewHierarchyResult,
} from "../../../src/models";
import type { ScreenSizeForOffscreenCheckOptions } from "../../../src/models/ScreenSize";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeElementSelector } from "../../fakes/FakeElementSelector";
import { FakeTapStrategy } from "../../fakes/FakeTapStrategy";
import { FakeTimer } from "../../fakes/FakeTimer";
import { selectionFixtureDevice } from "../../fixtures/issue8379SelectionHierarchy";

// Issue #6523: every tap path judges "is the target off screen" against the size
// of the display the tap targets (the captured panel), in the element bounds'
// coordinate space, never the default display's size. These tests use a cover
// panel (1080x2364) that is narrower than the default display (2076x2152).
const cover = { width: 1080, height: 2364 };
const defaultDisplay = { width: 2076, height: 2152 };
const display = { displayId: 3, panelUniqueId: "cover" };
// Centre x=1500 lies inside the default display but outside the cover panel.
const target: Element = {
  bounds: { left: 1400, right: 1600, top: 100, bottom: 200 },
  text: "Panel target",
  clickable: true,
  enabled: true,
};
const options: ScreenSizeForOffscreenCheckOptions = {
  platform: "android",
  iosMultiPanel: false,
  observationScreenSize: cover,
  display,
};

function coverHierarchy(overrides: Partial<ViewHierarchyResult> = {}): ViewHierarchyResult {
  return {
    hierarchy: { node: [{ ...target }] },
    screenWidth: cover.width,
    screenHeight: cover.height,
    ...display,
    ...overrides,
  };
}

function selectionFor(element: Element): ElementSelectionResult {
  return { element, indexInMatches: 0, totalMatches: 1, strategy: "first" };
}

function newTapOn(): TapOnElement {
  return new TapOnElement(selectionFixtureDevice("android", 1), new FakeAdbExecutor(), {
    timer: new FakeTimer(),
  });
}

function newTapAny(selected: Element): TapAnyElement {
  return new TapAnyElement(selectionFixtureDevice("android", 1), new FakeAdbExecutor(), {
    timer: new FakeTimer(),
    elementSelector: new FakeElementSelector(selected),
  });
}

test("helper: secondary panel uses its own captured size, not the default display's", () => {
  const resolved = screenSizeForOffscreenCheck(coverHierarchy(), {
    ...options,
    observationScreenSize: defaultDisplay,
  });
  expect(resolved).toEqual(cover);
  expect(!hasVisibleScreenPart(target.bounds, resolved)).toBe(true);
  expect(!hasVisibleScreenPart(target.bounds, defaultDisplay)).toBe(false);
});

test("helper: observation of another display is not borrowed when the capture size is missing", () => {
  const hierarchy = coverHierarchy({ screenWidth: undefined, screenHeight: undefined });
  expect(
    screenSizeForOffscreenCheck(hierarchy, {
      ...options,
      observationScreenSize: defaultDisplay,
      display: { displayId: 0, panelUniqueId: "default" },
    }),
  ).toBeUndefined();
  expect(screenSizeForOffscreenCheck(hierarchy, options)).toEqual(cover);
});

test("helper: unknown or zero size never refuses", () => {
  expect(!hasVisibleScreenPart(target.bounds, undefined)).toBe(false);
  expect(!hasVisibleScreenPart(target.bounds, { width: 0, height: 0 })).toBe(false);
});

// The default display's size is supplied as the observation size in the next
// two tests, so they fail if the check reads it instead of the panel's capture.
const wrongSizeOptions: ScreenSizeForOffscreenCheckOptions = {
  ...options,
  observationScreenSize: defaultDisplay,
};
const inside: Element = { ...target, bounds: { left: 100, right: 200, top: 100, bottom: 200 } };

test("resolver selector path rejects a centre outside the targeted panel", () => {
  // ResolverElementSelector is the selector tapOn and tapAny construct by default.
  const selector = new ResolverElementSelector(undefined, undefined, wrongSizeOptions);
  expect(selector.selectByText(coverHierarchy(), target.text!).element).toBeNull();
  // Positive control: same hierarchy shape and text, centre inside the panel.
  const found = selector.selectByText(
    coverHierarchy({ hierarchy: { node: [{ ...inside }] } }),
    target.text!,
  ).element;
  expect(found?.bounds).toEqual(inside.bounds);
});

test("tapAny path rejects a centre outside the targeted panel and accepts one inside", () => {
  expect(
    newTapAny(target)["findClickableElement"]({ action: "tap" }, coverHierarchy(), wrongSizeOptions)
      .element,
  ).toBeNull();
  expect(
    newTapAny(inside)["findClickableElement"]({ action: "tap" }, coverHierarchy(), wrongSizeOptions)
      .element,
  ).toBe(inside);
});

test("tapOn default path resolves the panel's size and refuses the off-panel target", () => {
  const tapOn = newTapOn();
  const hierarchy = coverHierarchy();
  const size = tapOn["getScreenSizeFromHierarchy"](hierarchy, {
    ...options,
    observationScreenSize: defaultDisplay,
  });
  expect(size).toEqual(cover);
  expect(tapOn["isElementTapTargetOffScreen"](selectionFor(target), hierarchy, size)).toBe(true);
});

async function runTapOn(bounds: Element["bounds"]) {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const tapOn = new TapOnElement(selectionFixtureDevice("android", 1), new FakeAdbExecutor(), {
    timer,
    tapStrategy: new FakeTapStrategy(),
    visionConfig: { ...DEFAULT_VISION_CONFIG, enabled: false },
    selectionStateTracker: { prepare: async () => null, finalize: async () => [] },
  });
  const capture: ViewHierarchyResult = {
    screenWidth: cover.width,
    screenHeight: cover.height,
    hierarchy: {
      bounds: { left: 0, top: 0, right: cover.width, bottom: cover.height },
      node: { ...target, bounds },
    },
  };
  const observation: ObserveResult = {
    observationId: "straddle",
    updatedAt: 1,
    // Wrong on purpose: the default display's size must not win over the capture.
    screenSize: defaultDisplay,
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    viewHierarchy: capture,
  };
  const points: Array<{ x: number; y: number }> = [];
  tapOn.observedInteraction = async (action) => ({
    ...(await action(recordObservationRead(observation))),
    observation,
  });
  tapOn.refreshViewHierarchy = async () => capture;
  tapOn.executeAndroidTap = async (_action, x, y) => {
    points.push({ x, y });
  };
  tapOn.deriveTapEffectAfterPostTapObservation = async (_before, current) => ({
    observation: current,
  });
  tapOn.captureTerminalObservationScreenshot = async () => {};
  tapOn.recordDeferredPredictionOutcome = async () => {};
  tapOn.enforceFreshnessConsistencyWithEffect = () => {};
  const result = await tapOn.execute({ text: target.text, action: "tap" });
  return { result, points };
}

test("tapOn end to end taps an element whose centre is inside the panel", async () => {
  const { result, points } = await runTapOn({ left: 1000, right: 1060, top: 100, bottom: 200 });
  expect(result.success).toBe(true);
  expect(points).toEqual([{ x: 1030, y: 150 }]);
});

test("tapOn end to end taps the visible part of an element straddling the panel edge", async () => {
  const { result, points } = await runTapOn({ left: 1070, right: 1100, top: 100, bottom: 200 });
  expect(result.success).toBe(true);
  expect(points).toEqual([{ x: 1075, y: 150 }]);
});

test("tapAt path refuses a coordinate outside the targeted panel's observation size", () => {
  const observation = { screenSize: cover } as ObserveResult;
  expect("error" in resolveTapAtCoordinates({ x: 1500, y: 150 }, observation, "android")).toBe(
    true,
  );
  expect(resolveTapAtCoordinates({ x: 500, y: 150 }, observation, "android")).toEqual({
    x: 500,
    y: 150,
  });
});
