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
import type {
  ViewHierarchyResult,
  ViewHierarchyNode,
  TapAnyElementOptions,
} from "../../../src/models";
import { SearchableHierarchy } from "../../../src/features/utility/SearchableNode";
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
function select(xr: boolean, container?: TapAnyElementOptions["container"], tree = hierarchy) {
  return findTapAnyClickableElement(
    {
      elementSelector: selector,
      isContainerAvailable: () => true,
      platform: "android",
      iosMultiPanel: false,
      xr,
    },
    { action: "tap", container },
    tree,
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

// Compose windows from the real Settings capture, keeping their node schema.
function settingsControl(text: string, top: number) {
  const source = new SearchableHierarchy()
    .project(hierarchy)
    .find((entry) => entry.displayedLabel === "Apps" && !entry.actionable)!.source;
  return {
    ...structuredClone(source),
    text,
    "resource-id": `com.android.settings:id/${text}`,
    clickable: true,
    bounds: { left: 48, top, right: 696, bottom: top + 100 },
  };
}

test.each([false, true])("topmost same-app window wins before reading order (XR=%s)", (xr) => {
  const app = capture.viewHierarchy.windows!.find((window) => window.id === 38)!;
  const tree = {
    ...capture.viewHierarchy,
    hierarchy: {},
    windows: [
      capture.viewHierarchy.windows!.find((window) => window.id === 1)!,
      { ...app, id: 90, windowLayer: 100, hierarchy: settingsControl("Dialog", 300) },
      { ...app, hierarchy: settingsControl("Background", 10) },
    ],
  };
  expect(select(xr, undefined, tree)?.text).toBe("Dialog");
});

test.each([
  ["non-leaf", 1, 100, false],
  ["over-quarter-window", 1, 400, true],
  ["full-window", 1, 100, true],
  ["too-deep", 4, 100, true],
  ["other-clickable-descendant", 2, 100, true],
  ["small-owner", 3, 100, true],
  ["quarter-window", 3, 332, true],
  ["viewport-fallback", 3, 100, true],
  ["viewport-fallback-oversized", 1, 3000, true],
] as const)("XR leaf fallback bounds its owner: %s", (kind, levels, height, leaf) => {
  const app = structuredClone(capture.viewHierarchy.windows!.find((window) => window.id === 38)!);
  const label = {
    ...settingsControl("Header", 300),
    clickable: false,
    bounds: { left: 48, top: 300, right: 68, bottom: 310 },
  };
  const bounds = { left: 0, top: 300, right: 744, bottom: 300 + height };
  // The non-leaf child is deliberately not clickable, so only the fallback could select the owner.
  let branch: ViewHierarchyNode = leaf
    ? label
    : { ...label, node: [{ ...settingsControl("Child", 300), clickable: false }] };
  for (let depth = 1; depth < levels; depth++) {
    branch = { ...settingsControl("", 300), clickable: false, bounds, node: [branch] };
  }
  const owner = {
    ...settingsControl("Owner", 300),
    bounds,
    node: [
      branch,
      // Nest the other control so the guard must inspect descendants, not just children.
      ...(kind === "other-clickable-descendant"
        ? [{ ...settingsControl("", 300), clickable: false, node: [settingsControl("Other", 350)] }]
        : []),
    ],
  };
  const root: ViewHierarchyNode = {
    ...settingsControl("", 0),
    clickable: false,
    node: [owner],
    bounds: kind === "full-window" ? bounds : { left: 0, top: 0, right: 744, bottom: 1328 },
  };
  if (kind.startsWith("viewport-fallback")) {
    delete root.bounds;
  }
  app.hierarchy = { node: [root] };
  app.bounds = kind === "full-window" ? bounds : app.bounds;
  const tree = { ...capture.viewHierarchy, hierarchy: {}, windows: [app] };
  const selected = select(true, { text: "Header" }, tree);
  if (kind === "small-owner" || kind === "quarter-window" || kind === "viewport-fallback") {
    expect(selected?.text).toBe("Owner");
    expect(selected?.bounds).toEqual(bounds);
  } else {
    expect(selected).toBeNull();
  }
  expect(select(false, { text: "Header" }, tree)).toBeNull();
});
