import { beforeEach, describe, expect, test } from "bun:test";
import { HierarchyCollector } from "../../../../src/features/observe/collectors/HierarchyCollector";
import { FakeViewHierarchy } from "../../../fakes/FakeViewHierarchy";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { createObserveResultForTest } from "../flatHierarchyBuilders";
import type { AdbClientFactory } from "../../../../src/utils/android-cmdline-tools/AdbClientFactory";
import type {
  BootedDevice,
  ObserveResult,
  Element,
  ViewHierarchyResult,
} from "../../../../src/models";

function makeResult(): ObserveResult {
  return createObserveResultForTest({ updatedAt: 0, screenSize: { width: 0, height: 0 } });
}

const unitBounds = { left: 0, top: 0, right: 1, bottom: 1 };

function makeDevice(platform: "android" | "ios" = "android"): BootedDevice {
  return {
    name: "test-device",
    platform,
    deviceId: "test-device",
  };
}

function makeStubAdbFactory(adb: FakeAdbExecutor): AdbClientFactory {
  return { create: () => adb };
}

describe("HierarchyCollector", () => {
  let fakeViewHierarchy: FakeViewHierarchy;
  let fakeAdb: FakeAdbExecutor;
  let fakeTimer: FakeTimer;
  let collector: HierarchyCollector;

  beforeEach(() => {
    fakeViewHierarchy = new FakeViewHierarchy();
    fakeAdb = new FakeAdbExecutor();
    fakeTimer = new FakeTimer();
    collector = new HierarchyCollector({
      device: makeDevice("android"),
      viewHierarchy: fakeViewHierarchy,
      adb: fakeAdb,
      adbFactory: makeStubAdbFactory(fakeAdb),
      timer: fakeTimer,
    });
  });

  describe("collect", () => {
    test("preserves read, focus, and dialog attachment order with fresh extraction options", async () => {
      const calls: string[] = [];
      const hierarchy: ViewHierarchyResult = {
        hierarchy: {},
        updatedAt: 42,
        intentChooserDetected: false,
        notificationPermissionDetected: false,
      };
      const result = makeResult();
      const readOptions = { timeoutMs: 750, requireFreshExtraction: true };
      fakeViewHierarchy.configureRecompositionTracking = async () => {
        calls.push("configure");
      };
      fakeViewHierarchy.getViewHierarchy = async (
        ...args: Parameters<
          import("../../../../src/features/observe/interfaces/ViewHierarchy").ViewHierarchy["getViewHierarchy"]
        >
      ) => {
        expect(args[1]).toMatchObject(readOptions);
        calls.push("read");
        return hierarchy;
      };
      fakeViewHierarchy.findFocusedElement = () => {
        expect(result.viewHierarchy).toBe(hierarchy);
        expect(result.updatedAt).toBe(42);
        calls.push("focus");
        return { "resource-id": "field", bounds: unitBounds };
      };
      fakeViewHierarchy.findAccessibilityFocusedElement = () => {
        expect(result.focusedElement).toEqual({ "resource-id": "field", bounds: unitBounds });
        expect(result.intentChooserDetected).toBeUndefined();
        calls.push("accessibilityFocus");
        return { "resource-id": "accessibility-field", bounds: unitBounds };
      };
      await collector.collect(result, {
        skipWaitForFresh: false,
        minTimestamp: 0,
        readOnly: false,
        readOptions,
      });
      expect(calls).toEqual(["configure", "read", "focus", "accessibilityFocus"]);
      expect(result.intentChooserDetected).toBe(false);
      expect(result.notificationPermissionDetected).toBe(false);
    });

    test("captured read-only hierarchy skips configuration and reads and preserves absent fields", async () => {
      const hierarchy: ViewHierarchyResult = { hierarchy: {}, updatedAt: 0 };
      const result = makeResult();
      result.updatedAt = 7;
      result.notificationPermissionDetected = true;
      await collector.collect(result, {
        skipWaitForFresh: false,
        minTimestamp: 0,
        readOnly: true,
        capturedHierarchy: hierarchy,
      });
      expect(fakeViewHierarchy.getRecompositionTrackingCallCount()).toBe(0);
      expect(fakeViewHierarchy.getCallCount()).toBe(0);
      expect(result.viewHierarchy).toBe(hierarchy);
      expect(result.updatedAt).toBe(7);
      expect(result.notificationPermissionDetected).toBe(true);
    });

    test("intent chooser getter failure retains focused elements and continues permission attachment", async () => {
      const hierarchy: ViewHierarchyResult = {
        hierarchy: {},
        notificationPermissionDetected: true,
        get intentChooserDetected(): boolean {
          throw new Error("intent unavailable");
        },
      };
      fakeViewHierarchy.configureFocusedElement({ text: "Focused", bounds: unitBounds });
      const result = makeResult();
      await collector.collect(result, {
        skipWaitForFresh: false,
        minTimestamp: 0,
        readOnly: true,
        capturedHierarchy: hierarchy,
      });
      expect(result.focusedElement?.text).toBe("Focused");
      expect(result.notificationPermissionDetected).toBe(true);
      expect(result.errors).toBeUndefined();
    });

    test("forwards the caller's remaining timeout to the hierarchy read", async () => {
      fakeViewHierarchy.configureHierarchy({ hierarchy: { node: {} } });
      let readTimeout: number | undefined;
      const read = fakeViewHierarchy.getViewHierarchy.bind(fakeViewHierarchy);
      fakeViewHierarchy.getViewHierarchy = async (...args) => {
        readTimeout = args[1]?.timeoutMs;
        return read(...args);
      };
      await collector.collect(makeResult(), {
        skipWaitForFresh: false,
        minTimestamp: 0,
        readOnly: false,
        readOptions: 750,
      });
      expect(readTimeout).toBe(750);
    });
    test("populates viewHierarchy on success", async () => {
      fakeViewHierarchy.configureHierarchy({
        hierarchy: { node: { bounds: unitBounds } },
        updatedAt: 12345,
      });

      const result = makeResult();
      await collector.collect(result);

      expect(result.viewHierarchy).toBeDefined();
      expect(result.updatedAt).toBe(12345);
      expect(result.errors).toBeUndefined();
    });

    test("populates focusedElement when found", async () => {
      const focused: Element = { text: "Submit", bounds: unitBounds };
      fakeViewHierarchy.configureHierarchy({ hierarchy: {} });
      fakeViewHierarchy.configureFocusedElement(focused);

      const result = makeResult();
      await collector.collect(result);

      expect(result.focusedElement).toEqual(focused);
    });

    test("populates accessibilityFocusedElement when found", async () => {
      const a11y: Element = { "content-desc": "Submit button", bounds: unitBounds };
      fakeViewHierarchy.configureHierarchy({ hierarchy: {} });
      fakeViewHierarchy.configureAccessibilityFocusedElement(a11y);

      const result = makeResult();
      await collector.collect(result);

      expect(result.accessibilityFocusedElement).toEqual(a11y);
    });

    test("populates intentChooserDetected from hierarchy", async () => {
      fakeViewHierarchy.configureHierarchy({
        hierarchy: {},
        intentChooserDetected: true,
      });

      const result = makeResult();
      await collector.collect(result);

      expect(result.intentChooserDetected).toBe(true);
    });

    test("propagates notificationPermissionDetected", async () => {
      fakeViewHierarchy.configureHierarchy({
        hierarchy: {},
        notificationPermissionDetected: true,
      });

      const result = makeResult();
      await collector.collect(result);

      expect(result.notificationPermissionDetected).toBe(true);
    });

    test("emits viewHierarchy error on generic failure", async () => {
      fakeViewHierarchy.setFailure(new Error("boom"));

      const result = makeResult();
      await collector.collect(result);

      expect(result.errors).toBeDefined();
      expect(result.errors!.length).toBe(1);
      expect(result.errors![0].phase).toBe("viewHierarchy");
      expect(result.errors![0].message).toBe("Failed to retrieve view hierarchy");
      expect(result.errors![0].cause).toContain("boom");
    });

    // #7534 primary path: the real `ViewHierarchy` swallows lost CtrlProxy
    // connectivity into a RESOLVED error-shaped result (`transportFailure:
    // true`) rather than throwing, so `onAvailabilityLost` must be driven off
    // the resolved result, not a thrown error. This replaces the prior
    // round's throwing-fake coverage, which didn't exercise the real
    // production shape (reviewer-flagged as misleading).
    test("reports lost CtrlProxy availability from a resolved transport-failure result", async () => {
      const reasons: string[] = [];
      fakeViewHierarchy.configureHierarchy({
        hierarchy: { error: "WebSocket not connected", transportFailure: true },
        updatedAt: 1,
      });
      const reportingCollector = new HierarchyCollector({
        device: makeDevice(),
        viewHierarchy: fakeViewHierarchy,
        adb: fakeAdb,
        adbFactory: makeStubAdbFactory(fakeAdb),
        timer: fakeTimer,
        onAvailabilityLost: (reason) => reasons.push(reason),
      });

      await reportingCollector.collect(makeResult());

      expect(reasons).toEqual(["CtrlProxy hierarchy connection lost: WebSocket not connected"]);
    });

    test("does not report lost availability for a resolved ordinary content error (no transportFailure)", async () => {
      const reasons: string[] = [];
      fakeViewHierarchy.configureHierarchy({
        hierarchy: { error: "screen appears to be off" },
        updatedAt: 1,
      });
      const reportingCollector = new HierarchyCollector({
        device: makeDevice(),
        viewHierarchy: fakeViewHierarchy,
        adb: fakeAdb,
        adbFactory: makeStubAdbFactory(fakeAdb),
        timer: fakeTimer,
        onAvailabilityLost: (reason) => reasons.push(reason),
      });

      await reportingCollector.collect(makeResult());

      expect(reasons).toEqual([]);
    });

    // Defensive/secondary path (#7534): kept for a `ViewHierarchy` (or
    // underlying client) implementation that genuinely throws instead of
    // resolving. Not the primary production path — see the resolved-result
    // tests above.
    test("reports lost CtrlProxy availability once from a thrown connection error (secondary path)", async () => {
      const reasons: string[] = [];
      fakeViewHierarchy.setFailure(new Error("WebSocket not connected"));
      const reportingCollector = new HierarchyCollector({
        device: makeDevice(),
        viewHierarchy: fakeViewHierarchy,
        adb: fakeAdb,
        adbFactory: makeStubAdbFactory(fakeAdb),
        timer: fakeTimer,
        onAvailabilityLost: (reason) => reasons.push(reason),
      });

      await reportingCollector.collect(makeResult());

      expect(reasons).toEqual([
        "CtrlProxy hierarchy connection lost: Error: WebSocket not connected",
      ]);
    });

    test("does not report lost availability for a thrown screen-off content error", async () => {
      const reasons: string[] = [];
      fakeViewHierarchy.setFailure(new Error("screen appears to be off"));
      const reportingCollector = new HierarchyCollector({
        device: makeDevice(),
        viewHierarchy: fakeViewHierarchy,
        adb: fakeAdb,
        adbFactory: makeStubAdbFactory(fakeAdb),
        timer: fakeTimer,
        onAvailabilityLost: (reason) => reasons.push(reason),
      });

      await reportingCollector.collect(makeResult());

      expect(reasons).toEqual([]);
    });

    test("emits screen-off message when error indicates screen off", async () => {
      fakeViewHierarchy.setFailure(new Error("null root node returned by UiTestAutomationBridge"));

      const result = makeResult();
      await collector.collect(result);

      expect(result.errors!.length).toBe(1);
      expect(result.errors![0].phase).toBe("viewHierarchy");
      expect(result.errors![0].message).toBe("Screen appears to be off or device is locked");
    });

    test("emits screen-off when cat: No such file or directory pattern", async () => {
      fakeViewHierarchy.setFailure(new Error("cat: /sdcard/foo: No such file or directory"));

      const result = makeResult();
      await collector.collect(result);

      expect(result.errors![0].message).toBe("Screen appears to be off or device is locked");
    });

    test("emits screen-off when 'screen appears to be off' phrase present", async () => {
      fakeViewHierarchy.setFailure(new Error("the screen appears to be off"));

      const result = makeResult();
      await collector.collect(result);

      expect(result.errors![0].message).toBe("Screen appears to be off or device is locked");
    });
  });

  describe("extractScreenSize", () => {
    test("parses Android object bounds format", () => {
      const size = collector.extractScreenSize({
        hierarchy: { node: { $: { bounds: { left: 0, top: 0, right: 1080, bottom: 2400 } } } },
      });
      expect(size).toEqual({ width: 1080, height: 2400 });
    });

    test("parses iOS bounds object format", () => {
      const size = collector.extractScreenSize({
        hierarchy: { bounds: { left: 0, top: 0, right: 402, bottom: 874 } },
      });
      expect(size).toEqual({ width: 402, height: 874 });
    });

    test("returns null when bounds are missing", () => {
      const size = collector.extractScreenSize({ hierarchy: {} });
      expect(size).toBeNull();
    });

    test("returns null when width or height is zero", () => {
      const size = collector.extractScreenSize({
        hierarchy: { node: { $: { bounds: { left: 0, top: 0, right: 0, bottom: 0 } } } },
      });
      expect(size).toBeNull();
    });
  });

  describe("reconcileScreenDimensions", () => {
    test("overwrites stale screenWidth/screenHeight with authoritative screenSize", () => {
      // Regression for #2683: the iOS runner reports 320x480 (legacy
      // compatibility mode) while the authoritative size from root bounds is
      // the real device size. screenWidth/screenHeight must follow screenSize.
      const viewHierarchy: ViewHierarchyResult = {
        hierarchy: { bounds: { left: 0, top: 0, right: 402, bottom: 874 } },
        screenWidth: 320,
        screenHeight: 480,
      };

      const result = collector.reconcileScreenDimensions(viewHierarchy, {
        width: 402,
        height: 874,
      });

      expect(result?.screenWidth).toBe(402);
      expect(result?.screenHeight).toBe(874);
    });

    test("mutates and returns the same view hierarchy object", () => {
      const viewHierarchy: ViewHierarchyResult = {
        hierarchy: {},
        screenWidth: 320,
        screenHeight: 480,
      };

      const result = collector.reconcileScreenDimensions(viewHierarchy, {
        width: 402,
        height: 874,
      });

      expect(result).toBe(viewHierarchy);
      expect(viewHierarchy.screenWidth).toBe(402);
      expect(viewHierarchy.screenHeight).toBe(874);
    });

    test("populates screenWidth/screenHeight when previously absent", () => {
      const viewHierarchy: ViewHierarchyResult = { hierarchy: {} };

      const result = collector.reconcileScreenDimensions(viewHierarchy, {
        width: 1170,
        height: 2532,
      });

      expect(result?.screenWidth).toBe(1170);
      expect(result?.screenHeight).toBe(2532);
    });

    test("leaves screenWidth/screenHeight untouched when screenSize is null", () => {
      const viewHierarchy: ViewHierarchyResult = {
        hierarchy: {},
        screenWidth: 320,
        screenHeight: 480,
      };

      const result = collector.reconcileScreenDimensions(viewHierarchy, null);

      expect(result?.screenWidth).toBe(320);
      expect(result?.screenHeight).toBe(480);
    });

    test("leaves screenWidth/screenHeight untouched when screenSize has non-positive dimensions", () => {
      const viewHierarchy: ViewHierarchyResult = {
        hierarchy: {},
        screenWidth: 320,
        screenHeight: 480,
      };

      const zeroWidth = collector.reconcileScreenDimensions(viewHierarchy, {
        width: 0,
        height: 874,
      });
      expect(zeroWidth?.screenWidth).toBe(320);
      expect(zeroWidth?.screenHeight).toBe(480);

      const zeroHeight = collector.reconcileScreenDimensions(viewHierarchy, {
        width: 402,
        height: 0,
      });
      expect(zeroHeight?.screenWidth).toBe(320);
      expect(zeroHeight?.screenHeight).toBe(480);
    });

    test("returns undefined unchanged when there is no view hierarchy", () => {
      expect(
        collector.reconcileScreenDimensions(undefined, { width: 402, height: 874 }),
      ).toBeUndefined();
    });
  });
});
