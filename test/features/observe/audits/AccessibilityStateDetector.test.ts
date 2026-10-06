import { describe, expect, test } from "bun:test";
import { AccessibilityStateDetector } from "../../../../src/features/observe/audits/AccessibilityStateDetector";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { NoOpPerformanceTracker } from "../../../../src/utils/PerformanceTracker";
import { OPERATION_CANCELLED_MESSAGE } from "../../../../src/utils/constants";
import type { BootedDevice, ObserveResult } from "../../../../src/models";
import { DefaultAccessibilityDetector } from "../../../../src/features/accessibility/AccessibilityDetector";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeIosVoiceOverDetector } from "../../../fakes/FakeIosVoiceOverDetector";
import { FakeIOSCtrlProxy } from "../../../fakes/FakeIOSCtrlProxy";
import type { FeatureFlagService } from "../../../../src/features/featureFlags/FeatureFlagService";
import { invalidateReadinessForDisabledAccessibility } from "../../../../src/server/observeTools";

function makeResult(): ObserveResult {
  return {
    updatedAt: "2026-01-01T00:00:00.000Z",
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  } as ObserveResult;
}

const androidDevice: BootedDevice = { deviceId: "dev-1", name: "android", platform: "android" };

describe("AccessibilityStateDetector", () => {
  test("omits unreadable Android accessibility state instead of publishing disabled", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandError("enabled_accessibility_services", new Error("device offline"));
    const detector = new DefaultAccessibilityDetector(new FakeTimer());
    detector.clearAllCache();
    const flags = {
      isEnabled: (key: string) => key === "accessibility-auto-detect",
    } as FeatureFlagService;
    const result = makeResult();
    await new AccessibilityStateDetector({
      device: androidDevice,
      adb,
      featureFlags: flags,
      accessibilityDetector: detector,
    }).run(result, new NoOpPerformanceTracker());
    expect(result.accessibilityState).toBeUndefined();
  });

  describe("iOS VoiceOver (#10038)", () => {
    const iosDevice: BootedDevice = { deviceId: "ios-1", name: "iphone", platform: "ios" };

    async function runIos(voiceOver: boolean | null) {
      const iosVoiceOverDetector = new FakeIosVoiceOverDetector();
      iosVoiceOverDetector.setPersistentResolvedState(voiceOver);
      const iosClient = new FakeIOSCtrlProxy(new FakeTimer());
      const result = makeResult();
      // Stale prior value must be cleared, not left in place, when the probe is unreadable.
      result.accessibilityState = { enabled: true, service: "voiceover" };
      await new AccessibilityStateDetector({
        device: iosDevice,
        adb: new FakeAdbExecutor(),
        featureFlags: { isEnabled: () => true } as FeatureFlagService,
        iosVoiceOverDetector,
        iosClient,
      }).run(result, new NoOpPerformanceTracker());
      return { result };
    }

    test("omits accessibilityState when the VoiceOver probe is unreadable", async () => {
      const { result } = await runIos(null);
      expect(result.accessibilityState).toBeUndefined();
    });

    test.each([
      { voiceOver: true, expected: { enabled: true, service: "voiceover" } },
      { voiceOver: false, expected: { enabled: false, service: "unknown" } },
    ])("publishes a confirmed probe ($voiceOver)", async ({ voiceOver, expected }) => {
      const { result } = await runIos(voiceOver);
      expect(result.accessibilityState).toEqual(expected);
    });
  });

  test("marks a disabled auto-detect result synthetic without querying a functioning service", async () => {
    const adb = new FakeAdbExecutor();
    const flags = { isEnabled: () => false } as FeatureFlagService;
    const accessibilityDetector = new DefaultAccessibilityDetector(new FakeTimer());
    const detector = new AccessibilityStateDetector({
      device: androidDevice,
      adb,
      featureFlags: flags,
      accessibilityDetector,
    });
    const result = makeResult();

    await detector.run(result, new NoOpPerformanceTracker());

    expect(result.accessibilityState).toEqual({
      enabled: false,
      service: "unknown",
      detectionSkipped: true,
    });
    expect(adb.getExecutedCommands()).toEqual([]);
    const actions: string[] = [];
    await invalidateReadinessForDisabledAccessibility(androidDevice, result, "owner", {
      accessibilityDetector,
      resetSetupState: () => actions.push("reset"),
      isDaemonInitialized: () => true,
      invalidateAutomationReadiness: () => actions.push("invalidate"),
    });
    expect(actions).toEqual([]);
  });

  test("marks a checked, disabled service as confirmed", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("enabled_accessibility_services", { stdout: "null", stderr: "" });
    const flags = {
      isEnabled: (key: string) => key === "accessibility-auto-detect",
    } as FeatureFlagService;
    const accessibilityDetector = new DefaultAccessibilityDetector(new FakeTimer());
    const detector = new AccessibilityStateDetector({
      device: androidDevice,
      adb,
      featureFlags: flags,
      accessibilityDetector,
    });
    const result = makeResult();

    await detector.run(result, new NoOpPerformanceTracker());

    expect(result.accessibilityState).toEqual({
      enabled: false,
      service: "unknown",
      detectionSkipped: false,
    });
    expect(adb.getExecutedCommands()).toContain(
      "shell settings get secure enabled_accessibility_services",
    );
    const actions: string[] = [];
    await invalidateReadinessForDisabledAccessibility(androidDevice, result, "owner", {
      accessibilityDetector,
      resetSetupState: () => actions.push("reset"),
      isDaemonInitialized: () => true,
      invalidateAutomationReadiness: () => actions.push("invalidate"),
    });
    expect(actions).toEqual(["reset", "invalidate"]);
  });

  test("honors abort signal without polluting result.errors", async () => {
    const detector = new AccessibilityStateDetector({
      device: androidDevice,
      adb: new FakeAdbExecutor(),
    });
    const controller = new AbortController();
    controller.abort();
    const result = makeResult();
    await detector.run(result, new NoOpPerformanceTracker(), controller.signal);
    expect(result.accessibilityState).toBeUndefined();
    expect(result.errors).toBeUndefined();
  });

  test("detection failure does not pollute result.errors", async () => {
    const detector = new AccessibilityStateDetector({
      device: { ...androidDevice, platform: "unknown" as any },
      adb: new FakeAdbExecutor(),
    });
    const result = makeResult();
    await detector.run(result, new NoOpPerformanceTracker());
    // Unknown platform branch falls through with no state assigned.
    expect(result.accessibilityState).toBeUndefined();
    expect(result.errors).toBeUndefined();
  });

  test("abort error message is the canonical one", () => {
    // Sanity check on the cancelled-message constant we rely on.
    expect(OPERATION_CANCELLED_MESSAGE).toBeTruthy();
  });
});
