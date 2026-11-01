import { describe, it, expect, beforeEach, test } from "bun:test";
import { FakeTapStrategy } from "../../fakes/FakeTapStrategy";
import { AndroidTapStrategy } from "../../../src/features/action/strategies/AndroidTapStrategy";
import { IosTapStrategy } from "../../../src/features/action/strategies/IosTapStrategy";
import { createTapStrategy } from "../../../src/features/action/strategies/createTapStrategy";
import { FakeAccessibilityDetector } from "../../fakes/FakeAccessibilityDetector";
import { FakeIosVoiceOverDetector } from "../../fakes/FakeIosVoiceOverDetector";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { ViewHierarchy } from "../../../src/features/observe/ViewHierarchy";
import type { BootedDevice, ObserveResult, ViewHierarchyResult } from "../../../src/models";
import { resolveIosObserveRotation } from "../../../src/features/observe/iosObserveRotation";
import type { TapOnElementOptions } from "../../../src/models/TapOnElementOptions";
import type { TapStrategy } from "../../../src/utils/interfaces/TapStrategy";

/**
 * Sanity-check the platform-agnostic TapStrategy contract. Tests
 * deliberately type their subjects as the abstract interface so a
 * regression that drops one of the shared members will surface as a
 * compile error here.
 */
test("Android tap strategy retries unknown once and reports its default decision", async () => {
  const detector = new FakeAccessibilityDetector();
  detector.setDefaultResult(null);
  const warnings: string[] = [];
  const strategy = new AndroidTapStrategy(
    { name: "android", deviceId: "unknown", platform: "android" },
    new FakeAdbClient(),
    detector,
  );
  expect(await strategy.isAccessibilityServiceEnabled((warning) => warnings.push(warning))).toBe(
    false,
  );
  expect(detector.getDetectionCallCount()).toBe(2);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("could not determine");
});

/** The policy flags a fake must copy from the strategy it stands in for (#13316). */
const POLICY_FLAGS = [
  "longPressDurationMs",
  "warnsOnDisabledElement",
  "settlesPostTapChange",
  "verifiesRefreshedDisplay",
  "promotesClickableAncestor",
  "settlesFocusChangeAfterTap",
  "rethrowsKeyboardOcclusion",
  "retryTapIfNoChange",
] as const;

function policy(strategy: TapStrategy) {
  return Object.fromEntries(POLICY_FLAGS.map((flag) => [flag, strategy[flag]]));
}

test("the iOS fake tap strategy carries IosTapStrategy's policy flags", () => {
  const ios = new IosTapStrategy(
    { name: "ios", deviceId: "ios", platform: "ios" },
    new FakeIosVoiceOverDetector(),
  );
  expect(policy(FakeTapStrategy.ios())).toEqual(policy(ios));
});

test("the default fake tap strategy carries Android's policy flags with retries off", () => {
  const android = new AndroidTapStrategy(
    { name: "android", deviceId: "android", platform: "android" },
    new FakeAdbClient(),
    new FakeAccessibilityDetector(),
  );
  expect(policy(new FakeTapStrategy())).toEqual({ ...policy(android), retryTapIfNoChange: false });
});

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
    new ViewHierarchy(device, new FakeAdbClientFactory());

  const minimalHierarchy: ViewHierarchyResult = {
    hierarchy: {},
  };

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
        const strategy = new AndroidTapStrategy(androidDevice, new FakeAdbClient(), detector);
        return {
          strategy,
          setA11y: (enabled) =>
            detector.setDetectionResult(
              androidDevice.deviceId,
              enabled,
              enabled ? "talkback" : "unknown",
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
  // FeatureFlagReader to detection so `force-accessibility-mode` /
  // `accessibility-auto-detect` apply to tapOn exactly as they do to observe.
  describe("force-accessibility-mode feature flag threading (#3925)", () => {
    const sentinelFlags = { __sentinel: true, isEnabled: () => false };

    it("AndroidTapStrategy forwards featureFlags to detectMethod", async () => {
      const detector = new FakeAccessibilityDetector();
      const strategy = new AndroidTapStrategy(
        androidDevice,
        new FakeAdbClient(),
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
      const strategy = createTapStrategy(androidDevice, new FakeAdbClient(), detector, {
        iosVoiceOverDetector: new FakeIosVoiceOverDetector(),
        featureFlags: sentinelFlags,
      });
      await strategy.isAccessibilityServiceEnabled();
      expect(detector.detectMethodFeatureFlagsArgs).toEqual([sentinelFlags]);
    });

    it("createTapStrategy threads featureFlags into the iOS strategy", async () => {
      const detector = new FakeIosVoiceOverDetector();
      const strategy = createTapStrategy(
        iosDevice,
        new FakeAdbClient(),
        new FakeAccessibilityDetector(),
        { iosVoiceOverDetector: detector, featureFlags: sentinelFlags },
      );
      await strategy.isAccessibilityServiceEnabled();
      expect(detector.isVoiceOverEnabledFeatureFlagsArgs).toEqual([sentinelFlags]);
    });
  });

  describe("createTapStrategy factory", () => {
    it("returns an AndroidTapStrategy for Android devices", () => {
      const strategy = createTapStrategy(
        androidDevice,
        new FakeAdbClient(),
        new FakeAccessibilityDetector(),
        { iosVoiceOverDetector: new FakeIosVoiceOverDetector() },
      );
      expect(strategy).toBeInstanceOf(AndroidTapStrategy);
      expect(strategy.longPressDurationMs).toBe(500);
    });

    it("returns an IosTapStrategy for iOS devices", () => {
      const strategy = createTapStrategy(
        iosDevice,
        new FakeAdbClient(),
        new FakeAccessibilityDetector(),
        { iosVoiceOverDetector: new FakeIosVoiceOverDetector() },
      );
      expect(strategy).toBeInstanceOf(IosTapStrategy);
      expect(strategy.longPressDurationMs).toBe(1000);
    });
  });
});

describe("clipNavigationTapBounds", () => {
  const hierarchy = { hierarchy: { node: [] } } as ViewHierarchyResult;
  const bounds = { left: 0, top: 0, right: 100, bottom: 50 };

  test("Android never clips", () => {
    const strategy: TapStrategy = new AndroidTapStrategy(
      { name: "pixel", platform: "android", deviceId: "emu" },
      new FakeAdbClient(),
    );
    expect(
      strategy.clipNavigationTapBounds(bounds, hierarchy, { width: 1080, height: 2400 }, []),
    ).toEqual({ bounds });
  });

  test("iOS leaves bounds unchanged without a usable screen size", () => {
    const strategy: TapStrategy = new IosTapStrategy({
      name: "iPhone",
      platform: "ios",
      deviceId: "sim",
    });
    expect(strategy.clipNavigationTapBounds(bounds, hierarchy, undefined, [])).toEqual({ bounds });
  });
});

test("platform tap refinements are Android-only capabilities of the strategy", () => {
  const android = createTapStrategy(
    { name: "a", deviceId: "emulator-5554", platform: "android" },
    new FakeAdbClient(),
    new FakeAccessibilityDetector(),
    { iosVoiceOverDetector: new FakeIosVoiceOverDetector() },
  );
  const ios = createTapStrategy(
    { name: "i", deviceId: "sim", platform: "ios" },
    new FakeAdbClient(),
    new FakeAccessibilityDetector(),
    { iosVoiceOverDetector: new FakeIosVoiceOverDetector() },
  );
  const flags = (s: TapStrategy) => [
    s.warnsOnDisabledElement,
    s.settlesPostTapChange,
    s.verifiesRefreshedDisplay,
    s.promotesClickableAncestor,
    s.settlesFocusChangeAfterTap,
    s.rethrowsKeyboardOcclusion,
  ];
  expect(flags(android)).toEqual([true, true, true, true, false, true]);
  expect(flags(ios)).toEqual([false, false, false, false, true, false]);
  const observation = { screenSize: { width: 100, height: 200 } } as ObserveResult;
  ios.applyRefreshedObservationRotation(observation, 90);
  expect(observation.rotation).toBe(resolveIosObserveRotation(90, observation.screenSize));
  const untouched = { screenSize: { width: 100, height: 200 } } as ObserveResult;
  android.applyRefreshedObservationRotation(untouched, 90);
  expect(untouched.rotation).toBeUndefined();
});
