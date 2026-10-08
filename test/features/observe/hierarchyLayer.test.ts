import { describe, expect, test } from "bun:test";
import { CTRL_PROXY_PACKAGE } from "../../../src/ctrlProxy/constants";
import {
  assertAppGestureNotUnderOverlay,
  hasOwnOverlay,
  ownOverlayCoversPoint,
  scopeHierarchyForSelector,
  scopeHierarchyToLayer,
  scopeObserveResultToLayer,
} from "../../../src/features/observe/hierarchyLayer";
import { INTERACTIVE_OVERLAY_WINDOW_TYPE } from "../../../src/features/observe/ownOverlayFocus";
import { ResolverElementSelector } from "../../../src/features/utility/ResolverElementSelector";
import { ActionableError } from "../../../src/models/ActionableError";
import type { ObserveResult } from "../../../src/models/ObserveResult";
import type {
  ViewHierarchyNode,
  ViewHierarchyResult,
} from "../../../src/models/ViewHierarchyResult";
import {
  attachRawViewHierarchy,
  getRawViewHierarchy,
} from "../../../src/utils/viewHierarchySearch";
import {
  OVERLAY_CAPTURE,
  PROTOTYPE_CAPTURE,
  capturedAppLayerOverlayHierarchy,
  capturedOverlayHierarchy,
  capturedTwoWindowHierarchy,
  observationOf,
} from "../../helpers/overlayWindowCapture";

// Captured Recents overview with its floating window relabelled as the CtrlProxy
// overlay; see test/helpers/overlayWindowCapture.ts for what is and is not captured.
const APP_WINDOW_ID = OVERLAY_CAPTURE.appWindowId;
const OVERLAY_WINDOW_ID = OVERLAY_CAPTURE.overlayWindowId;
const LAUNCHER_PACKAGE = OVERLAY_CAPTURE.appPackage;
const captureWithOverlay = () => capturedOverlayHierarchy();
const convertedCapture = () => capturedTwoWindowHierarchy();

function windowRoots(
  hierarchy: ViewHierarchyResult,
): Array<ViewHierarchyNode & { windowId?: number }> {
  const root = hierarchy.hierarchy as ViewHierarchyNode;
  return Array.isArray(root.node) ? root.node : root.node ? [root.node] : [];
}

function rootWindowIds(hierarchy: ViewHierarchyResult): number[] {
  return windowRoots(hierarchy).map((child) => child.windowId!);
}

function windowRoot(hierarchy: ViewHierarchyResult, windowId: number): ViewHierarchyNode {
  return windowRoots(hierarchy).find((root) => root.windowId === windowId)!;
}

function selectSettings(hierarchy: ViewHierarchyResult): number | undefined {
  const selection = new ResolverElementSelector().selectByText(hierarchy, "Settings", {
    partialMatch: false,
  });
  return selection.element?.bounds.top;
}

describe("scopeHierarchyToLayer (#9305)", () => {
  test("the relabelled capture is recognized as having the overlay", () => {
    expect(hasOwnOverlay(captureWithOverlay())).toBe(true);
    expect(hasOwnOverlay(convertedCapture())).toBe(false);
  });

  test("omitted layer returns the capture unchanged, overlay included", () => {
    const hierarchy = captureWithOverlay();
    expect(scopeHierarchyToLayer(hierarchy, undefined)).toBe(hierarchy);
    expect(rootWindowIds(hierarchy)).toContain(OVERLAY_WINDOW_ID);
  });

  test('"app" removes the overlay window and its nodes and leaves the input untouched', () => {
    const hierarchy = captureWithOverlay();
    const before = structuredClone(hierarchy);
    const scoped = scopeHierarchyToLayer(hierarchy, "app");

    expect(rootWindowIds(scoped)).not.toContain(OVERLAY_WINDOW_ID);
    expect(rootWindowIds(scoped)).toContain(APP_WINDOW_ID);
    expect(scoped.windows!.map((window) => window.id)).not.toContain(OVERLAY_WINDOW_ID);
    expect(scoped.windows!.some((window) => window.id === APP_WINDOW_ID)).toBe(true);
    expect(structuredClone(hierarchy)).toEqual(before);
  });

  test('"app" keeps app node identity so node-identity checks still hold', () => {
    const hierarchy = captureWithOverlay();
    const scopedRoots = windowRoots(scopeHierarchyToLayer(hierarchy, "app"));
    expect(scopedRoots).toContain(windowRoot(hierarchy, APP_WINDOW_ID));
  });

  test('"app" never leaves the overlay as the active window or the capture package', () => {
    const hierarchy = captureWithOverlay();
    hierarchy.packageName = CTRL_PROXY_PACKAGE;
    hierarchy.windows = hierarchy.windows!.map((window) => ({
      ...window,
      isActive: window.id === OVERLAY_WINDOW_ID,
      isFocused: window.id === OVERLAY_WINDOW_ID,
      ...(window.id === APP_WINDOW_ID ? { packageName: LAUNCHER_PACKAGE } : {}),
    }));
    const scoped = scopeHierarchyToLayer(hierarchy, "app");
    expect(scoped.windows!.some((window) => window.isActive || window.isFocused)).toBe(false);
    expect(scoped.packageName).toBe(LAUNCHER_PACKAGE);
  });

  test('"overlay" keeps only the overlay window and its nodes', () => {
    const scoped = scopeHierarchyToLayer(captureWithOverlay(), "overlay");
    expect(rootWindowIds(scoped)).toEqual([OVERLAY_WINDOW_ID]);
    expect(scoped.windows!.map((window) => window.id)).toEqual([OVERLAY_WINDOW_ID]);
  });

  test("a capture without the overlay is unchanged for app and empty for overlay", () => {
    const hierarchy = convertedCapture();
    expect(scopeHierarchyToLayer(hierarchy, "app")).toBe(hierarchy);
    expect(rootWindowIds(scopeHierarchyToLayer(hierarchy, "overlay"))).toEqual([]);
  });

  test("an attached raw capture is scoped the same way", () => {
    const projected = captureWithOverlay();
    const raw = captureWithOverlay();
    attachRawViewHierarchy(projected, raw);
    const scoped = scopeHierarchyToLayer(projected, "app");
    const scopedRaw = getRawViewHierarchy(scoped)!;
    expect(scopedRaw).not.toBe(raw);
    expect(rootWindowIds(scopedRaw)).not.toContain(OVERLAY_WINDOW_ID);
  });

  test("repeated scoping of one capture returns the same object", () => {
    const hierarchy = captureWithOverlay();
    expect(scopeHierarchyToLayer(hierarchy, "app")).toBe(scopeHierarchyToLayer(hierarchy, "app"));
  });
});

describe("selector resolution with layer (#9305)", () => {
  test("text in both windows resolves to the overlay by default and to the app for app", () => {
    const hierarchy = captureWithOverlay();
    const overlayTop = windowRoot(hierarchy, OVERLAY_WINDOW_ID).bounds!.top;

    const byDefault = selectSettings(scopeHierarchyForSelector(hierarchy, undefined));
    const forApp = selectSettings(scopeHierarchyForSelector(hierarchy, "app"));
    const forOverlay = selectSettings(scopeHierarchyForSelector(hierarchy, "overlay"));

    expect(byDefault).toBeGreaterThanOrEqual(overlayTop);
    expect(forOverlay).toBe(byDefault);
    expect(forApp).toBeDefined();
    expect(forApp!).toBeLessThan(overlayTop);
  });

  test('"overlay" with no overlay showing is an actionable error', () => {
    expect(() => scopeHierarchyForSelector(convertedCapture(), "overlay")).toThrow(ActionableError);
    expect(() => scopeHierarchyForSelector(convertedCapture(), "overlay")).toThrow(
      /no AutoMobile overlay is showing/,
    );
  });
});

describe("assertAppGestureNotUnderOverlay (#9305)", () => {
  test("refuses an app gesture inside the overlay window and allows one outside it", () => {
    const hierarchy = captureWithOverlay();
    const overlay = hierarchy.windows!.find((window) => window.id === OVERLAY_WINDOW_ID)!;
    const inside = { x: 540, y: overlay.bounds!.bottom - 10 };
    const outside = { x: 540, y: overlay.bounds!.top - 10 };

    expect(() => assertAppGestureNotUnderOverlay(hierarchy, "app", inside, "tap")).toThrow(
      /overlay window covers that point/,
    );
    expect(() => assertAppGestureNotUnderOverlay(hierarchy, "app", outside, "tap")).not.toThrow();
  });

  test("a full-screen overlay covers every app point", () => {
    const hierarchy = capturedOverlayHierarchy({ fullScreen: true });
    expect(ownOverlayCoversPoint(hierarchy, { x: 130, y: 578 })).toBe(true);
    expect(ownOverlayCoversPoint(capturedTwoWindowHierarchy(), { x: 130, y: 578 })).toBe(false);
  });

  test("default and overlay layers never refuse", () => {
    const hierarchy = captureWithOverlay();
    const point = { x: 540, y: 2000 };
    expect(() => assertAppGestureNotUnderOverlay(hierarchy, undefined, point, "tap")).not.toThrow();
    expect(() => assertAppGestureNotUnderOverlay(hierarchy, "overlay", point, "tap")).not.toThrow();
  });
});

describe("scopeObserveResultToLayer (#9305)", () => {
  const observation = (viewHierarchy: ViewHierarchyResult): ObserveResult => ({
    ...observationOf(viewHierarchy),
    activeWindow: {
      appId: LAUNCHER_PACKAGE,
      activityName: "",
      layoutSeqSum: 0,
      type: INTERACTIVE_OVERLAY_WINDOW_TYPE,
    },
  });

  test("omitted layer returns the observation itself", () => {
    const result = observation(captureWithOverlay());
    expect(scopeObserveResultToLayer(result, undefined, "android")).toBe(result);
  });

  test('"app" rebuilds elements without overlay nodes and drops the overlay window type', () => {
    const result = observation(captureWithOverlay());
    const scoped = scopeObserveResultToLayer(result, "app", "android");
    const labels = (elements: ObserveResult["elements"]) =>
      (elements?.clickable ?? []).map((element) => element.text ?? element["content-desc"]);

    expect(scoped).not.toBe(result);
    expect(scoped.activeWindow?.type).toBeUndefined();
    expect(scoped.activeWindow?.appId).toBe(LAUNCHER_PACKAGE);
    expect(labels(result.elements)).toEqual(expect.arrayContaining(["YouTube", "Screenshot"]));
    expect(labels(scoped.elements)).not.toContain("YouTube");
    expect(labels(scoped.elements)).toContain("Screenshot");
    const overlayOnly = labels(scopeObserveResultToLayer(result, "overlay", "android").elements);
    expect(overlayOnly).toContain("YouTube");
    expect(overlayOnly).not.toContain("Screenshot");
    expect(result.viewHierarchy).toEqual(captureWithOverlay());
  });
});

describe('app-layer prototype windows (window.layer "app", aovl D4)', () => {
  // Captured: CtrlProxy's TYPE_APPLICATION_OVERLAY window (a11y TYPE_SYSTEM, no overlay metadata)
  // floating over the Playground, beside SystemUI's TYPE_SYSTEM status bar.
  const selectByText = (hierarchy: ViewHierarchyResult, text: string) =>
    new ResolverElementSelector().selectByText(hierarchy, text, { partialMatch: false }).element;

  test("the captured app-layer window is AutoMobile's overlay and the status bar is not", () => {
    const hierarchy = capturedAppLayerOverlayHierarchy();
    expect(hasOwnOverlay(hierarchy)).toBe(true);
    const overlay = scopeHierarchyForSelector(hierarchy, "overlay");
    expect(rootWindowIds(overlay)).toEqual([PROTOTYPE_CAPTURE.appLayerOverlayWindowId]);
    expect(selectByText(overlay, "Bump")).toBeDefined();
  });

  test('"app" excludes the app-layer overlay and keeps the app and status bar', () => {
    const scoped = scopeHierarchyForSelector(capturedAppLayerOverlayHierarchy(), "app");
    expect(rootWindowIds(scoped)).not.toContain(PROTOTYPE_CAPTURE.appLayerOverlayWindowId);
    expect(rootWindowIds(scoped)).toEqual(
      expect.arrayContaining([PROTOTYPE_CAPTURE.appWindowId, PROTOTYPE_CAPTURE.statusBarWindowId]),
    );
    expect(selectByText(scoped, "Bump")).toBeNull();
    expect(scoped.packageName).toBe(PROTOTYPE_CAPTURE.appPackage);
  });

  test('"app" gestures inside the app-layer overlay are refused', () => {
    const hierarchy = capturedAppLayerOverlayHierarchy();
    const bump = selectByText(hierarchy, "Bump")!;
    const point = { x: bump.bounds.left + 5, y: bump.bounds.top + 5 };
    expect(() => assertAppGestureNotUnderOverlay(hierarchy, "app", point, "tap")).toThrow(
      /overlay window covers that point/,
    );
  });
});
