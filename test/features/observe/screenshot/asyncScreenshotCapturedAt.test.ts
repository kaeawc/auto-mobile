import { describe, expect, test } from "bun:test";
import { stampAsyncScreenshotCapturedAt } from "../../../../src/features/observe/screenshot/asyncScreenshotCapturedAt";
import type { ObserveResult } from "../../../../src/models/ObserveResult";
import { buildObserveResult } from "../../../helpers/observeFixture";
import { FakeScreenshotStateStore } from "../../../fakes/FakeScreenshotStateStore";
import { FakeTimer } from "../../../fakes/FakeTimer";

const DEVICE = "emulator-5554";
const MTIME = Date.parse("2026-11-10T07:23:00.000Z");

function observation(): ObserveResult {
  return {
    ...buildObserveResult({
      updatedAt: 0,
      screenSize: { width: 1080, height: 1920 },
      systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    }),
    observationId: "obs-1",
  };
}

const files = (stat: () => Promise<{ isFile(): boolean; size: number; mtimeMs: number }>) => ({
  stat,
});

describe("stampAsyncScreenshotCapturedAt (#17765)", () => {
  test("stamps the committed file's capture time and nothing else", async () => {
    const store = new FakeScreenshotStateStore(new FakeTimer());
    store.updateForObservation(DEVICE, "obs-1", { path: "/shots/obs-1.png" });
    const frame = observation();
    await stampAsyncScreenshotCapturedAt(frame, DEVICE, {
      store,
      files: files(async () => ({ isFile: () => true, size: 10, mtimeMs: MTIME })),
    });
    expect(frame.screenshotCapturedAt).toBe(new Date(MTIME).toISOString());
    expect(frame.screenshotPath).toBeUndefined();
  });

  test("a failed capture or a swept file leaves the time unset", async () => {
    const store = new FakeScreenshotStateStore(new FakeTimer());
    store.updateForObservation(DEVICE, "obs-1", { error: "capture failed" });
    const failed = observation();
    await stampAsyncScreenshotCapturedAt(failed, DEVICE, {
      store,
      files: files(async () => {
        throw new Error("must not stat without a path");
      }),
    });
    expect(failed.screenshotCapturedAt).toBeUndefined();

    store.updateForObservation(DEVICE, "obs-1", { path: "/shots/gone.png" });
    const swept = observation();
    await stampAsyncScreenshotCapturedAt(swept, DEVICE, {
      store,
      files: files(async () => {
        throw new Error("ENOENT");
      }),
    });
    expect(swept.screenshotCapturedAt).toBeUndefined();
  });
});
