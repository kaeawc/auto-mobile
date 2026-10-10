import { describe, expect, test } from "bun:test";
import { CTRL_PROXY_PACKAGE } from "../../../src/ctrlProxy/constants";
import {
  assertAppGestureNotUnderPrototype,
  hasOwnPrototype,
  ownPrototypeCoversPoint,
  scopeHierarchyForSelector,
  scopeHierarchyToLayer,
  scopeObserveResultToLayer,
} from "../../../src/features/observe/hierarchyLayer";
import { PROTOTYPE_WINDOW_TYPE } from "../../../src/features/observe/ownWindowFocus";
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
  RELABELLED_CAPTURE,
  PROTOTYPE_CAPTURE,
  capturedAppLayerPrototypeHierarchy,
  capturedFloatingCoverHierarchy,
  capturedPrototypeHierarchy,
  capturedTwoWindowHierarchy,
  observationOf,
} from "../../helpers/prototypeWindowCapture";

// Captured Recents overview with its floating window relabelled as the CtrlProxy
// prototype; see test/helpers/prototypeWindowCapture.ts for what is and is not captured.
const APP_WINDOW_ID = RELABELLED_CAPTURE.appWindowId;
const PROTOTYPE_WINDOW_ID = RELABELLED_CAPTURE.prototypeWindowId;
const LAUNCHER_PACKAGE = RELABELLED_CAPTURE.appPackage;
const captureWithPrototype = () => capturedPrototypeHierarchy();
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
  test("the relabelled capture is recognized as having the prototype", () => {
    expect(hasOwnPrototype(captureWithPrototype())).toBe(true);
    expect(hasOwnPrototype(convertedCapture())).toBe(false);
  });

  test("omitted layer returns the capture unchanged, prototype included", () => {
    const hierarchy = captureWithPrototype();
    expect(scopeHierarchyToLayer(hierarchy, undefined)).toBe(hierarchy);
    expect(rootWindowIds(hierarchy)).toContain(PROTOTYPE_WINDOW_ID);
  });

  test('"app" removes the prototype window and its nodes and leaves the input untouched', () => {
    const hierarchy = captureWithPrototype();
    const before = structuredClone(hierarchy);
    const scoped = scopeHierarchyToLayer(hierarchy, "app");

    expect(rootWindowIds(scoped)).not.toContain(PROTOTYPE_WINDOW_ID);
    expect(rootWindowIds(scoped)).toContain(APP_WINDOW_ID);
    expect(scoped.windows!.map((window) => window.id)).not.toContain(PROTOTYPE_WINDOW_ID);
    expect(scoped.windows!.some((window) => window.id === APP_WINDOW_ID)).toBe(true);
    expect(structuredClone(hierarchy)).toEqual(before);
  });

  test('"app" keeps app node identity so node-identity checks still hold', () => {
    const hierarchy = captureWithPrototype();
    const scopedRoots = windowRoots(scopeHierarchyToLayer(hierarchy, "app"));
    expect(scopedRoots).toContain(windowRoot(hierarchy, APP_WINDOW_ID));
  });

  test('"app" never leaves the prototype as the active window or the capture package', () => {
    const hierarchy = captureWithPrototype();
    hierarchy.packageName = CTRL_PROXY_PACKAGE;
    hierarchy.windows = hierarchy.windows!.map((window) => ({
      ...window,
      isActive: window.id === PROTOTYPE_WINDOW_ID,
      isFocused: window.id === PROTOTYPE_WINDOW_ID,
      ...(window.id === APP_WINDOW_ID ? { packageName: LAUNCHER_PACKAGE } : {}),
    }));
    const scoped = scopeHierarchyToLayer(hierarchy, "app");
    expect(scoped.windows!.some((window) => window.isActive || window.isFocused)).toBe(false);
    expect(scoped.packageName).toBe(LAUNCHER_PACKAGE);
  });

  test('"prototype" keeps only the prototype window and its nodes', () => {
    const scoped = scopeHierarchyToLayer(captureWithPrototype(), "prototype");
    expect(rootWindowIds(scoped)).toEqual([PROTOTYPE_WINDOW_ID]);
    expect(scoped.windows!.map((window) => window.id)).toEqual([PROTOTYPE_WINDOW_ID]);
  });

  test("a capture without the prototype is unchanged for app and empty for prototype", () => {
    const hierarchy = convertedCapture();
    expect(scopeHierarchyToLayer(hierarchy, "app")).toBe(hierarchy);
    expect(rootWindowIds(scopeHierarchyToLayer(hierarchy, "prototype"))).toEqual([]);
  });

  test("an attached raw capture is scoped the same way", () => {
    const projected = captureWithPrototype();
    const raw = captureWithPrototype();
    attachRawViewHierarchy(projected, raw);
    const scoped = scopeHierarchyToLayer(projected, "app");
    const scopedRaw = getRawViewHierarchy(scoped)!;
    expect(scopedRaw).not.toBe(raw);
    expect(rootWindowIds(scopedRaw)).not.toContain(PROTOTYPE_WINDOW_ID);
  });

  test("repeated scoping of one capture returns the same object", () => {
    const hierarchy = captureWithPrototype();
    expect(scopeHierarchyToLayer(hierarchy, "app")).toBe(scopeHierarchyToLayer(hierarchy, "app"));
  });
});

describe("selector resolution with layer (#9305)", () => {
  test("text in both windows resolves to the prototype by default and to the app for app", () => {
    const hierarchy = captureWithPrototype();
    const prototypeTop = windowRoot(hierarchy, PROTOTYPE_WINDOW_ID).bounds!.top;

    const byDefault = selectSettings(scopeHierarchyForSelector(hierarchy, undefined));
    const forApp = selectSettings(scopeHierarchyForSelector(hierarchy, "app"));
    const forPrototype = selectSettings(scopeHierarchyForSelector(hierarchy, "prototype"));

    expect(byDefault).toBeGreaterThanOrEqual(prototypeTop);
    expect(forPrototype).toBe(byDefault);
    expect(forApp).toBeDefined();
    expect(forApp!).toBeLessThan(prototypeTop);
  });

  test('"prototype" with no prototype showing is an actionable error', () => {
    expect(() => scopeHierarchyForSelector(convertedCapture(), "prototype")).toThrow(
      ActionableError,
    );
    expect(() => scopeHierarchyForSelector(convertedCapture(), "prototype")).toThrow(
      /no AutoMobile prototype is showing/,
    );
  });

  test('"prototype" while the prototype is suspended says the app is not in front', () => {
    const suspended = { ...convertedCapture(), prototypeSuspended: true };
    expect(() => scopeHierarchyForSelector(suspended, "prototype")).toThrow(
      /hidden because the app it was shown over is not in front/,
    );
    expect(() => scopeHierarchyForSelector(convertedCapture(), "prototype")).not.toThrow(
      /not in front/,
    );
  });
});

describe("assertAppGestureNotUnderPrototype (#9305)", () => {
  test("refuses an app gesture inside the prototype window and allows one outside it", () => {
    const hierarchy = captureWithPrototype();
    const prototype = hierarchy.windows!.find((window) => window.id === PROTOTYPE_WINDOW_ID)!;
    const inside = { x: 540, y: prototype.bounds!.bottom - 10 };
    const outside = { x: 540, y: prototype.bounds!.top - 10 };

    expect(() => assertAppGestureNotUnderPrototype(hierarchy, "app", inside, "tap")).toThrow(
      /prototype window covers that point/,
    );
    expect(() => assertAppGestureNotUnderPrototype(hierarchy, "app", outside, "tap")).not.toThrow();
  });

  test("a full-screen prototype covers every app point", () => {
    const hierarchy = capturedPrototypeHierarchy({ fullScreen: true });
    expect(ownPrototypeCoversPoint(hierarchy, { x: 130, y: 578 })).toBe(true);
    expect(ownPrototypeCoversPoint(capturedTwoWindowHierarchy(), { x: 130, y: 578 })).toBe(false);
  });

  test("default and prototype layers never refuse", () => {
    const hierarchy = captureWithPrototype();
    const point = { x: 540, y: 2000 };
    expect(() =>
      assertAppGestureNotUnderPrototype(hierarchy, undefined, point, "tap"),
    ).not.toThrow();
    expect(() =>
      assertAppGestureNotUnderPrototype(hierarchy, "prototype", point, "tap"),
    ).not.toThrow();
  });
});

describe("scopeObserveResultToLayer (#9305)", () => {
  const observation = (viewHierarchy: ViewHierarchyResult): ObserveResult => ({
    ...observationOf(viewHierarchy),
    activeWindow: {
      appId: LAUNCHER_PACKAGE,
      activityName: "",
      layoutSeqSum: 0,
      type: PROTOTYPE_WINDOW_TYPE,
    },
  });

  test("omitted layer returns the observation itself", () => {
    const result = observation(captureWithPrototype());
    expect(scopeObserveResultToLayer(result, undefined, "android")).toBe(result);
  });

  test('"app" rebuilds elements without prototype nodes and drops the prototype window type', () => {
    const result = observation(captureWithPrototype());
    const scoped = scopeObserveResultToLayer(result, "app", "android");
    const labels = (elements: ObserveResult["elements"]) =>
      (elements?.clickable ?? []).map((element) => element.text ?? element["content-desc"]);

    expect(scoped).not.toBe(result);
    expect(scoped.activeWindow?.type).toBeUndefined();
    expect(scoped.activeWindow?.appId).toBe(LAUNCHER_PACKAGE);
    expect(labels(result.elements)).toEqual(expect.arrayContaining(["YouTube", "Screenshot"]));
    expect(labels(scoped.elements)).not.toContain("YouTube");
    expect(labels(scoped.elements)).toContain("Screenshot");
    const prototypeOnly = labels(
      scopeObserveResultToLayer(result, "prototype", "android").elements,
    );
    expect(prototypeOnly).toContain("YouTube");
    expect(prototypeOnly).not.toContain("Screenshot");
    expect(result.viewHierarchy).toEqual(captureWithPrototype());
  });
});

describe('app-layer prototype windows (window.layer "app", aovl D4)', () => {
  // Captured: CtrlProxy's TYPE_APPLICATION_OVERLAY window (a11y TYPE_SYSTEM, no prototype metadata)
  // floating over the Playground, beside SystemUI's TYPE_SYSTEM status bar.
  const selectByText = (hierarchy: ViewHierarchyResult, text: string) =>
    new ResolverElementSelector().selectByText(hierarchy, text, { partialMatch: false }).element;

  test("the captured app-layer window is AutoMobile's prototype and the status bar is not", () => {
    const hierarchy = capturedAppLayerPrototypeHierarchy();
    expect(hasOwnPrototype(hierarchy)).toBe(true);
    const prototype = scopeHierarchyForSelector(hierarchy, "prototype");
    expect(rootWindowIds(prototype)).toEqual([PROTOTYPE_CAPTURE.appLayerPrototypeWindowId]);
    expect(selectByText(prototype, "Bump")).toBeDefined();
  });

  test('"app" excludes the app-layer prototype and keeps the app and status bar', () => {
    const scoped = scopeHierarchyForSelector(capturedAppLayerPrototypeHierarchy(), "app");
    expect(rootWindowIds(scoped)).not.toContain(PROTOTYPE_CAPTURE.appLayerPrototypeWindowId);
    expect(rootWindowIds(scoped)).toEqual(
      expect.arrayContaining([PROTOTYPE_CAPTURE.appWindowId, PROTOTYPE_CAPTURE.statusBarWindowId]),
    );
    expect(selectByText(scoped, "Bump")).toBeNull();
    expect(scoped.packageName).toBe(PROTOTYPE_CAPTURE.appPackage);
  });

  test("CtrlProxy's full-screen highlight window (same type, no nodes) is not a prototype", () => {
    // Highlight shown with SYSTEM_ALERT_WINDOW granted: TYPE_APPLICATION_OVERLAY, FLAG_NOT_TOUCHABLE.
    const hierarchy = capturedAppLayerPrototypeHierarchy();
    const highlight = {
      id: 999,
      type: 3,
      packageName: CTRL_PROXY_PACKAGE,
      bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
    };
    hierarchy.windows = [
      ...hierarchy.windows!.filter(
        (window) => window.id !== PROTOTYPE_CAPTURE.appLayerPrototypeWindowId,
      ),
      highlight,
    ];
    expect(hasOwnPrototype(hierarchy)).toBe(false);
    expect(() => scopeHierarchyForSelector(hierarchy, "prototype")).toThrow(
      /no AutoMobile prototype is showing/,
    );
    expect(() =>
      assertAppGestureNotUnderPrototype(hierarchy, "app", { x: 540, y: 2000 }, "tap"),
    ).not.toThrow();
  });

  test('"app" gestures inside the app-layer prototype are refused', () => {
    const hierarchy = capturedAppLayerPrototypeHierarchy();
    const bump = selectByText(hierarchy, "Bump")!;
    const point = { x: bump.bounds.left + 5, y: bump.bounds.top + 5 };
    expect(() => assertAppGestureNotUnderPrototype(hierarchy, "app", point, "tap")).toThrow(
      /prototype window covers that point/,
    );
  });
});

describe("app rows under a floating prototype (#10608/#10544, aovl D6 host half)", () => {
  // The unfiltered wire capture still holds button_elevated under the floating prototype; the
  // device's occlusion pass dropped it from the ordinary capture. Once a capture keeps the row,
  // layer "app" must return it and a tap on it must be refused as covered, not "not found".
  const elevated = (hierarchy: ViewHierarchyResult) =>
    new ResolverElementSelector().selectByResourceId(hierarchy, "button_elevated").element;

  test('"app" returns the covered row and the tap guard refuses its centre', () => {
    const hierarchy = capturedFloatingCoverHierarchy();
    const row = elevated(scopeHierarchyForSelector(hierarchy, "app"));
    expect(row).toBeDefined();
    const centre = {
      x: Math.floor((row!.bounds.left + row!.bounds.right) / 2),
      y: Math.floor((row!.bounds.top + row!.bounds.bottom) / 2),
    };
    expect(() => assertAppGestureNotUnderPrototype(hierarchy, "app", centre, "tap")).toThrow(
      /an AutoMobile prototype window covers that point/,
    );
    expect(elevated(scopeHierarchyForSelector(hierarchy, "prototype"))).toBeNull();
  });
});

describe("a highlight window with no prototype (#11346)", () => {
  const highlightOnly = () => {
    const hierarchy = capturedTwoWindowHierarchy();
    hierarchy.windows = [
      ...hierarchy.windows!,
      { id: 999, type: 4, isActive: true, packageName: CTRL_PROXY_PACKAGE },
    ];
    return hierarchy;
  };

  test("is not a showing prototype for layer scoping", () => {
    const hierarchy = highlightOnly();
    expect(hasOwnPrototype(hierarchy)).toBe(false);
    expect(scopeHierarchyToLayer(hierarchy, "app")).toBe(hierarchy);
    expect(() => scopeHierarchyForSelector(hierarchy, "prototype")).toThrow(ActionableError);
  });
});
