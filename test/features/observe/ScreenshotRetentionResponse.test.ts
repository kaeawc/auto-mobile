import { validateCapturedScreenshot } from "../../../src/features/observe/screenshot/validateCapturedScreenshot";
import { FakeFileSystem } from "../../fakes/FakeFileSystem";
import { FakeScreenshotFileWriter } from "../../fakes/FakeScreenshotFileWriter";
import { afterEach, expect, spyOn, test } from "bun:test";
import { RealObserveScreen } from "../../../src/features/observe/ObserveScreen";
import { ScreenshotRetentionCapacityError } from "../../../src/features/observe/ScreenshotRetention";
import { resetObserveCacheStore } from "../../../src/features/observe/cache/ObserveCacheRegistry";
import { resetScreenshotStateStore } from "../../../src/features/observe/screenshot/ScreenshotStateRegistry";
import { TakeScreenshot } from "../../../src/features/observe/TakeScreenshot";
import { FakeObserveCacheStore } from "../../fakes/FakeObserveCacheStore";
import { FakeScreenshotStateStore } from "../../fakes/FakeScreenshotStateStore";
import { FakeScreenshotPathProtection } from "../../fakes/FakeScreenshotPathProtection";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeScreenshotRecorder } from "../../fakes/FakeScreenshotRecorder";
import { NoOpPerformanceTracker } from "../../../src/utils/PerformanceTracker";
import type { ScreenshotResult } from "../../../src/models/ScreenshotResult";

const device = { deviceId: "retention-response", name: "Fake", platform: "ios" } as const;
const capacity = new ScreenshotRetentionCapacityError(128 * 1024 * 1024, 2, 600_000);

afterEach(() => {
  resetObserveCacheStore();
  resetScreenshotStateStore();
});
function setup(capture: ScreenshotResult) {
  const timer = new FakeTimer();
  const protection = new FakeScreenshotPathProtection(timer);
  const screenshot = {
    execute: capture.actionableError ? capacityCapture(timer) : async () => capture,
    generateScreenshotPath: () => "/fresh.png",
    getActivityHash: async () => "hash",
  };
  const recorder = new FakeScreenshotRecorder();
  recorder.settledError = capture.actionableError;
  const screen = new RealObserveScreen(
    device,
    new FakeAdbClientFactory(new FakeAdbExecutor()),
    {
      screenshot,
      screenshotPathProtection: protection,
      cacheStore: new FakeObserveCacheStore(timer),
      screenshotStateStore: new FakeScreenshotStateStore(timer),
      screenshotEvidenceFiles: { stat: async () => ({ isFile: () => true, size: 1, mtimeMs: 0 }) },
      screenshotRecorder: recorder,
    },
    timer,
  );
  return { timer, protection, screen, result: screen.createBaseResult() };
}

/** Retention no longer refuses (#8758), but callers still handle the typed error from a capture. */
function capacityCapture(timer: FakeTimer) {
  const screenshot = new TakeScreenshot(
    device,
    new FakeAdbClientFactory(new FakeAdbExecutor()),
    timer,
    undefined,
    new FakeScreenshotFileWriter(),
    new FakeFileSystem(),
    () => "/screenshots",
  );
  spyOn(screenshot, "captureScreenshot").mockRejectedValue(capacity);
  return screenshot.execute.bind(screenshot);
}

test("fresh device-read and settled paths report the same host-clock ten-minute expiry", async () => {
  const { timer, screen, result } = setup({ success: true, path: "/fresh.png" });
  timer.advanceTime(1234);
  await screen["captureDeviceReadScreenshot"](result);
  expect(result.screenshotExpiresAt).toBe(601_234);
  await screen["captureSettledScreenshot"](result, new NoOpPerformanceTracker(), undefined, true);
  expect(result.screenshotExpiresAt).toBe(601_234);
});

test("default provenance capture degrades with a capacity reason and no path", async () => {
  const { screen, result } = setup({
    success: false,
    error: capacity.message,
    actionableError: capacity,
  });
  await screen["captureDeviceReadScreenshot"](result);
  expect(result.screenshotPath).toBeUndefined();
  expect(result.screenshotSettled).toBe(false);
  expect(result.screenshotSettledError).toContain("Screenshot retention capacity");
});

test("explicit device-read and settled captures preserve the typed capacity error", async () => {
  const { screen, result } = setup({
    success: false,
    error: capacity.message,
    actionableError: capacity,
  });
  await expect(
    screen["captureDeviceReadScreenshot"](result, undefined, undefined, {
      requireFreshScreenshot: true,
    }),
  ).rejects.toBeInstanceOf(ScreenshotRetentionCapacityError);
  await expect(
    screen["captureSettledScreenshot"](result, new NoOpPerformanceTracker(), undefined, true),
  ).rejects.toBeInstanceOf(ScreenshotRetentionCapacityError);
});

test("TakeScreenshot execute preserves the typed cause alongside its string error", async () => {
  const timer = new FakeTimer();
  const screenshot = new TakeScreenshot(
    device,
    new FakeAdbClientFactory(new FakeAdbExecutor()),
    timer,
    undefined,
    undefined,
    undefined,
    () => "/unused",
    undefined,
    false,
    { pathProtection: new FakeScreenshotPathProtection(timer) },
  );
  const capture = spyOn(screenshot, "captureScreenshot").mockRejectedValue(capacity);
  try {
    expect(await screenshot.execute()).toMatchObject({ success: false, actionableError: capacity });
  } finally {
    capture.mockRestore();
  }
});

test("settled screenshot validation preserves the typed capture capacity cause", async () => {
  await expect(
    validateCapturedScreenshot(
      { success: false, error: capacity.message, actionableError: capacity },
      device.deviceId,
      async () => true,
    ),
  ).rejects.toBe(capacity);
});
