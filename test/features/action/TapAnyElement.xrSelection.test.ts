import { recordObservationRead } from "../../../src/features/observe/observationReadScope";
import { buildObserveResult } from "../../helpers/observeFixture";
import { runBlockWith } from "../../helpers/observedInteractionStub";
import { FakeCtrlProxy } from "../../fakes/FakeCtrlProxy";
import { FakeAccessibilityDetector } from "../../fakes/FakeAccessibilityDetector";
import { FakeAndroidXrDetector } from "../../fakes/FakeAndroidXrDetector";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { TapAnyElement } from "../../../src/features/action/TapAnyElement";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { identifyObservedHierarchy } from "../../../src/features/observe/HierarchyCapture";
import { findTapAnyClickableElement } from "../../../src/features/action/tapAnyTargetGeometry";
import { ResolverElementSelector } from "../../../src/features/utility/ResolverElementSelector";
import type { ViewHierarchyResult, TapAnyElementOptions } from "../../../src/models";
import { FakeTimer } from "../../fakes/FakeTimer";

const capture: {
  viewHierarchy: ViewHierarchyResult;
  screenSize: { width: number; height: number };
} = JSON.parse(
  readFileSync(
    new URL(
      "../../fixtures/android-xr/observe-settings-home-hidden-systemui.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const hierarchy = identifyObservedHierarchy("android", capture.viewHierarchy, "cached-ok", {
  timer: new FakeTimer(),
}).hierarchy;
const selector = new ResolverElementSelector();
function select(xr: boolean, container?: TapAnyElementOptions["container"]) {
  return findTapAnyClickableElement(
    {
      elementSelector: selector,
      isContainerAvailable: () => true,
      platform: "android",
      iosMultiPanel: false,
      xr,
    },
    { action: "tap", container },
    hierarchy,
    { observationScreenSize: capture.screenSize },
  ).element;
}

test.each([
  [undefined, { left: 48, top: 60, right: 568, bottom: 164 }],
  [{ text: "Apps" }, { left: 48, top: 548, right: 696, bottom: 724 }],
  [
    { elementId: "com.android.settings:id/homepage_container" },
    { left: 48, top: 196, right: 696, bottom: 372 },
  ],
] as const)("XR tapAny reads visible rows in order: %j", (container, bounds) => {
  expect(select(true, container)?.bounds).toEqual(bounds);
});

test("non-XR selection retains hidden OK, leaf-container miss and smallest Sound row", () => {
  expect(select(false)?.["resource-id"]).toBe("com.android.systemui:id/button2");
  expect(select(false, { text: "Apps" })).toBeNull();
  expect(
    select(false, { elementId: "com.android.settings:id/homepage_container" })?.bounds,
  ).toEqual({ left: 48, top: 1252, right: 696, bottom: 1328 });
});

test("tapAny prepares the shared XR verdict before selecting an Apps owner row", async () => {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const detector = new FakeAndroidXrDetector(true);
  const adb = new FakeAdbClient();
  const service = new FakeCtrlProxy(timer);
  service.setSupportsNodeActionSelectors(true);
  service.setActionResult({ success: true, action: "click", totalTimeMs: 1 });
  const action = new TapAnyElement(
    { name: "fake", platform: "android", deviceId: "fake-xr-selection" },
    adb,
    {
      timer,
      xrDetector: detector,
      elementSelector: selector,
      accessibilityDetector: new FakeAccessibilityDetector(),
      accessibilityService: service,
    },
  );
  // Use authoritative window trees; JSON serialization duplicates the merged roots.
  const tree = { ...structuredClone(capture.viewHierarchy), hierarchy: {} };
  action.observedInteraction = runBlockWith(() =>
    recordObservationRead(
      buildObserveResult({
        viewHierarchy: tree,
        screenSize: capture.screenSize,
        updatedAt: 0,
        systemInsets: { top: 0, left: 0, right: 0, bottom: 0 },
      }),
    ),
  );
  action.testHooks.setRefreshViewHierarchy(async () => null);
  const result = await action.execute({ action: "tap", container: { text: "Apps" } });
  expect(result.success).toBe(true);
  expect(result.element?.bounds).toEqual({ left: 48, top: 548, right: 696, bottom: 724 });
  expect(detector.queries.length).toBeGreaterThan(0);
  expect(service.getNodeActionHistory()).toHaveLength(1);
  expect(adb.getAllCommands()).toHaveLength(0);
});
