import { loggerCallsWithPrefix } from "../../../helpers/loggerCallsWithPrefix";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CTRL_PROXY_ACCESSIBILITY_SERVICE_COMPONENT } from "../../../../src/ctrlProxy/constants";
import { DefaultAccessibilityDetector } from "../../../../src/features/accessibility/AccessibilityDetector";
import type { FeatureFlagService } from "../../../../src/features/featureFlags/FeatureFlagService";
import { AccessibilityStateDetector } from "../../../../src/features/observe/audits/AccessibilityStateDetector";
import type { BootedDevice, ObserveResult } from "../../../../src/models";
import { invalidateReadinessForDisabledAccessibility } from "../../../../src/server/observeTools";
import { NoOpPerformanceTracker } from "../../../../src/utils/PerformanceTracker";
import { logger } from "../../../../src/utils/logger";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../../fakes/FakeTimer";

const captured = readFileSync(
  new URL("../../../fixtures/ctrlproxy/accessibility-api36-bound.txt", import.meta.url),
  "utf8",
);
const ctrlProxy = captured.match(/Enabled services:\{\{([^}]+)\}\}/)?.[1];
expect(ctrlProxy).toBe(CTRL_PROXY_ACCESSIBILITY_SERVICE_COMPONENT);
const talkBack =
  "com.google.android.marvin.talkback/com.google.android.marvin.talkback.TalkBackService";
const thirdParty = "com.example.reader/com.example.reader.ReaderService";
const device: BootedDevice = { deviceId: "readiness-device", name: "Pixel", platform: "android" };
const flags = {
  isEnabled: (key: string) => key === "accessibility-auto-detect",
} as FeatureFlagService;

function harness(featureFlags = flags) {
  const adb = new FakeAdbExecutor();
  const timer = new FakeTimer();
  const detector = new DefaultAccessibilityDetector(timer);
  const audit = new AccessibilityStateDetector({
    device,
    adb,
    featureFlags,
    accessibilityDetector: detector,
  });
  const calls: string[] = [];
  const actions = {
    accessibilityDetector: detector,
    resetSetupState: () => calls.push("reset"),
    isDaemonInitialized: () => true,
    invalidateAutomationReadiness: (session: string, reason: string) =>
      calls.push(`invalidate:${session}:${reason}`),
  };
  const setOutput = (stdout: string) =>
    adb.setCommandResponse("enabled_accessibility_services", { stdout, stderr: "" });
  const observe = async () => {
    const result = {} as ObserveResult;
    await audit.run(result, new NoOpPerformanceTracker());
    await invalidateReadinessForDisabledAccessibility(device, result, "owner", actions);
    return result.accessibilityState;
  };
  return { adb, timer, detector, actions, calls, setOutput, observe };
}

afterEach(() => spyOn(logger, "warn").mockRestore());

describe("observe CtrlProxy readiness regression", () => {
  test("healthy CtrlProxy-only repeated observations preserve readiness and user state", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const h = harness();
    h.setOutput(ctrlProxy!);
    for (let i = 0; i < 3; i++) {
      expect(await h.observe()).toEqual({
        enabled: false,
        service: "unknown",
        detectionSkipped: false,
      });
    }
    expect(h.calls).toEqual([]);
    expect(
      loggerCallsWithPrefix(
        warn.mock.calls,
        "[AccessibilityDetector]",
        "[observe] Accessibility service not enabled",
        "[observe] Failed to reset accessibility setup state",
      ),
    ).toHaveLength(0);
    expect(h.adb.getExecutedCommands()).toHaveLength(1);
  });

  test.each(["null", "", thirdParty])(
    "loss (%s) acts on every confirmed-disabled observe and clears cache",
    async (output) => {
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      const h = harness();
      h.setOutput(output);
      for (let i = 0; i < 3; i++) {
        expect(await h.observe()).toEqual({
          enabled: output === thirdParty,
          service: "unknown",
          detectionSkipped: false,
        });
      }
      expect(h.calls).toEqual([
        "reset",
        "invalidate:owner:accessibility service disabled",
        "reset",
        "invalidate:owner:accessibility service disabled",
        "reset",
        "invalidate:owner:accessibility service disabled",
      ]);
      expect(
        loggerCallsWithPrefix(
          warn.mock.calls,
          "[AccessibilityDetector]",
          "[observe] Accessibility service not enabled",
          "[observe] Failed to reset accessibility setup state",
        ),
      ).toHaveLength(3);
      // Every confirmed loss evicts the cached read, so every observation reads fresh.
      expect(h.adb.getExecutedCommands()).toHaveLength(3);
      expect(await h.detector.isCtrlProxyServiceEnabled(device.deviceId)).toBeNull();
    },
  );

  test("CtrlProxy alongside TalkBack reports TalkBack without invalidation", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const h = harness();
    // CtrlProxy-plus-TalkBack settings are composed from real component names, not captured.
    h.setOutput([ctrlProxy, talkBack].join(":"));
    expect(await h.observe()).toEqual({
      enabled: true,
      service: "talkback",
      detectionSkipped: false,
    });
    expect(h.calls).toEqual([]);
    expect(
      loggerCallsWithPrefix(
        warn.mock.calls,
        "[AccessibilityDetector]",
        "[observe] Accessibility service not enabled",
        "[observe] Failed to reset accessibility setup state",
      ),
    ).toHaveLength(0);
  });

  test("failed adb detection is unknown and preserves readiness", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const h = harness();
    h.adb.setCommandError("enabled_accessibility_services", new Error("ADB read failed"));
    await h.observe();
    expect(h.calls).toEqual([]);
    expect(
      loggerCallsWithPrefix(
        warn.mock.calls,
        "[AccessibilityDetector]",
        "[observe] Accessibility service not enabled",
        "[observe] Failed to reset accessibility setup state",
      ),
    ).toHaveLength(1); // Diagnostic warning only, no readiness warning.
    expect(h.adb.getExecutedCommands()).toHaveLength(1);
  });

  test("a returned adb error is unknown, even with empty stdout", async () => {
    spyOn(logger, "warn").mockImplementation(() => {});
    const h = harness();
    h.adb.setCommandResponse("enabled_accessibility_services", {
      stdout: "",
      stderr: "ADB read failed",
    });
    const execute = h.adb.executeCommand.bind(h.adb);
    const command = spyOn(h.adb, "executeCommand").mockImplementation(async (...args) => ({
      ...(await execute(...args)),
      error: "ADB read failed",
    }));
    await h.observe();
    expect(h.calls).toEqual([]);
    expect(await h.detector.isCtrlProxyServiceEnabled(device.deviceId, h.adb)).toBeNull();
    command.mockRestore();
  });

  test("unknown preserves readiness and cache eviction observes immediate recovery", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const h = harness();
    h.setOutput("null");
    await h.observe();
    const read = spyOn(h.detector, "isCtrlProxyServiceEnabled").mockResolvedValue(null);
    await h.observe();
    expect(h.calls).toEqual(["reset", "invalidate:owner:accessibility service disabled"]);
    expect(
      loggerCallsWithPrefix(
        warn.mock.calls,
        "[AccessibilityDetector]",
        "[observe] Accessibility service not enabled",
        "[observe] Failed to reset accessibility setup state",
      ),
    ).toHaveLength(1);
    read.mockRestore();
    await h.observe();
    // Each loss evicts the cache, so immediate recovery needs no TTL advance.
    h.setOutput(ctrlProxy!);
    await h.observe();
    expect(
      loggerCallsWithPrefix(
        warn.mock.calls,
        "[AccessibilityDetector]",
        "[observe] Accessibility service not enabled",
        "[observe] Failed to reset accessibility setup state",
      ),
    ).toHaveLength(2);
    expect(h.calls).toHaveLength(4);
    expect(h.adb.getExecutedCommands()).toHaveLength(3);
  });

  test("skipped detection, missing state and non-Android observations do not consult readiness", async () => {
    const h = harness({ isEnabled: () => false } as FeatureFlagService);
    const read = spyOn(h.detector, "isCtrlProxyServiceEnabled");
    expect(await h.observe()).toEqual({
      enabled: false,
      service: "unknown",
      detectionSkipped: true,
    });
    await invalidateReadinessForDisabledAccessibility(
      { ...device, platform: "ios" },
      { accessibilityState: { enabled: false, service: "unknown" } } as ObserveResult,
      "owner",
      h.actions,
    );
    await invalidateReadinessForDisabledAccessibility(
      device,
      {} as ObserveResult,
      "owner",
      h.actions,
    );
    expect(h.calls).toEqual([]);
    expect(h.adb.getExecutedCommands()).toEqual([]);
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();
  });

  test("confirmed loss invalidates each device's detector cache", async () => {
    spyOn(logger, "warn").mockImplementation(() => {});
    const h = harness();
    h.setOutput("null");
    await h.observe();
    await h.detector.isAccessibilityEnabled("second-device", h.adb);
    await invalidateReadinessForDisabledAccessibility(
      { ...device, deviceId: "second-device" },
      { accessibilityState: { enabled: false, service: "unknown" } } as ObserveResult,
      "second-owner",
      h.actions,
    );
    expect(h.calls).toHaveLength(4);
    expect(await h.detector.isCtrlProxyServiceEnabled(device.deviceId)).toBeNull();
    expect(await h.detector.isCtrlProxyServiceEnabled("second-device")).toBeNull();
  });
});

describe("detector CtrlProxy signal", () => {
  test("cache-only consumption returns unknown until a real read is cached", async () => {
    const h = harness();
    expect(await h.detector.isCtrlProxyServiceEnabled(device.deviceId)).toBeNull();
    h.setOutput(ctrlProxy!);
    await h.detector.isAccessibilityEnabled(device.deviceId, h.adb);
    expect(await h.detector.isCtrlProxyServiceEnabled(device.deviceId)).toBe(true);
    h.timer.advanceTime(60001);
    expect(await h.detector.isCtrlProxyServiceEnabled(device.deviceId)).toBeNull();
    expect(h.adb.getExecutedCommands()).toHaveLength(1);
  });
  test.each([ctrlProxy!, "dev.jasonpearson.automobile.ctrlproxy/.CtrlProxy"])(
    "recognizes %s while sharing the 60s cache with user detection",
    async (component) => {
      const h = harness();
      h.setOutput(component);
      expect(await h.detector.isCtrlProxyServiceEnabled(device.deviceId, h.adb)).toBe(true);
      expect(await h.detector.isAccessibilityEnabled(device.deviceId, h.adb)).toBe(false);
      expect(await h.detector.detectMethod(device.deviceId, h.adb)).toBe("unknown");
      expect(h.adb.getExecutedCommands()).toHaveLength(1);
      h.setOutput("null");
      h.timer.advanceTime(59999);
      expect(await h.detector.isCtrlProxyServiceEnabled(device.deviceId, h.adb)).toBe(true);
      h.timer.advanceTime(2);
      expect(await h.detector.isCtrlProxyServiceEnabled(device.deviceId, h.adb)).toBe(false);
      expect(h.adb.getExecutedCommands()).toHaveLength(2);
    },
  );

  test("detectMethod populates CtrlProxy signal cache; invalidation forces a fresh read", async () => {
    const h = harness();
    h.setOutput(ctrlProxy!);
    expect(await h.detector.detectMethod(device.deviceId, h.adb)).toBe("unknown");
    expect(await h.detector.isCtrlProxyServiceEnabled(device.deviceId, h.adb)).toBe(true);
    expect(h.adb.getExecutedCommands()).toHaveLength(1);
    h.detector.invalidateCache(device.deviceId);
    h.setOutput(thirdParty);
    expect(await h.detector.isCtrlProxyServiceEnabled(device.deviceId, h.adb)).toBe(false);
    expect(await h.detector.isAccessibilityEnabled(device.deviceId, h.adb)).toBe(true);
    expect(h.adb.getExecutedCommands()).toHaveLength(2);
  });

  test("failure is not cached; every call retries and recovery needs no timer advance", async () => {
    spyOn(logger, "warn").mockImplementation(() => {});
    const h = harness();
    const failedAdb = new FakeAdbExecutor();
    failedAdb.setDefaultError(new Error("ADB unavailable"));
    expect(await h.detector.isAccessibilityEnabled(device.deviceId, failedAdb)).toBe(false);
    expect(await h.detector.detectMethod(device.deviceId, failedAdb)).toBe("unknown");
    expect(await h.detector.isCtrlProxyServiceEnabled(device.deviceId, failedAdb)).toBeNull();
    expect(failedAdb.getExecutedCommands()).toHaveLength(3);
    h.setOutput(ctrlProxy!);
    expect(await h.detector.isCtrlProxyServiceEnabled(device.deviceId, h.adb)).toBe(true);
  });

  test("feature flags cannot synthesize evidence of CtrlProxy loss or health", async () => {
    const h = harness();
    for (const force of [false, true]) {
      const featureFlags = {
        isEnabled: (key: string) => key === "force-accessibility-mode" && force,
      } as FeatureFlagService;
      expect(
        await h.detector.isCtrlProxyServiceEnabled(device.deviceId, h.adb, featureFlags),
      ).toBeNull();
    }
    expect(h.adb.getExecutedCommands()).toEqual([]);
  });
});
