import { beforeEach, describe, expect, test } from "bun:test";
import { HierarchyCollector } from "../../../../src/features/observe/collectors/HierarchyCollector";
import { FakeViewHierarchy } from "../../../fakes/FakeViewHierarchy";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../../fakes/FakeTimer";
import type { AdbClientFactory } from "../../../../src/utils/android-cmdline-tools/AdbClientFactory";
import type { BootedDevice, ObserveResult, Element } from "../../../../src/models";

function makeResult(): ObserveResult {
  return {
    updatedAt: 0,
    screenSize: { width: 0, height: 0 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  };
}

function makeDevice(platform: "android" | "ios" = "android"): BootedDevice {
  return {
    name: "test-device",
    platform,
    deviceId: "test-device",
  } as BootedDevice;
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
    test("populates viewHierarchy on success", async () => {
      fakeViewHierarchy.configureHierarchy({
        hierarchy: { foo: "bar" },
        updatedAt: 12345,
      } as any);

      const result = makeResult();
      await collector.collect(result);

      expect(result.viewHierarchy).toBeDefined();
      expect(result.updatedAt).toBe(12345);
      expect(result.errors).toBeUndefined();
    });

    test("populates focusedElement when found", async () => {
      const focused: Element = { text: "Submit" } as Element;
      fakeViewHierarchy.configureHierarchy({ hierarchy: {} } as any);
      fakeViewHierarchy.configureFocusedElement(focused);

      const result = makeResult();
      await collector.collect(result);

      expect(result.focusedElement).toEqual(focused);
    });

    test("populates accessibilityFocusedElement when found", async () => {
      const a11y: Element = { "content-desc": "Submit button" } as Element;
      fakeViewHierarchy.configureHierarchy({ hierarchy: {} } as any);
      fakeViewHierarchy.configureAccessibilityFocusedElement(a11y);

      const result = makeResult();
      await collector.collect(result);

      expect(result.accessibilityFocusedElement).toEqual(a11y);
    });

    test("populates intentChooserDetected from hierarchy", async () => {
      fakeViewHierarchy.configureHierarchy({
        hierarchy: {},
        intentChooserDetected: true,
      } as any);

      const result = makeResult();
      await collector.collect(result);

      expect(result.intentChooserDetected).toBe(true);
    });

    test("propagates notificationPermissionDetected", async () => {
      fakeViewHierarchy.configureHierarchy({
        hierarchy: {},
        notificationPermissionDetected: true,
      } as any);

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
      } as any);
      expect(size).toEqual({ width: 1080, height: 2400 });
    });

    test("parses iOS bounds object format", () => {
      const size = collector.extractScreenSize({
        hierarchy: { bounds: { left: 0, top: 0, right: 402, bottom: 874 } },
      } as any);
      expect(size).toEqual({ width: 402, height: 874 });
    });

    test("returns null when bounds are missing", () => {
      const size = collector.extractScreenSize({ hierarchy: {} } as any);
      expect(size).toBeNull();
    });

    test("returns null when width or height is zero", () => {
      const size = collector.extractScreenSize({
        hierarchy: { node: { $: { bounds: { left: 0, top: 0, right: 0, bottom: 0 } } } },
      } as any);
      expect(size).toBeNull();
    });
  });

  describe("reconcileScreenDimensions", () => {
    test("overwrites stale screenWidth/screenHeight with authoritative screenSize", () => {
      // Regression for #2683: the iOS runner reports 320x480 (legacy
      // compatibility mode) while the authoritative size from root bounds is
      // the real device size. screenWidth/screenHeight must follow screenSize.
      const viewHierarchy = {
        hierarchy: { bounds: { left: 0, top: 0, right: 402, bottom: 874 } },
        screenWidth: 320,
        screenHeight: 480,
      } as any;

      const result = collector.reconcileScreenDimensions(viewHierarchy, {
        width: 402,
        height: 874,
      });

      expect(result.screenWidth).toBe(402);
      expect(result.screenHeight).toBe(874);
    });

    test("mutates and returns the same view hierarchy object", () => {
      const viewHierarchy = { hierarchy: {}, screenWidth: 320, screenHeight: 480 } as any;

      const result = collector.reconcileScreenDimensions(viewHierarchy, {
        width: 402,
        height: 874,
      });

      expect(result).toBe(viewHierarchy);
      expect(viewHierarchy.screenWidth).toBe(402);
      expect(viewHierarchy.screenHeight).toBe(874);
    });

    test("populates screenWidth/screenHeight when previously absent", () => {
      const viewHierarchy = { hierarchy: {} } as any;

      const result = collector.reconcileScreenDimensions(viewHierarchy, {
        width: 1170,
        height: 2532,
      });

      expect(result.screenWidth).toBe(1170);
      expect(result.screenHeight).toBe(2532);
    });

    test("leaves screenWidth/screenHeight untouched when screenSize is null", () => {
      const viewHierarchy = { hierarchy: {}, screenWidth: 320, screenHeight: 480 } as any;

      const result = collector.reconcileScreenDimensions(viewHierarchy, null);

      expect(result.screenWidth).toBe(320);
      expect(result.screenHeight).toBe(480);
    });

    test("leaves screenWidth/screenHeight untouched when screenSize has non-positive dimensions", () => {
      const viewHierarchy = { hierarchy: {}, screenWidth: 320, screenHeight: 480 } as any;

      const zeroWidth = collector.reconcileScreenDimensions(viewHierarchy, {
        width: 0,
        height: 874,
      });
      expect(zeroWidth.screenWidth).toBe(320);
      expect(zeroWidth.screenHeight).toBe(480);

      const zeroHeight = collector.reconcileScreenDimensions(viewHierarchy, {
        width: 402,
        height: 0,
      });
      expect(zeroHeight.screenWidth).toBe(320);
      expect(zeroHeight.screenHeight).toBe(480);
    });

    test("returns the input unchanged when view hierarchy is null", () => {
      expect(
        collector.reconcileScreenDimensions(null as any, { width: 402, height: 874 }),
      ).toBeNull();
      expect(
        collector.reconcileScreenDimensions(undefined as any, { width: 402, height: 874 }),
      ).toBeUndefined();
    });
  });
});
