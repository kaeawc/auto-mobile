import { describe, expect, test } from "bun:test";
import type { AccessibilityDetector } from "../../src/features/accessibility/interfaces/AccessibilityDetector";
import type { FeatureFlagReader } from "../../src/features/featureFlags/FeatureFlagService";
import type { AdbExecutor } from "../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";

/** What the device reports for `settings get secure enabled_accessibility_services`. */
export type AccessibilityScenario =
  | { kind: "talkback"; ctrlProxy: boolean }
  | { kind: "other"; ctrlProxy: boolean }
  | { kind: "none"; ctrlProxy: boolean }
  | { kind: "unavailable" };

export interface AccessibilityDetectorContractHarness {
  detector: AccessibilityDetector;
  /** The adb for one device (the real detector reads each device through its own adb). */
  adbFor(deviceId: string): AdbExecutor;
  /** Puts the device into the scenario (via adb output for the real detector). */
  configure(deviceId: string, scenario: AccessibilityScenario): void;
}

const flags = (enabled: Record<string, boolean>): FeatureFlagReader => ({
  isEnabled: (key) => enabled[key] ?? false,
});

const AUTO_DETECT = flags({ "accessibility-auto-detect": true });
const FORCE = flags({ "force-accessibility-mode": true, "accessibility-auto-detect": true });
const AUTO_DETECT_OFF = flags({ "accessibility-auto-detect": false });

const DEVICE = "emulator-5554";

/**
 * Shared contract for every {@link AccessibilityDetector}: TalkBack / other-service
 * classification, CtrlProxy evidence, feature-flag short circuits and the
 * null-on-failure rule. Run against DefaultAccessibilityDetector over a stubbed adb
 * and FakeAccessibilityDetector so the fake cannot drift (issue #11868). The 60 s
 * TTL cache and failure backoff need a timer and are covered by the real detector's
 * own suite.
 */
export const runAccessibilityDetectorContract = (
  description: string,
  make: () => AccessibilityDetectorContractHarness,
): void => {
  describe(`AccessibilityDetector contract: ${description}`, function () {
    test("classifies TalkBack as enabled", async function () {
      const { detector, adbFor, configure } = make();
      configure(DEVICE, { kind: "talkback", ctrlProxy: false });

      expect(await detector.isAccessibilityEnabled(DEVICE, adbFor(DEVICE), AUTO_DETECT)).toBe(true);
      expect(await detector.detectMethod(DEVICE, adbFor(DEVICE), AUTO_DETECT)).toBe("talkback");
      expect(await detector.resolveState(DEVICE, adbFor(DEVICE), AUTO_DETECT)).toEqual({
        enabled: true,
        service: "talkback",
        ctrlProxyEnabled: false,
      });
      expect(await detector.resolveTalkBackState(DEVICE, adbFor(DEVICE), AUTO_DETECT)).toBe(true);
    });

    test("treats another enabled service as accessibility on but not TalkBack", async function () {
      const { detector, adbFor, configure } = make();
      configure(DEVICE, { kind: "other", ctrlProxy: false });

      expect(await detector.isAccessibilityEnabled(DEVICE, adbFor(DEVICE), AUTO_DETECT)).toBe(true);
      expect(await detector.detectMethod(DEVICE, adbFor(DEVICE), AUTO_DETECT)).toBe("unknown");
      expect(await detector.resolveTalkBackState(DEVICE, adbFor(DEVICE), AUTO_DETECT)).toBe(false);
    });

    test("reports nothing enabled as disabled with an unknown service", async function () {
      const { detector, adbFor, configure } = make();
      configure(DEVICE, { kind: "none", ctrlProxy: false });

      expect(await detector.resolveState(DEVICE, adbFor(DEVICE), AUTO_DETECT)).toEqual({
        enabled: false,
        service: "unknown",
        ctrlProxyEnabled: false,
      });
      expect(await detector.isAccessibilityEnabled(DEVICE, adbFor(DEVICE), AUTO_DETECT)).toBe(
        false,
      );
    });

    test("reports CtrlProxy separately from the user-facing service", async function () {
      const { detector, adbFor, configure } = make();
      configure(DEVICE, { kind: "none", ctrlProxy: true });

      expect(await detector.isCtrlProxyServiceEnabled(DEVICE, adbFor(DEVICE), AUTO_DETECT)).toBe(
        true,
      );
      expect((await detector.resolveState(DEVICE, adbFor(DEVICE), AUTO_DETECT))?.enabled).toBe(
        false,
      );
      expect(await detector.isAccessibilityEnabled(DEVICE, adbFor(DEVICE), AUTO_DETECT)).toBe(
        false,
      );
    });

    test("reports CtrlProxy alongside TalkBack", async function () {
      const { detector, adbFor, configure } = make();
      configure(DEVICE, { kind: "talkback", ctrlProxy: true });

      expect(await detector.isCtrlProxyServiceEnabled(DEVICE, adbFor(DEVICE), AUTO_DETECT)).toBe(
        true,
      );
      expect(await detector.detectMethod(DEVICE, adbFor(DEVICE), AUTO_DETECT)).toBe("talkback");
    });

    test("returns null state when the probe fails and defaults the booleans", async function () {
      const { detector, adbFor, configure } = make();
      configure(DEVICE, { kind: "unavailable" });

      expect(await detector.resolveState(DEVICE, adbFor(DEVICE), AUTO_DETECT)).toBeNull();
      expect(await detector.resolveTalkBackState(DEVICE, adbFor(DEVICE), AUTO_DETECT)).toBeNull();
      expect(await detector.isAccessibilityEnabled(DEVICE, adbFor(DEVICE), AUTO_DETECT)).toBe(
        false,
      );
      expect(await detector.detectMethod(DEVICE, adbFor(DEVICE), AUTO_DETECT)).toBe("unknown");
      expect(
        await detector.isCtrlProxyServiceEnabled(DEVICE, adbFor(DEVICE), AUTO_DETECT),
      ).toBeNull();
    });

    test("force mode reports TalkBack without a CtrlProxy claim", async function () {
      const { detector, adbFor, configure } = make();
      configure(DEVICE, { kind: "none", ctrlProxy: true });

      expect(await detector.resolveState(DEVICE, adbFor(DEVICE), FORCE)).toEqual({
        enabled: true,
        service: "talkback",
        ctrlProxyEnabled: null,
      });
      expect(await detector.detectMethod(DEVICE, adbFor(DEVICE), FORCE)).toBe("talkback");
      expect(await detector.isAccessibilityEnabled(DEVICE, adbFor(DEVICE), FORCE)).toBe(true);
    });

    test("auto-detect off reports disabled and withholds CtrlProxy evidence", async function () {
      const { detector, adbFor, configure } = make();
      configure(DEVICE, { kind: "talkback", ctrlProxy: true });

      expect(await detector.resolveState(DEVICE, adbFor(DEVICE), AUTO_DETECT_OFF)).toEqual({
        enabled: false,
        service: "unknown",
        ctrlProxyEnabled: null,
      });
      expect(await detector.isAccessibilityEnabled(DEVICE, adbFor(DEVICE), AUTO_DETECT_OFF)).toBe(
        false,
      );
      expect(
        await detector.isCtrlProxyServiceEnabled(DEVICE, adbFor(DEVICE), AUTO_DETECT_OFF),
      ).toBeNull();
    });

    test("keeps devices independent", async function () {
      const { detector, adbFor, configure } = make();
      configure("device-a", { kind: "talkback", ctrlProxy: false });
      configure("device-b", { kind: "none", ctrlProxy: false });

      expect(
        await detector.isAccessibilityEnabled("device-a", adbFor("device-a"), AUTO_DETECT),
      ).toBe(true);
      expect(
        await detector.isAccessibilityEnabled("device-b", adbFor("device-b"), AUTO_DETECT),
      ).toBe(false);
    });

    test("recovers after invalidation once the probe succeeds", async function () {
      const { detector, adbFor, configure } = make();
      configure(DEVICE, { kind: "unavailable" });
      expect(await detector.resolveState(DEVICE, adbFor(DEVICE), AUTO_DETECT)).toBeNull();

      configure(DEVICE, { kind: "talkback", ctrlProxy: false });
      detector.invalidateCache(DEVICE);

      expect(await detector.resolveTalkBackState(DEVICE, adbFor(DEVICE), AUTO_DETECT)).toBe(true);
    });

    test("clearing the cache forgets evidence, not the device's real state", async function () {
      const { detector, adbFor, configure } = make();
      configure(DEVICE, { kind: "talkback", ctrlProxy: true });
      expect(await detector.detectMethod(DEVICE, adbFor(DEVICE), AUTO_DETECT)).toBe("talkback");

      detector.clearAllCache();

      expect(await detector.detectMethod(DEVICE, adbFor(DEVICE), AUTO_DETECT)).toBe("talkback");
      expect(await detector.isCtrlProxyServiceEnabled(DEVICE, adbFor(DEVICE), AUTO_DETECT)).toBe(
        true,
      );
    });
  });
};
