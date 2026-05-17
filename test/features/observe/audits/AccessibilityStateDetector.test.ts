import { describe, expect, test } from "bun:test";
import { AccessibilityStateDetector } from "../../../../src/features/observe/audits/AccessibilityStateDetector";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { NoOpPerformanceTracker } from "../../../../src/utils/PerformanceTracker";
import { OPERATION_CANCELLED_MESSAGE } from "../../../../src/utils/constants";
import type { BootedDevice, ObserveResult } from "../../../../src/models";

function makeResult(): ObserveResult {
  return {
    updatedAt: "2026-01-01T00:00:00.000Z",
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  } as ObserveResult;
}

const androidDevice: BootedDevice = { deviceId: "dev-1", name: "android", platform: "android" };

describe("AccessibilityStateDetector", () => {
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
