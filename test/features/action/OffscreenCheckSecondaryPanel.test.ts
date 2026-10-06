import { expect, test } from "bun:test";
import { TapAnyElement } from "../../../src/features/action/TapAnyElement";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { resolveTapAtCoordinates } from "../../../src/features/action/TapAtCoordinate";
import { DefaultElementSelector } from "../../../src/features/utility/DefaultElementSelector";
import { DefaultElementFinder } from "../../../src/features/utility/ElementFinder";
import {
  isElementCenterOffScreen,
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
  expect(isElementCenterOffScreen(target.bounds, resolved)).toBe(true);
  expect(isElementCenterOffScreen(target.bounds, defaultDisplay)).toBe(false);
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
  expect(isElementCenterOffScreen(target.bounds, undefined)).toBe(false);
  expect(isElementCenterOffScreen(target.bounds, { width: 0, height: 0 })).toBe(false);
});

test("selector path rejects a centre outside the targeted panel", () => {
  const selector = new DefaultElementSelector(new DefaultElementFinder(), options);
  expect(selector.selectByText(coverHierarchy(), target.text!).element).toBeNull();
});

test("tapAny path rejects a centre outside the targeted panel and accepts one inside", () => {
  const tapAny = newTapAny(target);
  expect(
    tapAny["findClickableElement"]({ action: "tap" }, coverHierarchy(), options).element,
  ).toBeNull();
  const inside: Element = { ...target, bounds: { left: 100, right: 200, top: 100, bottom: 200 } };
  expect(
    newTapAny(inside)["findClickableElement"]({ action: "tap" }, coverHierarchy(), options).element,
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

test("tapOn keeps tapping the visible part of an element straddling the screen edge", () => {
  // Deliberate difference (owner note on #6523): tapOn clips to the screen and
  // taps the visible part, while the selector and tapAny reject a centre that is
  // outside the screen. Pinned so the divergence stays an explicit decision.
  const straddling: Element = {
    ...target,
    bounds: { left: 1070, right: 1100, top: 100, bottom: 200 },
  };
  const hierarchy = coverHierarchy({ hierarchy: { node: [{ ...straddling }] } });
  expect(isElementCenterOffScreen(straddling.bounds, cover)).toBe(true);
  expect(
    newTapOn()["isElementTapTargetOffScreen"](selectionFor(straddling), hierarchy, cover),
  ).toBe(false);
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
