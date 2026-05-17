import { describe, expect, test } from "bun:test";
import { PerformanceAuditor } from "../../../../src/features/observe/audits/PerformanceAuditor";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
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
      adb: new FakeAdbExecutor(),
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
      adb: new FakeAdbExecutor(),
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
      adb: new FakeAdbExecutor(),
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
      adb: new FakeAdbExecutor(),
      isEnabled: () => true,
    });
    const result = makeResult({ activeWindow: { appId: "com.example", activityName: "Main" } as any });
    // FakeAdbExecutor has no responses configured; underlying audit will fail.
    // We just need to confirm no exception leaks and no errors are appended.
    await auditor.run(result, new NoOpPerformanceTracker());
    expect(result.errors).toBeUndefined();
  });
});
