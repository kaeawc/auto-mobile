import { describe, it, expect, beforeEach } from "bun:test";
import { FakeTapStrategy } from "../../fakes/FakeTapStrategy";
import { AndroidTapStrategy } from "../../../src/features/action/strategies/AndroidTapStrategy";
import { IosTapStrategy } from "../../../src/features/action/strategies/IosTapStrategy";
import { createTapStrategy } from "../../../src/features/action/strategies/createTapStrategy";
import { FakeAccessibilityDetector } from "../../fakes/FakeAccessibilityDetector";
import { FakeIosVoiceOverDetector } from "../../fakes/FakeIosVoiceOverDetector";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeIOSCtrlProxy } from "../../fakes/FakeIOSCtrlProxy";
import { ViewHierarchy } from "../../../src/features/observe/ViewHierarchy";
import type { BootedDevice, ViewHierarchyResult } from "../../../src/models";
import type { TapOnElementOptions } from "../../../src/models/TapOnElementOptions";
import type { TapStrategy } from "../../../src/utils/interfaces/TapStrategy";

/**
 * Sanity-check the platform-agnostic TapStrategy contract. Tests
 * deliberately type their subjects as the abstract interface so a
 * regression that drops one of the shared methods will surface as a
 * compile error here.
 */
describe("TapStrategy", () => {
  const androidDevice: BootedDevice = {
    deviceId: "emulator-5554",
    name: "Pixel_5",
    platform: "android",
  };
  const iosDevice: BootedDevice = {
    deviceId: "00001234-ABCD",
    name: "iPhone 15",
    platform: "ios",
  };

  const buildAndroidViewHierarchy = (): ViewHierarchy =>
    new ViewHierarchy(androidDevice, { create: () => new FakeAdbClient() as any });
  const buildIosViewHierarchy = (): ViewHierarchy =>
    new ViewHierarchy(iosDevice, { create: () => new FakeAdbClient() as any });

  const minimalHierarchy: ViewHierarchyResult = {
    hierarchy: { $: {}, node: [] },
  } as any;

  describe("FakeTapStrategy", () => {
    let fake: FakeTapStrategy;

    beforeEach(() => {
      fake = new FakeTapStrategy();
    });

    it("records each method invocation", async () => {
      fake.setAccessibilityServiceEnabled(true);
      fake.setLongPressDurationMs(750);

      await fake.isAccessibilityServiceEnabled(
        androidDevice,
        new FakeAdbClient() as any,
        new FakeIOSCtrlProxy() as any
      );
      fake.getLongPressDurationMs();
      fake.shouldRunPreTapStability({ action: "tap" } as TapOnElementOptions);
      fake.shouldRetryTapIfNoChange();
      fake.prepareViewHierarchyForResponse(
        minimalHierarchy,
        buildAndroidViewHierarchy(),
        { width: 1080, height: 1920 }
      );

      expect(fake.wasMethodCalled("isAccessibilityServiceEnabled")).toBe(true);
      expect(fake.wasMethodCalled("getLongPressDurationMs")).toBe(true);
      expect(fake.wasMethodCalled("shouldRunPreTapStability")).toBe(true);
      expect(fake.wasMethodCalled("shouldRetryTapIfNoChange")).toBe(true);
      expect(fake.wasMethodCalled("prepareViewHierarchyForResponse")).toBe(true);
      expect(fake.getCallCount("getLongPressDurationMs")).toBe(1);
    });

    it("clears recorded history on demand", () => {
      fake.getLongPressDurationMs();
      fake.clearHistory();
      expect(fake.getExecutedOperations()).toEqual([]);
    });

    it("propagates configured accessibility-service state", async () => {
      fake.setAccessibilityServiceEnabled(true);
      const result = await fake.isAccessibilityServiceEnabled(
        androidDevice,
        new FakeAdbClient() as any,
        new FakeIOSCtrlProxy() as any
      );
      expect(result).toBe(true);
    });
  });

  describe("AndroidTapStrategy", () => {
    let detector: FakeAccessibilityDetector;
    let strategy: AndroidTapStrategy;

    beforeEach(() => {
      detector = new FakeAccessibilityDetector();
      strategy = new AndroidTapStrategy(detector);
    });

    it("returns true when TalkBack is detected", async () => {
      detector.setDetectionResult(androidDevice.deviceId, true, "talkback");
      const enabled = await strategy.isAccessibilityServiceEnabled(
        androidDevice,
        new FakeAdbClient() as any,
        new FakeIOSCtrlProxy() as any
      );
      expect(enabled).toBe(true);
    });

    it("returns false when accessibility service is not TalkBack", async () => {
      detector.setDetectionResult(androidDevice.deviceId, true, "voiceover");
      const enabled = await strategy.isAccessibilityServiceEnabled(
        androidDevice,
        new FakeAdbClient() as any,
        new FakeIOSCtrlProxy() as any
      );
      expect(enabled).toBe(false);
    });

    it("returns 500ms default long press", () => {
      expect(strategy.getLongPressDurationMs()).toBe(500);
    });

    it("honours options.preTapStability for pre-tap gating", () => {
      expect(strategy.shouldRunPreTapStability({ action: "tap" } as TapOnElementOptions)).toBe(false);
      expect(
        strategy.shouldRunPreTapStability({ action: "tap", preTapStability: true } as TapOnElementOptions)
      ).toBe(true);
    });

    it("always enables retry-if-no-change", () => {
      expect(strategy.shouldRetryTapIfNoChange()).toBe(true);
    });

    it("filters the raw hierarchy via filterViewHierarchy", () => {
      const filtered = strategy.prepareViewHierarchyForResponse(
        minimalHierarchy,
        buildAndroidViewHierarchy()
      );
      // Filter always returns a hierarchy (possibly equal to raw) — non-null
      // means TapOnElement uses the filtered tree.
      expect(filtered).not.toBeNull();
    });
  });

  describe("IosTapStrategy", () => {
    let detector: FakeIosVoiceOverDetector;
    let strategy: IosTapStrategy;

    beforeEach(() => {
      detector = new FakeIosVoiceOverDetector();
      strategy = new IosTapStrategy(detector);
    });

    it("routes accessibility detection to VoiceOver", async () => {
      detector.setVoiceOverEnabled(true);
      const enabled = await strategy.isAccessibilityServiceEnabled(
        iosDevice,
        new FakeAdbClient() as any,
        new FakeIOSCtrlProxy() as any
      );
      expect(enabled).toBe(true);
      expect(detector.getCallCount()).toBe(1);
    });

    it("returns false when VoiceOver is disabled", async () => {
      detector.setVoiceOverEnabled(false);
      const enabled = await strategy.isAccessibilityServiceEnabled(
        iosDevice,
        new FakeAdbClient() as any,
        new FakeIOSCtrlProxy() as any
      );
      expect(enabled).toBe(false);
    });

    it("returns 1000ms default long press", () => {
      expect(strategy.getLongPressDurationMs()).toBe(1000);
    });

    it("never runs pre-tap stability (Android-only)", () => {
      expect(
        strategy.shouldRunPreTapStability({ action: "tap", preTapStability: true } as TapOnElementOptions)
      ).toBe(false);
      expect(strategy.shouldRunPreTapStability({ action: "tap" } as TapOnElementOptions)).toBe(false);
    });

    it("never retries after tap (Android-only)", () => {
      expect(strategy.shouldRetryTapIfNoChange()).toBe(false);
    });

    it("returns null when screenSize is missing (caller keeps raw)", () => {
      const result = strategy.prepareViewHierarchyForResponse(
        minimalHierarchy,
        buildIosViewHierarchy()
      );
      expect(result).toBeNull();
    });

    it("filters the raw hierarchy when screenSize is provided", () => {
      const result = strategy.prepareViewHierarchyForResponse(
        minimalHierarchy,
        buildIosViewHierarchy(),
        { width: 390, height: 844 }
      );
      expect(result).not.toBeNull();
    });
  });

  describe("createTapStrategy factory", () => {
    it("returns an AndroidTapStrategy for Android devices", () => {
      const strategy = createTapStrategy(
        androidDevice,
        new FakeAccessibilityDetector(),
        new FakeIosVoiceOverDetector()
      );
      expect(strategy).toBeInstanceOf(AndroidTapStrategy);
      expect(strategy.getLongPressDurationMs()).toBe(500);
    });

    it("returns an IosTapStrategy for iOS devices", () => {
      const strategy = createTapStrategy(
        iosDevice,
        new FakeAccessibilityDetector(),
        new FakeIosVoiceOverDetector()
      );
      expect(strategy).toBeInstanceOf(IosTapStrategy);
      expect(strategy.getLongPressDurationMs()).toBe(1000);
    });
  });

  // Compile-time conformance: each platform-specific concrete class is
  // assigned to the abstract TapStrategy type. Behavioral coverage lives in
  // the platform-specific describe blocks above.
  const platformCases: ReadonlyArray<[string, () => TapStrategy]> = [
    ["AndroidTapStrategy", () => new AndroidTapStrategy(new FakeAccessibilityDetector())],
    ["IosTapStrategy", () => new IosTapStrategy(new FakeIosVoiceOverDetector())],
    ["FakeTapStrategy", () => new FakeTapStrategy()],
  ];
  for (const [name, build] of platformCases) {
    it(`${name} satisfies TapStrategy`, () => {
      const asStrategy: TapStrategy = build();
      expect(typeof asStrategy.prepareViewHierarchyForResponse).toBe("function");
      expect(typeof asStrategy.isAccessibilityServiceEnabled).toBe("function");
      expect(typeof asStrategy.shouldRunPreTapStability).toBe("function");
      expect(typeof asStrategy.shouldRetryTapIfNoChange).toBe("function");
      expect(typeof asStrategy.getLongPressDurationMs).toBe("function");
    });
  }
});
