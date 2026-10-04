import { expect, test } from "bun:test";
import { TapAnyElement } from "../../../src/features/action/TapAnyElement";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { projectActionableHierarchy } from "../../../src/features/observe/HierarchyNormalization";
import { DefaultElementSelector } from "../../../src/features/utility/DefaultElementSelector";
import { DefaultElementFinder } from "../../../src/features/utility/ElementFinder";
import { screenSizeForOffscreenCheck } from "../../../src/features/utility/ElementGeometry";
import type { Element, ElementSelectionResult, ViewHierarchyResult } from "../../../src/models";
import type {
  ScreenSize,
  ScreenSizeForOffscreenCheckOptions,
} from "../../../src/models/ScreenSize";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeElementSelector } from "../../fakes/FakeElementSelector";
import { FakeTimer } from "../../fakes/FakeTimer";
import { selectionFixtureDevice } from "../../fixtures/issue8379SelectionHierarchy";
import { iosProjectionFixture } from "../../fixtures/iosProjectionFixture";

interface Row {
  name: string;
  captureSize?: ScreenSize;
  options?: ScreenSizeForOffscreenCheckOptions;
  captureDisplay?: ScreenSizeForOffscreenCheckOptions["display"];
  center: [number, number];
  resolvedSize?: ScreenSize;
  offscreen: boolean;
  projectedIos?: boolean;
}

const small = { width: 100, height: 80 };
const large = { width: 200, height: 160 };
const landscape = { width: 160, height: 100 };
const portrait = { width: 100, height: 160 };
const rows: Row[] = [
  {
    name: "sizes agree: on-screen",
    captureSize: small,
    options: { observationScreenSize: small },
    center: [50, 40],
    resolvedSize: small,
    offscreen: false,
  },
  {
    name: "sizes agree: off-screen",
    captureSize: small,
    options: { observationScreenSize: small },
    center: [150, 40],
    resolvedSize: small,
    offscreen: true,
  },
  // The resolver prefers capture geometry even when the scenario labels it stale.
  {
    name: "stale observation: capture wins",
    captureSize: large,
    options: { observationScreenSize: small },
    center: [150, 40],
    resolvedSize: large,
    offscreen: false,
  },
  {
    name: "stale hierarchy: capture still wins",
    captureSize: small,
    options: { observationScreenSize: large },
    center: [150, 40],
    resolvedSize: small,
    offscreen: true,
  },
  {
    name: "observation fallback: matching display",
    captureDisplay: { displayId: 7, panelUniqueId: "external" },
    options: { observationScreenSize: small, display: { displayId: 7, panelUniqueId: "external" } },
    center: [150, 40],
    resolvedSize: small,
    offscreen: true,
  },
  {
    name: "observation ignored: displayId mismatch",
    captureDisplay: { displayId: 7, panelUniqueId: "external" },
    options: { observationScreenSize: small, display: { displayId: 0, panelUniqueId: "external" } },
    center: [150, 40],
    offscreen: false,
  },
  {
    name: "observation ignored: panelUniqueId mismatch",
    captureDisplay: { displayId: 7, panelUniqueId: "external" },
    options: { observationScreenSize: small, display: { displayId: 7, panelUniqueId: "default" } },
    center: [150, 40],
    offscreen: false,
  },
  { name: "no usable size: unknown is accepted", center: [150, 130], offscreen: false },
  {
    name: "rotated sizes: inside capture only",
    captureSize: landscape,
    options: { observationScreenSize: portrait },
    center: [130, 50],
    resolvedSize: landscape,
    offscreen: false,
  },
  {
    name: "rotated sizes: inside observation only",
    captureSize: landscape,
    options: { observationScreenSize: portrait },
    center: [50, 130],
    resolvedSize: landscape,
    offscreen: true,
  },
  {
    name: "iOS projection stamp beats stale metadata and observation",
    projectedIos: true,
    captureSize: { width: 20, height: 20 },
    options: { observationScreenSize: { width: 20, height: 20 } },
    center: [70, 70],
    resolvedSize: { width: 100, height: 100 },
    offscreen: false,
  },
  {
    name: "centre exactly at right edge",
    captureSize: small,
    options: { observationScreenSize: small },
    center: [100, 40],
    resolvedSize: small,
    offscreen: false,
  },
  {
    name: "centre exactly at bottom edge",
    captureSize: small,
    options: { observationScreenSize: small },
    center: [50, 80],
    resolvedSize: small,
    offscreen: false,
  },
  {
    name: "centre exactly at right and bottom edges",
    captureSize: small,
    options: { observationScreenSize: small },
    center: [100, 80],
    resolvedSize: small,
    offscreen: false,
  },
];

// Exercise the same pure path boundaries as ScreenSizeForOffscreenCheck.test.ts.
// No action execution, device transport, real timer, or navigation DB is needed.
test.each(rows)("cross-path off-screen agreement: $name", (row) => {
  const [x, y] = row.center;
  const target: Element = {
    bounds: { left: x - 5, right: x + 5, top: y - 5, bottom: y + 5 },
    text: "Cross-path target",
    clickable: true,
    enabled: true,
  };
  const hierarchy: ViewHierarchyResult = row.projectedIos
    ? projectActionableHierarchy("ios", iosProjectionFixture())
    : { hierarchy: {} };
  // Preserve the stamped tree identity while replacing its candidates with one
  // hand-built target. This tests geometry, not device-text parsing/projection.
  hierarchy.hierarchy.node = [{ ...target }];
  hierarchy.screenWidth = row.captureSize?.width;
  hierarchy.screenHeight = row.captureSize?.height;
  Object.assign(hierarchy, row.captureDisplay);
  const platform = row.projectedIos ? "ios" : "android";
  const options: ScreenSizeForOffscreenCheckOptions = {
    ...row.options,
    platform,
    iosMultiPanel: false,
  };
  const finder = new DefaultElementFinder();
  expect(finder.findElementsByText(hierarchy, target.text!)).toEqual([target]);
  const selector = new DefaultElementSelector(finder, options);
  const device = selectionFixtureDevice(platform, 1);
  // The fake deliberately returns the target unfiltered, so tapAny's own check
  // must reject off-screen rows independently of the selector's filtering.
  const tapAny = new TapAnyElement(device, new FakeAdbExecutor(), {
    timer: new FakeTimer(),
    elementSelector: new FakeElementSelector(target),
  });
  const tapOn = new TapOnElement(device, new FakeAdbExecutor(), { timer: new FakeTimer() });
  const selection: ElementSelectionResult = {
    element: target,
    indexInMatches: 0,
    totalMatches: 1,
    strategy: "first",
  };
  const tapOnSize = tapOn["getScreenSizeFromHierarchy"](hierarchy, options);
  expect(screenSizeForOffscreenCheck(hierarchy, options)).toEqual(row.resolvedSize);
  expect(tapOnSize).toEqual(row.resolvedSize);
  const verdicts = {
    selector: selector.selectByText(hierarchy, target.text!).element === null,
    tapAny: tapAny["findClickableElement"]({ action: "tap" }, hierarchy, options).element === null,
    tapOn: tapOn["isElementTapTargetOffScreen"](selection, hierarchy, tapOnSize),
  };
  expect(verdicts).toEqual({
    selector: row.offscreen,
    tapAny: row.offscreen,
    tapOn: row.offscreen,
  });
});
