import { describe, expect, test } from "bun:test";
import { CtrlProxyHierarchy } from "../../../../src/features/observe/ios/CtrlProxyHierarchy";
import type {
  HierarchyDelegateContext,
  XCTestHierarchy,
} from "../../../../src/features/observe/ios/types";
import {
  assertAppGestureNotUnderOverlay,
  hasOwnOverlay,
  ownOverlayCoversPoint,
  scopeHierarchyForSelector,
  scopeHierarchyToLayer,
  scopeObserveResultToLayer,
} from "../../../../src/features/observe/hierarchyLayer";
import { SearchableHierarchy } from "../../../../src/features/utility/SearchableNode";
import type { ObserveResult } from "../../../../src/models/ObserveResult";
import type { ViewHierarchyResult } from "../../../../src/models/ViewHierarchyResult";
import { iosFloatingOverlayOverSettings } from "../../../fixtures/observe/iosOverlayWindow";

// Captured Settings with the overlay agent's floating card in a second UIWindow (iphone D2); see
// test/fixtures/observe-output/ios-overlay-window/README.txt.
const OVERLAY_IDS = ["automobile-overlay-dismiss", "like-button", "close-button", "floating-card"];
const APP_IDS = ["Toolbar", "Settings"];

function convert(raw: XCTestHierarchy = iosFloatingOverlayOverSettings()): ViewHierarchyResult {
  return new CtrlProxyHierarchy({} as HierarchyDelegateContext).convertToViewHierarchyResult(raw);
}

/** The captured tree with only the window at `index` (0 = Settings, 1 = the overlay agent's). */
function onlyWindow(index: number): ViewHierarchyResult {
  const raw = iosFloatingOverlayOverSettings();
  raw.hierarchy.node = (raw.hierarchy.node as unknown[]).slice(
    index,
    index + 1,
  ) as typeof raw.hierarchy.node;
  return convert(raw);
}

/** The runner's unconverted tree, which keeps the UIWindow wrappers. */
function unconverted(): ViewHierarchyResult {
  return iosFloatingOverlayOverSettings() as unknown as ViewHierarchyResult;
}

function ids(hierarchy: ViewHierarchyResult): Set<string> {
  return new Set(
    new SearchableHierarchy()
      .project(hierarchy)
      .flatMap((entry) => (entry.nativeId ? [entry.nativeId] : [])),
  );
}

describe("iOS overlay agent window with layer (iphone D2)", () => {
  test("the converted capture has the overlay and both layers split it from Settings", () => {
    const hierarchy = convert();
    expect(hasOwnOverlay(hierarchy)).toBe(true);

    const overlay = ids(scopeHierarchyForSelector(hierarchy, "overlay"));
    const app = ids(scopeHierarchyForSelector(hierarchy, "app"));
    for (const id of OVERLAY_IDS) {
      expect(overlay.has(id)).toBe(true);
      expect(app.has(id)).toBe(false);
    }
    for (const id of APP_IDS) {
      expect(app.has(id)).toBe(true);
      expect(overlay.has(id)).toBe(false);
    }
  });

  test("the unconverted runner tree is split at the agent's UIWindow", () => {
    const hierarchy = unconverted();
    expect(hasOwnOverlay(hierarchy)).toBe(true);
    expect(ids(scopeHierarchyToLayer(hierarchy, "overlay")).has("like-button")).toBe(true);
    expect(ids(scopeHierarchyToLayer(hierarchy, "overlay")).has("Toolbar")).toBe(false);
    expect(ids(scopeHierarchyToLayer(hierarchy, "app")).has("like-button")).toBe(false);
    expect(ids(scopeHierarchyToLayer(hierarchy, "app")).has("Toolbar")).toBe(true);
  });

  test("when only the agent's window contributes nodes, all of them are the overlay's", () => {
    const hierarchy = onlyWindow(1);
    expect(hasOwnOverlay(hierarchy)).toBe(true);
    expect(ids(scopeHierarchyToLayer(hierarchy, "overlay")).has("like-button")).toBe(true);
    expect(ids(scopeHierarchyToLayer(hierarchy, "app")).has("like-button")).toBe(false);
  });

  test("Settings alone has no overlay, so layer overlay is the actionable error", () => {
    const hierarchy = onlyWindow(0);
    expect(hasOwnOverlay(hierarchy)).toBe(false);
    expect(scopeHierarchyToLayer(hierarchy, "app")).toBe(hierarchy);
    expect(() => scopeHierarchyForSelector(hierarchy, "overlay")).toThrow(
      /no AutoMobile overlay is showing/,
    );
  });

  test("an app gesture is refused only where the agent's content or dismiss control is", () => {
    const hierarchy = convert();
    const like = { x: 96, y: 802 };
    const dismiss = { x: 372, y: 84 };
    const settingsRow = { x: 200, y: 213 };
    expect(ownOverlayCoversPoint(hierarchy, like)).toBe(true);
    expect(ownOverlayCoversPoint(hierarchy, dismiss)).toBe(true);
    expect(ownOverlayCoversPoint(hierarchy, settingsRow)).toBe(false);
    expect(() => assertAppGestureNotUnderOverlay(hierarchy, "app", like, "tap")).toThrow(
      /overlay window covers that point/,
    );
    expect(() =>
      assertAppGestureNotUnderOverlay(hierarchy, "app", settingsRow, "tap"),
    ).not.toThrow();
  });

  test("observe with layer overlay returns the agent's controls", () => {
    const viewHierarchy = convert();
    const result: ObserveResult = {
      updatedAt: 1,
      display: { key: "default", role: "unknown", posture: "unknown", generation: 0 },
      screenSize: { width: 402, height: 874 },
      systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
      viewHierarchy,
    };
    const scoped = scopeObserveResultToLayer(result, "overlay", "ios");
    const labels = (scoped.elements?.clickable ?? []).map((element) => element.text);
    expect(labels).toEqual(expect.arrayContaining(["Like", "Close", "Dismiss overlay"]));
    expect(labels).not.toContain("Search");
  });
});
