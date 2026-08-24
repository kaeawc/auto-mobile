import { describe, it, expect, beforeEach } from "bun:test";
import { FakeTapStrategy } from "../../fakes/FakeTapStrategy";
import { AndroidTapStrategy } from "../../../src/features/action/strategies/AndroidTapStrategy";
import { IosTapStrategy } from "../../../src/features/action/strategies/IosTapStrategy";
import { createTapStrategy } from "../../../src/features/action/strategies/createTapStrategy";
import { FakeAccessibilityDetector } from "../../fakes/FakeAccessibilityDetector";
import { FakeIosVoiceOverDetector } from "../../fakes/FakeIosVoiceOverDetector";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { ViewHierarchy } from "../../../src/features/observe/ViewHierarchy";
import type { BootedDevice, ViewHierarchyResult } from "../../../src/models";
import type { TapOnElementOptions } from "../../../src/models/TapOnElementOptions";
import type { TapStrategy } from "../../../src/utils/interfaces/TapStrategy";
import type { FeatureFlagService } from "../../../src/features/featureFlags/FeatureFlagService";

/**
 * Sanity-check the platform-agnostic TapStrategy contract. Tests
 * deliberately type their subjects as the abstract interface so a
 * regression that drops one of the shared members will surface as a
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

  const buildViewHierarchy = (device: BootedDevice): ViewHierarchy =>
    new ViewHierarchy(device, { create: () => new FakeAdbClient() as any });

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
      fake.longPressDurationMs = 750;

      await fake.isAccessibilityServiceEnabled();
      fake.shouldRunPreTapStability({ action: "tap" } as TapOnElementOptions);
      fake.prepareViewHierarchyForResponse(minimalHierarchy, buildViewHierarchy(androidDevice), {
        width: 1080,
        height: 1920,
      });

      expect(fake.wasMethodCalled("isAccessibilityServiceEnabled")).toBe(true);
      expect(fake.wasMethodCalled("shouldRunPreTapStability")).toBe(true);
      expect(fake.wasMethodCalled("prepareViewHierarchyForResponse")).toBe(true);
    });

    it("clears recorded history on demand", async () => {
      await fake.isAccessibilityServiceEnabled();
      fake.clearHistory();
      expect(fake.getExecutedOperations()).toEqual([]);
    });

    it("propagates configured accessibility-service state", async () => {
      fake.setAccessibilityServiceEnabled(true);
      expect(await fake.isAccessibilityServiceEnabled()).toBe(true);
      fake.setAccessibilityServiceEnabled(false);
      expect(await fake.isAccessibilityServiceEnabled()).toBe(false);
    });

    it("exposes mutable long-press and retry knobs", () => {
      fake.longPressDurationMs = 250;
      fake.retryTapIfNoChange = true;
      const asStrategy: TapStrategy = fake;
      expect(asStrategy.longPressDurationMs).toBe(250);
      expect(asStrategy.retryTapIfNoChange).toBe(true);
    });
  });

  // Two platform strategies plus the fake all satisfy TapStrategy. Data-
  // driven instead of duplicating per-platform describe blocks.
  interface StrategyCase {
    name: string;
    device: BootedDevice;
    build: () => { strategy: TapStrategy; setA11y: (enabled: boolean) => void };
    longPressMs: number;
    retryTapIfNoChange: boolean;
    runsPreTapStabilityWhenRequested: boolean;
  }

  const cases: ReadonlyArray<StrategyCase> = [
    {
      name: "AndroidTapStrategy",
      device: androidDevice,
      build: () => {
        const detector = new FakeAccessibilityDetector();
        const strategy = new AndroidTapStrategy(
          androidDevice,
          new FakeAdbClient() as any,
          detector,
        );
        return {
          strategy,
          setA11y: (enabled) =>
            detector.setDetectionResult(
              androidDevice.deviceId,
              enabled,
              enabled ? "talkback" : null,
            ),
        };
      },
      longPressMs: 500,
      retryTapIfNoChange: true,
      runsPreTapStabilityWhenRequested: true,
    },
    {
      name: "IosTapStrategy",
      device: iosDevice,
      build: () => {
        const detector = new FakeIosVoiceOverDetector();
        const strategy = new IosTapStrategy(iosDevice, detector);
        return { strategy, setA11y: (enabled) => detector.setVoiceOverEnabled(enabled) };
      },
      longPressMs: 1000,
      retryTapIfNoChange: false,
      runsPreTapStabilityWhenRequested: false,
    },
  ];

  for (const c of cases) {
    describe(c.name, () => {
      it("exposes the right long-press default", () => {
        expect(c.build().strategy.longPressDurationMs).toBe(c.longPressMs);
      });

      it("reports the right retryTapIfNoChange policy", () => {
        expect(c.build().strategy.retryTapIfNoChange).toBe(c.retryTapIfNoChange);
      });

      it("routes accessibility-service detection to the right detector", async () => {
        const { strategy, setA11y } = c.build();
        setA11y(true);
        expect(await strategy.isAccessibilityServiceEnabled()).toBe(true);
        setA11y(false);
        expect(await strategy.isAccessibilityServiceEnabled()).toBe(false);
      });

      it("only runs pre-tap stability on platforms that support it", () => {
        const { strategy } = c.build();
        const withFlag = { action: "tap", preTapStability: true } as TapOnElementOptions;
        const withoutFlag = { action: "tap" } as TapOnElementOptions;
        expect(strategy.shouldRunPreTapStability(withoutFlag)).toBe(false);
        expect(strategy.shouldRunPreTapStability(withFlag)).toBe(
          c.runsPreTapStabilityWhenRequested,
        );
      });

      it("filters the response hierarchy without crashing", () => {
        const { strategy } = c.build();
        const result = strategy.prepareViewHierarchyForResponse(
          minimalHierarchy,
          buildViewHierarchy(c.device),
          { width: 390, height: 844 },
        );
        // Android always returns a filtered tree; iOS returns null when
        // screenSize is missing (covered separately below) but returns
        // a tree when provided.
        expect(result).not.toBeNull();
      });

      it("satisfies the TapStrategy interface", () => {
        const asStrategy: TapStrategy = c.build().strategy;
        expect(typeof asStrategy.prepareViewHierarchyForResponse).toBe("function");
        expect(typeof asStrategy.isAccessibilityServiceEnabled).toBe("function");
        expect(typeof asStrategy.shouldRunPreTapStability).toBe("function");
        expect(typeof asStrategy.longPressDurationMs).toBe("number");
        expect(typeof asStrategy.retryTapIfNoChange).toBe("boolean");
      });
    });
  }

  describe("IosTapStrategy (platform-specific edge case)", () => {
    it("returns null when screenSize is missing so the caller keeps the raw hierarchy", () => {
      const strategy = new IosTapStrategy(iosDevice, new FakeIosVoiceOverDetector());
      const result = strategy.prepareViewHierarchyForResponse(
        minimalHierarchy,
        buildViewHierarchy(iosDevice),
      );
      expect(result).toBeNull();
    });
  });

  // Regression guard for #3925: the tap strategies must forward the injected
  // FeatureFlagService to detection so `force-accessibility-mode` /
  // `accessibility-auto-detect` apply to tapOn exactly as they do to observe.
  describe("force-accessibility-mode feature flag threading (#3925)", () => {
    const sentinelFlags = { __sentinel: true } as unknown as FeatureFlagService;

    it("AndroidTapStrategy forwards featureFlags to detectMethod", async () => {
      const detector = new FakeAccessibilityDetector();
      const strategy = new AndroidTapStrategy(
        androidDevice,
        new FakeAdbClient() as any,
        detector,
        sentinelFlags,
      );
      await strategy.isAccessibilityServiceEnabled();
      expect(detector.detectMethodFeatureFlagsArgs).toEqual([sentinelFlags]);
    });

    it("IosTapStrategy forwards featureFlags to isVoiceOverEnabled", async () => {
      const detector = new FakeIosVoiceOverDetector();
      const strategy = new IosTapStrategy(iosDevice, detector, sentinelFlags);
      await strategy.isAccessibilityServiceEnabled();
      expect(detector.isVoiceOverEnabledFeatureFlagsArgs).toEqual([sentinelFlags]);
    });

    it("createTapStrategy threads featureFlags into the Android strategy", async () => {
      const detector = new FakeAccessibilityDetector();
      const strategy = createTapStrategy(
        androidDevice,
        new FakeAdbClient() as any,
        detector,
        new FakeIosVoiceOverDetector(),
        sentinelFlags,
      );
      await strategy.isAccessibilityServiceEnabled();
      expect(detector.detectMethodFeatureFlagsArgs).toEqual([sentinelFlags]);
    });

    it("createTapStrategy threads featureFlags into the iOS strategy", async () => {
      const detector = new FakeIosVoiceOverDetector();
      const strategy = createTapStrategy(
        iosDevice,
        new FakeAdbClient() as any,
        new FakeAccessibilityDetector(),
        detector,
        sentinelFlags,
      );
      await strategy.isAccessibilityServiceEnabled();
      expect(detector.isVoiceOverEnabledFeatureFlagsArgs).toEqual([sentinelFlags]);
    });
  });

  describe("createTapStrategy factory", () => {
    it("returns an AndroidTapStrategy for Android devices", () => {
      const strategy = createTapStrategy(
        androidDevice,
        new FakeAdbClient() as any,
        new FakeAccessibilityDetector(),
        new FakeIosVoiceOverDetector(),
      );
      expect(strategy).toBeInstanceOf(AndroidTapStrategy);
      expect(strategy.longPressDurationMs).toBe(500);
    });

    it("returns an IosTapStrategy for iOS devices", () => {
      const strategy = createTapStrategy(
        iosDevice,
        new FakeAdbClient() as any,
        new FakeAccessibilityDetector(),
        new FakeIosVoiceOverDetector(),
      );
      expect(strategy).toBeInstanceOf(IosTapStrategy);
      expect(strategy.longPressDurationMs).toBe(1000);
    });
  });
});
