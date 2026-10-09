import { afterEach, expect, test } from "bun:test";
import { RealObserveScreen } from "../../../src/features/observe/ObserveScreen";
import { resetObserveCacheStore } from "../../../src/features/observe/cache/ObserveCacheRegistry";
import { resetScreenshotStateStore } from "../../../src/features/observe/screenshot/ScreenshotStateRegistry";
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

afterEach(() => {
  resetObserveCacheStore();
  resetScreenshotStateStore();
});
function setup(capture: ScreenshotResult) {
  const timer = new FakeTimer();
  const protection = new FakeScreenshotPathProtection(timer);
  const screenshot = {
    execute: async () => capture,
    generateScreenshotPath: () => "/fresh.png",
    getActivityHash: async () => "hash",
  };
  const recorder = new FakeScreenshotRecorder();
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

test("fresh device-read and settled paths report the same host-clock ten-minute expiry", async () => {
  const { timer, screen, result } = setup({ success: true, path: "/fresh.png" });
  timer.advanceTime(1234);
  await screen["captureDeviceReadScreenshot"](result);
  expect(result.screenshotExpiresAt).toBe(601_234);
  await screen["captureSettledScreenshot"](result, new NoOpPerformanceTracker(), undefined, true);
  expect(result.screenshotExpiresAt).toBe(601_234);
});
