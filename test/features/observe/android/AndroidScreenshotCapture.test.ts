import { describe, expect, test } from "bun:test";
import {
  A11Y_SCREENSHOT_REPROBE_COOLDOWN_MS,
  AndroidScreenshotCapture,
  type AndroidScreenshotCaptureContext,
} from "../../../../src/features/observe/android/AndroidScreenshotCapture";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { AndroidPhysicalDisplayIdResolver } from "../../../../src/features/observe/android/AndroidPhysicalDisplayId";
import { TrackedScreenGeometry } from "../../../../src/features/observe/TrackedScreenGeometry";
import { RequestManager } from "../../../../src/utils/RequestManager";
import { CountingIdGenerator } from "../../../../src/utils/IdGenerator";
import { logger } from "../../../../src/utils/logger";

function harness(options: { closed?: boolean } = {}) {
  const timer = new FakeTimer();
  const adb = new FakeAdbExecutor();
  const context: AndroidScreenshotCaptureContext = {
    adb,
    timer,
    deviceId: "emu",
    closed: options.closed ?? false,
    logger,
    idGenerator: new CountingIdGenerator("t"),
    physicalDisplayIdResolver: new AndroidPhysicalDisplayIdResolver(),
    screenGeometry: new TrackedScreenGeometry(),
    requestManager: new RequestManager(timer),
    screenshotObservationStreamSuppressions: new Set(),
    socket: null,
    noteScreenshotCaptureStarted: () => {},
  };
  return { capture: new AndroidScreenshotCapture(context), adb, timer };
}

describe("AndroidScreenshotCapture", () => {
  test("a closed client suppresses the ADB fallback and runs no adb command", async () => {
    const { capture, adb } = harness({ closed: true });
    capture.a11yScreenshotSupported = false;
    const result = await capture.captureForObservationStream();
    expect(result.success).toBe(false);
    expect(result.error).toContain("fallback suppressed");
    expect(adb.getExecutedArgv()).toEqual([]);
  });

  test("an unsupported latch stays latched inside the reprobe cooldown", async () => {
    const { capture, timer } = harness({ closed: true });
    capture.a11yScreenshotSupported = false;
    timer.advanceTime(A11Y_SCREENSHOT_REPROBE_COOLDOWN_MS - 1);
    await capture.captureForObservationStream();
    expect(capture.a11yScreenshotSupported).toBe(false);
  });

  test("reset clears the latch", () => {
    const { capture } = harness();
    capture.a11yScreenshotSupported = false;
    capture.resetA11yScreenshotSupport();
    expect(capture.a11yScreenshotSupported).toBeNull();
  });
});
