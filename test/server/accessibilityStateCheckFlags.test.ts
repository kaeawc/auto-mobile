import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { registerAccessibilityTools } from "../../src/server/accessibilityTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { TalkBackToggle } from "../../src/features/accessibility/TalkBackToggle";
import { FeatureFlagService } from "../../src/features/featureFlags/FeatureFlagService";
import { accessibilityDetector } from "../../src/features/accessibility/AccessibilityDetector";
import { iosVoiceOverDetector } from "../../src/features/accessibility/IosVoiceOverDetector";
import { AndroidTapStrategy } from "../../src/features/action/strategies/AndroidTapStrategy";
import { defaultAdbClientFactory } from "../../src/utils/android-cmdline-tools/AdbClientFactory";
import { IOSCtrlProxyClient } from "../../src/features/observe/ios";
import { accessibilityStateSchema } from "../../src/server/toolOutputSchemas";
import type { BootedDevice } from "../../src/models";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeFeatureFlagApplier } from "../fakes/FakeFeatureFlagApplier";
import { FakeFeatureFlagRepository } from "../fakes/FakeFeatureFlagRepository";
import { FakeIOSCtrlProxy } from "../fakes/FakeIOSCtrlProxy";
import { FakeTimer } from "../fakes/FakeTimer";

const ANDROID_DEVICE: BootedDevice = { name: "a", deviceId: "emulator-5554", platform: "android" };
const IOS_DEVICE: BootedDevice = { name: "i", deviceId: "00008130-001", platform: "ios" };
const TALKBACK =
  "com.google.android.marvin.talkback/com.google.android.marvin.talkback.TalkBackService";

/**
 * The `accessibility` state check reports what the DEVICE says (#10222). Feature flags only change
 * what the action tools assume; the check names that in `detectionOverride` and leaves `enabled`
 * alone, so it agrees with the toggle reply and with the tap path's own flag-adjusted read.
 */
function accessibilityHandler() {
  const tool = ToolRegistry.getAllTools({ includeUnavailable: true }).find(
    (t) => t.name === "accessibility",
  );
  if (!tool?.deviceAwareHandler) {
    throw new Error("accessibility tool not registered");
  }
  return tool.deviceAwareHandler;
}

async function flagService(flags: {
  autoDetect: boolean;
  force: boolean;
}): Promise<FeatureFlagService> {
  const service = new FeatureFlagService(
    new FakeFeatureFlagRepository(),
    new FakeFeatureFlagApplier(),
  );
  await service.setFlag("accessibility-auto-detect", flags.autoDetect);
  await service.setFlag("force-accessibility-mode", flags.force);
  return service;
}

function androidWith(services: string) {
  const adb = new FakeAdbExecutor();
  adb.setCommandResponse("enabled_accessibility_services", { stdout: services, stderr: "" });
  return adb;
}

describe("accessibility state check ignores feature flags for `enabled` (#10222)", () => {
  const restores: Array<{ mockRestore: () => void }> = [];

  beforeEach(() => {
    ToolRegistry.clearTools();
    accessibilityDetector.clearAllCache();
    iosVoiceOverDetector.clearAllCache();
  });

  afterEach(() => {
    restores.splice(0).forEach((spy) => spy.mockRestore());
    ToolRegistry.clearTools();
    accessibilityDetector.clearAllCache();
    iosVoiceOverDetector.clearAllCache();
  });

  async function checkAndroid(
    services: string,
    flags: { autoDetect: boolean; force: boolean },
    args: { talkback?: boolean } = {},
  ) {
    const service = await flagService(flags);
    restores.push(
      spyOn(FeatureFlagService, "getInstance").mockReturnValue(service),
      spyOn(defaultAdbClientFactory, "create").mockReturnValue(androidWith(services)),
    );
    registerAccessibilityTools();
    return accessibilityHandler()(ANDROID_DEVICE, args);
  }

  async function checkIos(voiceOverOn: boolean, flags: { autoDetect: boolean; force: boolean }) {
    const service = await flagService(flags);
    const client = new FakeIOSCtrlProxy(new FakeTimer());
    client.setVoiceOverState(voiceOverOn);
    restores.push(
      spyOn(FeatureFlagService, "getInstance").mockReturnValue(service),
      spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(client as IOSCtrlProxyClient),
    );
    registerAccessibilityTools();
    return accessibilityHandler()(IOS_DEVICE, {});
  }

  test("auto-detect off with TalkBack on reports enabled: true and names the override", async () => {
    const response = await checkAndroid(TALKBACK, { autoDetect: false, force: false });

    expect(response.structuredContent).toEqual({
      enabled: true,
      service: "talkback",
      detectionOverride: { mode: "auto-detect-off", effectiveEnabled: false },
    });
    expect(accessibilityStateSchema.safeParse(response.structuredContent).success).toBe(true);
  });

  test("force mode with TalkBack off reports enabled: false and names the override", async () => {
    const response = await checkAndroid("null", { autoDetect: true, force: true });

    expect(response.structuredContent).toEqual({
      enabled: false,
      service: "unknown",
      detectionOverride: { mode: "forced-on", effectiveEnabled: true },
    });
    expect(accessibilityStateSchema.safeParse(response.structuredContent).success).toBe(true);
  });

  test("force wins when both overrides apply, like the detector", async () => {
    const response = await checkAndroid(TALKBACK, { autoDetect: false, force: true });

    expect(response.structuredContent).toMatchObject({
      enabled: true,
      detectionOverride: { mode: "forced-on", effectiveEnabled: true },
    });
  });

  test("default flags: no override field, enabled is the device reading", async () => {
    const on = await checkAndroid(TALKBACK, { autoDetect: true, force: false });
    expect(on.structuredContent).toEqual({ enabled: true, service: "talkback" });

    accessibilityDetector.clearAllCache();
    const off = await checkAndroid("null", { autoDetect: true, force: false });
    expect(off.structuredContent).toEqual({ enabled: false, service: "unknown" });
  });

  test("an unreadable device state is still the existing error, with the override named", async () => {
    const adb = new FakeAdbExecutor();
    adb.setCommandError("enabled_accessibility_services", new Error("device offline"));
    const service = await flagService({ autoDetect: false, force: false });
    restores.push(
      spyOn(FeatureFlagService, "getInstance").mockReturnValue(service),
      spyOn(defaultAdbClientFactory, "create").mockReturnValue(adb),
    );
    registerAccessibilityTools();

    const response = await accessibilityHandler()(ANDROID_DEVICE, {});

    expect(response.structuredContent).toEqual({
      service: "unknown",
      reason: "could not determine TalkBack state: device accessibility settings read unavailable",
      detectionOverride: { mode: "auto-detect-off", effectiveEnabled: false },
    });
  });

  test("a no-op toggle then the check agree on enabled, and tapOn keeps its flag-adjusted read", async () => {
    const adb = androidWith(TALKBACK);
    const service = await flagService({ autoDetect: false, force: false });
    restores.push(
      spyOn(FeatureFlagService, "getInstance").mockReturnValue(service),
      spyOn(defaultAdbClientFactory, "create").mockReturnValue(adb),
      spyOn(TalkBackToggle.prototype, "toggle").mockResolvedValue({
        supported: true,
        applied: false,
        currentState: true,
      }),
    );
    registerAccessibilityTools();

    const toggled = await accessibilityHandler()(ANDROID_DEVICE, { talkback: true });
    const checked = await accessibilityHandler()(ANDROID_DEVICE, {});

    expect(toggled.structuredContent).toMatchObject({ enabled: true, service: "talkback" });
    expect(checked.structuredContent).toMatchObject({ enabled: true, service: "talkback" });
    // The tap path is flag-adjusted by design: with auto-detect off it does not adapt, and the
    // check's `detectionOverride.effectiveEnabled` reports exactly that answer.
    const strategy = new AndroidTapStrategy(ANDROID_DEVICE, adb, accessibilityDetector, service);
    expect(await strategy.isAccessibilityServiceEnabled()).toBe(false);
    expect(checked.structuredContent).toMatchObject({
      detectionOverride: { effectiveEnabled: false },
    });
  });

  test("iOS: auto-detect off with VoiceOver on reports enabled: true", async () => {
    const response = await checkIos(true, { autoDetect: false, force: false });

    expect(response.structuredContent).toEqual({
      enabled: true,
      service: "voiceover",
      detectionOverride: { mode: "auto-detect-off", effectiveEnabled: false },
    });
  });

  test("iOS: force mode with VoiceOver off reports enabled: false", async () => {
    const response = await checkIos(false, { autoDetect: true, force: true });

    expect(response.structuredContent).toEqual({
      enabled: false,
      service: "unknown",
      detectionOverride: { mode: "forced-on", effectiveEnabled: true },
    });
  });
});
