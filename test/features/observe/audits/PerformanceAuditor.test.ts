import { describe, expect, test } from "bun:test";
import { PerformanceAuditor } from "../../../../src/features/observe/audits/PerformanceAuditor";
import { FakeAdbClientFactory } from "../../../fakes/FakeAdbClientFactory";
import { NoOpPerformanceTracker } from "../../../../src/utils/PerformanceTracker";
import type { BootedDevice, ObserveResult } from "../../../../src/models";

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

describe("PerformanceAuditor", () => {
  test("does nothing when isEnabled returns false", async () => {
    const auditor = new PerformanceAuditor({
      device: androidDevice,
      adbFactory: new FakeAdbClientFactory(),
      isEnabled: () => false,
    });
    const result = makeResult({ activeWindow: { appId: "com.example", activityName: "Main" } as any });
    await auditor.run(result, new NoOpPerformanceTracker());
    expect(result.performanceAudit).toBeUndefined();
    expect(result.errors).toBeUndefined();
  });

  test("skips when device platform is not android", async () => {
    const auditor = new PerformanceAuditor({
      device: iosDevice,
      adbFactory: new FakeAdbClientFactory(),
      isEnabled: () => true,
    });
    const result = makeResult({ activeWindow: { appId: "com.example", activityName: "Main" } as any });
    await auditor.run(result, new NoOpPerformanceTracker());
    expect(result.performanceAudit).toBeUndefined();
    expect(result.errors).toBeUndefined();
  });

  test("skips when no activeWindow.appId is set", async () => {
    const auditor = new PerformanceAuditor({
      device: androidDevice,
      adbFactory: new FakeAdbClientFactory(),
      isEnabled: () => true,
    });
    const result = makeResult();
    await auditor.run(result, new NoOpPerformanceTracker());
    expect(result.performanceAudit).toBeUndefined();
    expect(result.errors).toBeUndefined();
  });

  test("audit failures do not pollute result.errors", async () => {
    const auditor = new PerformanceAuditor({
      device: androidDevice,
      adbFactory: new FakeAdbClientFactory(),
      isEnabled: () => true,
    });
    const result = makeResult({ activeWindow: { appId: "com.example", activityName: "Main" } as any });
    await auditor.run(result, new NoOpPerformanceTracker());
    expect(result.errors).toBeUndefined();
  });

  // Regression for https://github.com/kaeawc/auto-mobile/issues/2214.
  // The internal DeviceCapabilitiesDetector and PerformanceAudit constructors
  // require an AdbClientFactory and invoke `.create(device)` on it. Passing
  // anything else surfaces in production as `TypeError: J.create is not a
  // function` (after bundler minification) and silently breaks the audit.
  // Asserting the factory is invoked proves the auditor wires the factory
  // through rather than handing those constructors an AdbExecutor.
  test("uses the injected AdbClientFactory to construct dependents (regression for #2214)", async () => {
    const factory = new FakeAdbClientFactory();
    const auditor = new PerformanceAuditor({
      device: androidDevice,
      adbFactory: factory,
      isEnabled: () => true,
    });
    const result = makeResult({ activeWindow: { appId: "com.example", activityName: "Main" } as any });
    await auditor.run(result, new NoOpPerformanceTracker());
    expect(factory.wasCalledForDevice(androidDevice.deviceId)).toBe(true);
  });
});
