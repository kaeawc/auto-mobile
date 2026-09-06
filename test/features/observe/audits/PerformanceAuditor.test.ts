import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  findAppWindowBounds,
  findInertTouchPoint,
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
});
