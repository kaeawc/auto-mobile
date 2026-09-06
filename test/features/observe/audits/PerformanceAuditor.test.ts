import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  collectHiddenRegionBounds,
  collectInteractiveObstacles,
  deriveTouchLatencyPoint,
  findAppWindowBounds,
  findInertTouchPoint,
  isHierarchyReliableForTapProbe,
  PerformanceAuditor,
} from "../../../../src/features/observe/audits/PerformanceAuditor";
import { FakeAdbClientFactory } from "../../../fakes/FakeAdbClientFactory";
import {
  NoOpPerformanceTracker,
  setDebugPerfEnabled,
} from "../../../../src/utils/PerformanceTracker";
import { serverConfig } from "../../../../src/utils/ServerConfig";
import type {
  BootedDevice,
  Element,
  ObserveResult,
  ViewHierarchyWindowInfo,
} from "../../../../src/models";

function makeResult(overrides: Partial<ObserveResult> = {}): ObserveResult {
  return {
    updatedAt: "2026-01-01T00:00:00.000Z",
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    ...overrides,
  } as ObserveResult;
}

const androidDevice: BootedDevice = { deviceId: "dev-1", name: "android", platform: "android" };
const iosDevice: BootedDevice = { deviceId: "ios-1", name: "ios", platform: "ios" };

describe("PerformanceAuditor", () => {
  const originalDisablePerfAuditEnv = process.env.AUTOMOBILE_DISABLE_PERF_AUDIT;
  let originalUiPerfMode: boolean;

  beforeEach(() => {
    originalUiPerfMode = serverConfig.isUiPerfModeEnabled();
    serverConfig.setUiPerfMode(true);
    setDebugPerfEnabled(false);
    delete process.env.AUTOMOBILE_DISABLE_PERF_AUDIT;
  });

  afterEach(() => {
    serverConfig.setUiPerfMode(originalUiPerfMode);
    setDebugPerfEnabled(false);
    if (originalDisablePerfAuditEnv === undefined) {
      delete process.env.AUTOMOBILE_DISABLE_PERF_AUDIT;
    } else {
      process.env.AUTOMOBILE_DISABLE_PERF_AUDIT = originalDisablePerfAuditEnv;
    }
  });

  test("does nothing when isEnabled returns false", async () => {
    const auditor = new PerformanceAuditor({
      device: androidDevice,
      adbFactory: new FakeAdbClientFactory(),
      isEnabled: () => false,
    });
    const result = makeResult({
      activeWindow: { appId: "com.example", activityName: "Main" } as any,
    });
    await auditor.run(result, new NoOpPerformanceTracker());
    expect(result.performanceAudit).toBeUndefined();
    expect(result.errors).toBeUndefined();
  });

  test("skips when debug perf is not enabled", async () => {
    const factory = new FakeAdbClientFactory();
    const auditor = new PerformanceAuditor({
      device: androidDevice,
      adbFactory: factory,
    });
    const result = makeResult({
      activeWindow: { appId: "com.example", activityName: "Main" } as any,
    });
    await auditor.run(result, new NoOpPerformanceTracker());
    expect(result.performanceAudit).toBeUndefined();
    expect(result.errors).toBeUndefined();
    expect(factory.wasCalledForDevice(androidDevice.deviceId)).toBe(false);
  });

  test("skips when AUTOMOBILE_DISABLE_PERF_AUDIT is true", async () => {
    setDebugPerfEnabled(true);
    process.env.AUTOMOBILE_DISABLE_PERF_AUDIT = "true";
    const factory = new FakeAdbClientFactory();
    const auditor = new PerformanceAuditor({
      device: androidDevice,
      adbFactory: factory,
    });
    const result = makeResult({
      activeWindow: { appId: "com.example", activityName: "Main" } as any,
    });
    await auditor.run(result, new NoOpPerformanceTracker());
    expect(result.performanceAudit).toBeUndefined();
    expect(result.errors).toBeUndefined();
    expect(factory.wasCalledForDevice(androidDevice.deviceId)).toBe(false);
  });

  test("skips when device platform is not android", async () => {
    const auditor = new PerformanceAuditor({
      device: iosDevice,
      adbFactory: new FakeAdbClientFactory(),
      isEnabled: () => true,
    });
    const result = makeResult({
      activeWindow: { appId: "com.example", activityName: "Main" } as any,
    });
    await auditor.run(result, new NoOpPerformanceTracker());
    expect(result.performanceAudit).toBeUndefined();
    expect(result.errors).toBeUndefined();
  });

  test("skips when no activeWindow.appId is set", async () => {
    const auditor = new PerformanceAuditor({
      device: androidDevice,
      adbFactory: new FakeAdbClientFactory(),
      isEnabled: () => true,
    });
    const result = makeResult();
    await auditor.run(result, new NoOpPerformanceTracker());
    expect(result.performanceAudit).toBeUndefined();
    expect(result.errors).toBeUndefined();
  });

  test("audit failures do not pollute result.errors", async () => {
    setDebugPerfEnabled(true);
    const auditor = new PerformanceAuditor({
      device: androidDevice,
      adbFactory: new FakeAdbClientFactory(),
      isEnabled: () => true,
    });
    const result = makeResult({
      activeWindow: { appId: "com.example", activityName: "Main" } as any,
    });
    await auditor.run(result, new NoOpPerformanceTracker());
    expect(result.errors).toBeUndefined();
  });

  // Regression for https://github.com/kaeawc/auto-mobile/issues/2214.
  // The internal DeviceCapabilitiesDetector and PerformanceAudit constructors
  // require an AdbClientFactory and invoke `.create(device)` on it. Passing
  // anything else surfaces in production as `TypeError: J.create is not a
  // function` (after bundler minification) and silently breaks the audit.
  // Asserting the factory is invoked proves the auditor wires the factory
  // through rather than handing those constructors an AdbExecutor.
  test("uses the injected AdbClientFactory to construct dependents (regression for #2214)", async () => {
    setDebugPerfEnabled(true);
    const factory = new FakeAdbClientFactory();
    const auditor = new PerformanceAuditor({
      device: androidDevice,
      adbFactory: factory,
      isEnabled: () => true,
    });
    const result = makeResult({
      activeWindow: { appId: "com.example", activityName: "Main" } as any,
    });
    await auditor.run(result, new NoOpPerformanceTracker());
    expect(factory.wasCalledForDevice(androidDevice.deviceId)).toBe(true);
  });
});

describe("findAppWindowBounds (#6167)", () => {
  // Real production shape from CtrlProxy's `WindowInfo` wire type
  // (android/control-proxy/.../models/WindowInfo.kt): id/type/isActive/
  // isFocused/bounds only - notably NO per-window packageName. Loaded
  // straight from the actual fixture rather than hand-made, per the #6167
  // follow-up review (the earlier version of this test invented a
  // `packageName` field the real device never emits).
  const androidHomeFixture = JSON.parse(
    readFileSync(resolve(__dirname, "../../../fixtures/observe/android-home.json"), "utf-8"),
  ) as { viewHierarchy: { windows: ViewHierarchyWindowInfo[] } };
  const realWindows = androidHomeFixture.viewHierarchy.windows;

  test("returns undefined when the result has no window list", () => {
    const result = makeResult();
    expect(findAppWindowBounds(result, "com.example")).toBeUndefined();
  });

  test("against the real fixture: picks the focused application window, not the status bar", () => {
    // Fixture has a type=3 (SYSTEM/status bar) window and a focused type=1
    // (APPLICATION) window - neither carries packageName.
    expect(realWindows.some((w) => w.packageName !== undefined)).toBe(false);

    const result = makeResult({
      viewHierarchy: { hierarchy: {} as any, windows: realWindows } as any,
    });

    expect(findAppWindowBounds(result, "com.example")).toEqual({
      left: 0,
      top: 0,
      right: 1080,
      bottom: 2400,
    });
  });

  test("excludes the SystemUI (type=3) window even when it is focused", () => {
    const statusBarBounds = { left: 0, top: 0, right: 1080, bottom: 63 };
    const result = makeResult({
      viewHierarchy: {
        hierarchy: {} as any,
        windows: [
          { id: 67, type: 3, isActive: false, isFocused: true, bounds: statusBarBounds },
          {
            id: 63,
            type: 1,
            isActive: true,
            isFocused: false,
            bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
          },
        ] as ViewHierarchyWindowInfo[],
      } as any,
    });

    expect(findAppWindowBounds(result, "com.example")).toEqual({
      left: 0,
      top: 0,
      right: 1080,
      bottom: 2400,
    });
  });

  test("split-screen lower half: falls back to the non-SystemUI window when none is focused", () => {
    // Split-screen, no window explicitly marked focused in this snapshot -
    // the audited app occupies only the lower half. Real wire shape: no
    // packageName on either window.
    const lowerHalf = { left: 0, top: 960, right: 1080, bottom: 1920 };
    const result = makeResult({
      viewHierarchy: {
        hierarchy: {} as any,
        windows: [
          {
            id: 1,
            type: 3,
            isActive: false,
            isFocused: false,
            bounds: { left: 0, top: 0, right: 1080, bottom: 63 },
          },
          { id: 2, type: 1, isActive: true, isFocused: false, bounds: lowerHalf },
        ] as ViewHierarchyWindowInfo[],
      } as any,
    });

    expect(findAppWindowBounds(result, "com.example")).toEqual(lowerHalf);
  });

  test("returns undefined when only a SystemUI window is present", () => {
    const result = makeResult({
      viewHierarchy: {
        hierarchy: {} as any,
        windows: [
          {
            id: 1,
            type: 3,
            isActive: true,
            isFocused: true,
            bounds: { left: 0, top: 0, right: 1080, bottom: 63 },
          },
        ] as ViewHierarchyWindowInfo[],
      } as any,
    });

    expect(findAppWindowBounds(result, "com.example")).toBeUndefined();
  });

  test("excludes the focused IME (soft keyboard, type=2) window and returns the app window instead", () => {
    // AccessibilityWindowInfo.TYPE_INPUT_METHOD = 2. The keyboard can hold
    // input focus while open, but its bounds are the keyboard's, not the
    // audited app's.
    const appBounds = { left: 0, top: 0, right: 1080, bottom: 1200 };
    const imeBounds = { left: 0, top: 1200, right: 1080, bottom: 2400 };
    const result = makeResult({
      viewHierarchy: {
        hierarchy: {} as any,
        windows: [
          { id: 1, type: 1, isActive: true, isFocused: false, bounds: appBounds },
          { id: 2, type: 2, isActive: true, isFocused: true, bounds: imeBounds },
        ] as ViewHierarchyWindowInfo[],
      } as any,
    });

    expect(findAppWindowBounds(result, "com.example")).toEqual(appBounds);
  });

  test("returns undefined when the only window is a focused IME (no app window to fall back to)", () => {
    const result = makeResult({
      viewHierarchy: {
        hierarchy: {} as any,
        windows: [
          {
            id: 1,
            type: 2,
            isActive: true,
            isFocused: true,
            bounds: { left: 0, top: 1200, right: 1080, bottom: 2400 },
          },
        ] as ViewHierarchyWindowInfo[],
      } as any,
    });

    expect(findAppWindowBounds(result, "com.example")).toBeUndefined();
  });
});

describe("findInertTouchPoint (#6167)", () => {
  const appWindow = { left: 0, top: 0, right: 1080, bottom: 1920 };

  function button(bounds: { left: number; top: number; right: number; bottom: number }): Element {
    return { bounds, clickable: true } as Element;
  }

  test("avoids a button at the window center, landing on inert space instead", () => {
    // A button covering the exact center point the naive fixed-fraction
    // default used to tap.
    const centerButton = button({ left: 440, top: 900, right: 640, bottom: 1020 });

    const result = findInertTouchPoint(appWindow, [centerButton]);

    expect(result.inert).toBe(true);
    const { x, y } = result.point;
    const insideButton =
      x >= centerButton.bounds.left &&
      x < centerButton.bounds.right &&
      y >= centerButton.bounds.top &&
      y < centerButton.bounds.bottom;
    expect(insideButton).toBe(false);
    // Still inside the app window.
    expect(x).toBeGreaterThanOrEqual(appWindow.left);
    expect(x).toBeLessThan(appWindow.right);
    expect(y).toBeGreaterThanOrEqual(appWindow.top);
    expect(y).toBeLessThan(appWindow.bottom);
  });

  test("picks the plain window center when nothing overlaps it", () => {
    const result = findInertTouchPoint(appWindow, []);
    expect(result.inert).toBe(true);
    expect(result.point).toEqual({ x: 540, y: 960 });
  });

  test("ignores non-interactive elements (plain text) when scanning for obstacles", () => {
    const label: Element = { bounds: appWindow, clickable: false } as Element;
    const result = findInertTouchPoint(appWindow, [label]);
    expect(result.inert).toBe(true);
    expect(result.point).toEqual({ x: 540, y: 960 });
  });

  test("falls back to a defined safe point and reports inert:false when every candidate is a control", () => {
    // A hierarchy that is a control everywhere: one giant clickable element
    // covering the entire app window, so no scanned candidate can avoid it.
    const fullScreenButton = button(appWindow);

    const result = findInertTouchPoint(appWindow, [fullScreenButton]);

    // Does not silently report a clean, verified-inert point.
    expect(result.inert).toBe(false);
    // Still returns a defined, in-window point rather than throwing or
    // omitting a coordinate.
    expect(result.point.x).toBeGreaterThanOrEqual(appWindow.left);
    expect(result.point.x).toBeLessThan(appWindow.right);
    expect(result.point.y).toBeGreaterThanOrEqual(appWindow.top);
    expect(result.point.y).toBeLessThan(appWindow.bottom);
  });

  test("treats a focusable (non-clickable) element as an obstacle too", () => {
    const focusableField = {
      bounds: { left: 440, top: 900, right: 640, bottom: 1020 },
      clickable: false,
      focusable: true,
    } as Element;

    const result = findInertTouchPoint(appWindow, [focusableField]);

    expect(result.inert).toBe(true);
    const { x, y } = result.point;
    const insideField =
      x >= focusableField.bounds.left &&
      x < focusableField.bounds.right &&
      y >= focusableField.bounds.top &&
      y < focusableField.bounds.bottom;
    expect(insideField).toBe(false);
  });

  // Regression: a content-hidden region (e.g. a large Compose-interop area)
  // exposes no interactive descendants in the accessibility hierarchy at
  // all, so it can never appear in the obstacle list - but a candidate point
  // landing inside it can still tap a real (hidden) control.
  test("treats a content-hidden region as unsafe even with no accessibility obstacles", () => {
    const hiddenRegion = { left: 0, top: 0, right: 1080, bottom: 1920 };

    const result = findInertTouchPoint(appWindow, [], [hiddenRegion]);

    // Every candidate falls inside the full-window hidden region - no
    // verified-inert point exists.
    expect(result.inert).toBe(false);
  });

  test("avoids a small content-hidden region while still picking an inert point", () => {
    const hiddenRegion = { left: 440, top: 900, right: 640, bottom: 1020 };

    const result = findInertTouchPoint(appWindow, [], [hiddenRegion]);

    expect(result.inert).toBe(true);
    const { x, y } = result.point;
    const insideHiddenRegion =
      x >= hiddenRegion.left &&
      x < hiddenRegion.right &&
      y >= hiddenRegion.top &&
      y < hiddenRegion.bottom;
    expect(insideHiddenRegion).toBe(false);
  });
});

describe("collectInteractiveObstacles / deriveTouchLatencyPoint (#6167 follow-up)", () => {
  const appWindow = { left: 0, top: 0, right: 1080, bottom: 1920 };

  test("falls back to elements.clickable when there is no raw view hierarchy to walk", () => {
    const clickableEl: Element = {
      bounds: { left: 0, top: 0, right: 100, bottom: 100 },
      clickable: true,
    } as Element;
    const result = makeResult({
      elements: { clickable: [clickableEl], scrollable: [], text: [], media: [] },
    });

    expect(collectInteractiveObstacles(result)).toEqual([clickableEl]);
  });

  // Regression: `DefaultObserveElementCollector` only populates
  // `elements.clickable` for clickable/click-action nodes, but a
  // focusable-only or long-clickable-only control is also an obstacle for
  // the inert-point scan. `elements.clickable` being empty here mirrors what
  // the real collector produces for such a node - the obstacle must still
  // come from walking the raw hierarchy.
  test("includes a focusable-only node from the raw hierarchy even when elements.clickable omits it", () => {
    const focusableBounds = { left: 440, top: 900, right: 640, bottom: 1020 };
    const result = makeResult({
      viewHierarchy: {
        hierarchy: {
          node: { $: { focusable: "true", clickable: "false", bounds: focusableBounds } },
        },
      } as any,
      elements: { clickable: [], scrollable: [], text: [], media: [] },
    });

    const obstacles = collectInteractiveObstacles(result);
    expect(obstacles.some((el) => el.bounds?.left === focusableBounds.left)).toBe(true);
  });

  test("deriveTouchLatencyPoint reports skipTouchLatency when windowBounds is undefined", () => {
    const result = makeResult();
    expect(deriveTouchLatencyPoint(undefined, result)).toEqual({ skipTouchLatency: true });
  });

  // Regression: Android can transiently report zero-area window bounds
  // (e.g. a window mid-transition). A naive center calculation on
  // {left:100,top:100,right:100,bottom:100} still produces a defined-looking
  // point (100, 100) that isn't actually inside any real content - it must
  // not be reported inert and tapped.
  test("deriveTouchLatencyPoint skips on zero-area window bounds", () => {
    const zeroArea = { left: 100, top: 100, right: 100, bottom: 100 };
    const result = makeResult();

    const decision = deriveTouchLatencyPoint(zeroArea, result);
    expect(decision.skipTouchLatency).toBe(true);
    expect(decision.touchPoint).toBeUndefined();
  });

  // Regression: inverted bounds (right < left, or bottom < top) must also be
  // rejected rather than producing a negative-width/height "center".
  test("deriveTouchLatencyPoint skips on inverted window bounds", () => {
    const inverted = { left: 500, top: 900, right: 100, bottom: 200 };
    const result = makeResult();

    const decision = deriveTouchLatencyPoint(inverted, result);
    expect(decision.skipTouchLatency).toBe(true);
    expect(decision.touchPoint).toBeUndefined();
  });

  test("deriveTouchLatencyPoint skips on non-finite window bounds", () => {
    const nonFinite = { left: 0, top: 0, right: Number.NaN, bottom: 1920 };
    const result = makeResult();

    const decision = deriveTouchLatencyPoint(nonFinite, result);
    expect(decision.skipTouchLatency).toBe(true);
    expect(decision.touchPoint).toBeUndefined();
  });

  // P1: when every scanned candidate overlaps a control (a full-screen
  // button, WebView, or map), the caller must skip the touch-latency
  // measurement entirely rather than tap the known-unsafe fallback point.
  test("deriveTouchLatencyPoint skips when every candidate overlaps a control, via the production hierarchy-walk path", () => {
    const result = makeResult({
      viewHierarchy: {
        hierarchy: {
          node: { $: { clickable: "true", bounds: appWindow } },
        },
      } as any,
      elements: { clickable: [], scrollable: [], text: [], media: [] },
    });

    const decision = deriveTouchLatencyPoint(appWindow, result);
    expect(decision.skipTouchLatency).toBe(true);
    expect(decision.touchPoint).toBeUndefined();
  });

  // P2: a focusable-only control covering a candidate point must be avoided
  // through the real production obstacle-collection path (raw hierarchy
  // walk), not just via a hand-built obstacle list passed directly to
  // findInertTouchPoint.
  test("deriveTouchLatencyPoint avoids a focusable-only control found via the production hierarchy-walk path", () => {
    const focusableBounds = { left: 440, top: 900, right: 640, bottom: 1020 };
    const result = makeResult({
      viewHierarchy: {
        hierarchy: {
          node: {
            $: { focusable: "true", clickable: "false", bounds: focusableBounds },
          },
        },
      } as any,
      // Mirrors the real DefaultObserveElementCollector output: a
      // focusable-only node is never added to `clickable`.
      elements: { clickable: [], scrollable: [], text: [], media: [] },
    });

    const decision = deriveTouchLatencyPoint(appWindow, result);
    expect(decision.skipTouchLatency).toBe(false);
    expect(decision.touchPoint).toBeDefined();
    const { x, y } = decision.touchPoint!;
    const insideField =
      x >= focusableBounds.left &&
      x < focusableBounds.right &&
      y >= focusableBounds.top &&
      y < focusableBounds.bottom;
    expect(insideField).toBe(false);
  });
});

describe("collectHiddenRegionBounds / deriveTouchLatencyPoint content-hidden regions (#6167 follow-up)", () => {
  const appWindow = { left: 0, top: 0, right: 1080, bottom: 1920 };

  test("collectHiddenRegionBounds returns the bounds of every content-hidden region", () => {
    const region = {
      bounds: { left: 100, top: 200, right: 900, bottom: 1800 },
      reason: "compose-interop-no-hide-descendants" as const,
      areaPercent: 60,
    };
    const result = makeResult({
      viewHierarchy: { hierarchy: {} as any, contentHiddenRegions: [region] } as any,
    });

    expect(collectHiddenRegionBounds(result)).toEqual([region.bounds]);
  });

  test("collectHiddenRegionBounds returns an empty array when there are none", () => {
    const result = makeResult();
    expect(collectHiddenRegionBounds(result)).toEqual([]);
  });

  // P1: a large Compose-interop content-hidden region exposes no
  // interactive descendants in the accessibility hierarchy at all, so
  // `collectInteractiveObstacles` sees nothing there - a candidate point
  // inside it must still be rejected via the hidden-region check, and with
  // no other candidate available the caller must skip touch-latency
  // entirely rather than tap into the hidden content.
  test("deriveTouchLatencyPoint skips when a full-window content-hidden region leaves no safe candidate", () => {
    const result = makeResult({
      viewHierarchy: {
        hierarchy: {} as any,
        contentHiddenRegions: [
          {
            bounds: appWindow,
            reason: "compose-interop-no-hide-descendants",
            areaPercent: 100,
          },
        ],
      } as any,
      // The accessibility hierarchy is empty - no obstacle would be found
      // without the hidden-region check.
      elements: { clickable: [], scrollable: [], text: [], media: [] },
    });

    const decision = deriveTouchLatencyPoint(appWindow, result);
    expect(decision.skipTouchLatency).toBe(true);
    expect(decision.touchPoint).toBeUndefined();
  });

  test("deriveTouchLatencyPoint avoids a small content-hidden region via the production path", () => {
    const hiddenBounds = { left: 440, top: 900, right: 640, bottom: 1020 };
    const result = makeResult({
      viewHierarchy: {
        hierarchy: {} as any,
        contentHiddenRegions: [
          {
            bounds: hiddenBounds,
            reason: "compose-interop-no-hide-descendants",
            areaPercent: 10,
          },
        ],
      } as any,
      elements: { clickable: [], scrollable: [], text: [], media: [] },
    });

    const decision = deriveTouchLatencyPoint(appWindow, result);
    expect(decision.skipTouchLatency).toBe(false);
    expect(decision.touchPoint).toBeDefined();
    const { x, y } = decision.touchPoint!;
    const insideHiddenRegion =
      x >= hiddenBounds.left &&
      x < hiddenBounds.right &&
      y >= hiddenBounds.top &&
      y < hiddenBounds.bottom;
    expect(insideHiddenRegion).toBe(false);
  });
});

describe("deriveTouchLatencyPoint truncated hierarchy (#6167 follow-up)", () => {
  const appWindow = { left: 0, top: 0, right: 1080, bottom: 1920 };

  // P1: CtrlProxy stops emitting descendants once it hits max_nodes/max_depth
  // or is cancelled mid-walk, so an empty accessibility hierarchy here does
  // NOT mean "no obstacles" - it may mean "the obstacle wasn't emitted".
  // Certifying any point as inert from a truncated hierarchy is unsafe.
  test("skips touch-latency when truncationReasons is non-empty, even with an empty hierarchy", () => {
    const result = makeResult({
      viewHierarchy: {
        hierarchy: {} as any,
        truncationReasons: ["max_nodes"],
      } as any,
      // No obstacles are visible at all - without the truncation check this
      // would wrongly certify the window center as inert.
      elements: { clickable: [], scrollable: [], text: [], media: [] },
    });

    const decision = deriveTouchLatencyPoint(appWindow, result);
    expect(decision.skipTouchLatency).toBe(true);
    expect(decision.touchPoint).toBeUndefined();
  });

  test("skips touch-latency for a max_depth truncation reason", () => {
    const result = makeResult({
      viewHierarchy: { hierarchy: {} as any, truncationReasons: ["max_depth"] } as any,
      elements: { clickable: [], scrollable: [], text: [], media: [] },
    });

    const decision = deriveTouchLatencyPoint(appWindow, result);
    expect(decision.skipTouchLatency).toBe(true);
  });

  test("skips touch-latency for a cancelled truncation reason", () => {
    const result = makeResult({
      viewHierarchy: { hierarchy: {} as any, truncationReasons: ["cancelled"] } as any,
      elements: { clickable: [], scrollable: [], text: [], media: [] },
    });

    const decision = deriveTouchLatencyPoint(appWindow, result);
    expect(decision.skipTouchLatency).toBe(true);
  });

  test("is unaffected by an empty truncationReasons array", () => {
    const result = makeResult({
      viewHierarchy: { hierarchy: {} as any, truncationReasons: [] } as any,
      elements: { clickable: [], scrollable: [], text: [], media: [] },
    });

    const decision = deriveTouchLatencyPoint(appWindow, result);
    expect(decision.skipTouchLatency).toBe(false);
    expect(decision.touchPoint).toBeDefined();
  });

  test("is unaffected when truncationReasons is absent entirely", () => {
    const result = makeResult({
      viewHierarchy: { hierarchy: {} as any } as any,
      elements: { clickable: [], scrollable: [], text: [], media: [] },
    });

    const decision = deriveTouchLatencyPoint(appWindow, result);
    expect(decision.skipTouchLatency).toBe(false);
    expect(decision.touchPoint).toBeDefined();
  });
});

describe("isHierarchyReliableForTapProbe / deriveTouchLatencyPoint unverified capture (#6167 follow-up)", () => {
  const appWindow = { left: 0, top: 0, right: 1080, bottom: 1920 };

  // P1: a stale cached tree was never verified against the device on this
  // call - certifying a point from it can tap a control that has since
  // moved, appeared, or disappeared.
  test("skips touch-latency when fresh is false, even with an empty hierarchy", () => {
    const result = makeResult({
      viewHierarchy: { hierarchy: {} as any, fresh: false } as any,
      elements: { clickable: [], scrollable: [], text: [], media: [] },
    });

    const decision = deriveTouchLatencyPoint(appWindow, result);
    expect(decision.skipTouchLatency).toBe(true);
    expect(decision.touchPoint).toBeUndefined();
    expect(isHierarchyReliableForTapProbe(appWindow, result)).toBe(false);
  });

  // P1: in the incomplete split-screen case CtrlProxy can withhold the
  // focused app's own rootless window entirely while still returning
  // ANOTHER app's package-less type-1 window - certifying a point here can
  // tap the wrong app.
  test("skips touch-latency when ctrlProxyIncomplete is true, even with an empty hierarchy", () => {
    const result = makeResult({
      viewHierarchy: { hierarchy: {} as any, ctrlProxyIncomplete: true } as any,
      elements: { clickable: [], scrollable: [], text: [], media: [] },
    });

    const decision = deriveTouchLatencyPoint(appWindow, result);
    expect(decision.skipTouchLatency).toBe(true);
    expect(decision.touchPoint).toBeUndefined();
    expect(isHierarchyReliableForTapProbe(appWindow, result)).toBe(false);
  });

  test("is unaffected when fresh is true and ctrlProxyIncomplete is absent", () => {
    const result = makeResult({
      viewHierarchy: { hierarchy: {} as any, fresh: true } as any,
      elements: { clickable: [], scrollable: [], text: [], media: [] },
    });

    const decision = deriveTouchLatencyPoint(appWindow, result);
    expect(decision.skipTouchLatency).toBe(false);
    expect(decision.touchPoint).toBeDefined();
    expect(isHierarchyReliableForTapProbe(appWindow, result)).toBe(true);
  });

  test("is unaffected when fresh and ctrlProxyIncomplete are both absent (a fully-reliable capture)", () => {
    const result = makeResult({
      viewHierarchy: { hierarchy: {} as any } as any,
      elements: { clickable: [], scrollable: [], text: [], media: [] },
    });

    const decision = deriveTouchLatencyPoint(appWindow, result);
    expect(decision.skipTouchLatency).toBe(false);
    expect(decision.touchPoint).toBeDefined();
    expect(isHierarchyReliableForTapProbe(appWindow, result)).toBe(true);
  });

  test("isHierarchyReliableForTapProbe is false with no windowBounds", () => {
    const result = makeResult();
    expect(isHierarchyReliableForTapProbe(undefined, result)).toBe(false);
  });

  test("isHierarchyReliableForTapProbe is false with malformed windowBounds", () => {
    const result = makeResult();
    const zeroArea = { left: 100, top: 100, right: 100, bottom: 100 };
    expect(isHierarchyReliableForTapProbe(zeroArea, result)).toBe(false);
  });

  test("isHierarchyReliableForTapProbe is false with non-empty truncationReasons", () => {
    const result = makeResult({
      viewHierarchy: { hierarchy: {} as any, truncationReasons: ["max_nodes"] } as any,
    });
    expect(isHierarchyReliableForTapProbe(appWindow, result)).toBe(false);
  });
});
