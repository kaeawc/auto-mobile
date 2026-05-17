import { describe, expect, test } from "bun:test";
import { AccessibilityAuditor } from "../../../../src/features/observe/audits/AccessibilityAuditor";
import { NoOpPerformanceTracker } from "../../../../src/utils/PerformanceTracker";
import type { BootedDevice, ObserveResult } from "../../../../src/models";
import type { AccessibilityAuditConfig } from "../../../../src/models/AccessibilityAudit";

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

const enabledConfig: AccessibilityAuditConfig = {
  level: "AA",
} as AccessibilityAuditConfig;

describe("AccessibilityAuditor", () => {
  test("does nothing when getConfig returns null", async () => {
    const auditor = new AccessibilityAuditor({
      device: androidDevice,
      getConfig: () => null,
    });
    const result = makeResult({
      activeWindow: { appId: "com.example", activityName: "Main" } as any,
      viewHierarchy: { hierarchy: { node: {} } } as any,
    });
    await auditor.run(result, new NoOpPerformanceTracker());
    expect(result.accessibilityAudit).toBeUndefined();
    expect(result.errors).toBeUndefined();
  });

  test("skips when device platform is not android", async () => {
    const auditor = new AccessibilityAuditor({
      device: iosDevice,
      getConfig: () => enabledConfig,
    });
    const result = makeResult({
      activeWindow: { appId: "com.example", activityName: "Main" } as any,
      viewHierarchy: { hierarchy: { node: {} } } as any,
    });
    await auditor.run(result, new NoOpPerformanceTracker());
    expect(result.accessibilityAudit).toBeUndefined();
    expect(result.errors).toBeUndefined();
  });

  test("skips when no view hierarchy", async () => {
    const auditor = new AccessibilityAuditor({
      device: androidDevice,
      getConfig: () => enabledConfig,
    });
    const result = makeResult({
      activeWindow: { appId: "com.example", activityName: "Main" } as any,
    });
    await auditor.run(result, new NoOpPerformanceTracker());
    expect(result.accessibilityAudit).toBeUndefined();
    expect(result.errors).toBeUndefined();
  });

  test("skips when no activeWindow.appId", async () => {
    const auditor = new AccessibilityAuditor({
      device: androidDevice,
      getConfig: () => enabledConfig,
    });
    const result = makeResult({
      viewHierarchy: { hierarchy: { node: {} } } as any,
    });
    await auditor.run(result, new NoOpPerformanceTracker());
    expect(result.accessibilityAudit).toBeUndefined();
    expect(result.errors).toBeUndefined();
  });

  test("audit failures do not pollute result.errors", async () => {
    const auditor = new AccessibilityAuditor({
      device: androidDevice,
      getConfig: () => enabledConfig,
      // Force the resolver to throw — exercises catch path.
      screenshotPathResolver: async () => {
        throw new Error("boom");
      },
    });
    const result = makeResult({
      activeWindow: { appId: "com.example", activityName: "Main" } as any,
      viewHierarchy: { hierarchy: { node: {} } } as any,
    });
    await auditor.run(result, new NoOpPerformanceTracker());
    expect(result.errors).toBeUndefined();
  });
});
