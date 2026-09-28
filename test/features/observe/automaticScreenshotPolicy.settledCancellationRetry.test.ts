import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveScreenshotMode } from "../../../src/features/observe/automaticScreenshotPolicy";
import {
  DefaultObserveScreenshotRecorder,
  type TrackedScreenshotService,
} from "../../../src/features/observe/screenshot/ObserveScreenshotRecorder";
import type { ScreenshotResult } from "../../../src/models/ScreenshotResult";
import { OPERATION_CANCELLED_MESSAGE } from "../../../src/utils/constants";
import { ScreenshotJobTracker } from "../../../src/utils/ScreenshotJobTracker";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeScreenshotStateStore } from "../../fakes/FakeScreenshotStateStore";

const device = { deviceId: "settled-test-device", name: "Fake", platform: "android" } as const;

function gate() {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, promise };
}

describe("resolveScreenshotMode", () => {
  const enabled = { isEnabled: () => true } as never;
  const disabled = { isEnabled: () => false } as never;

  test("per-call argument overrides env and flag", () => {
    expect(
      resolveScreenshotMode("none", { AUTOMOBILE_OBSERVE_SETTLED_SCREENSHOT: "1" }, enabled),
    ).toBe("none");
    expect(
      resolveScreenshotMode("settled", { AUTOMOBILE_OBSERVE_SETTLED_SCREENSHOT: "0" }, disabled),
    ).toBe("settled");
  });

  test("env true/1 and false/0 override the persisted flag", () => {
    expect(
      resolveScreenshotMode(
        undefined,
        { AUTOMOBILE_OBSERVE_SETTLED_SCREENSHOT: " TRUE " },
        disabled,
      ),
    ).toBe("settled");
    expect(
      resolveScreenshotMode(undefined, { AUTOMOBILE_OBSERVE_SETTLED_SCREENSHOT: "1" }, disabled),
    ).toBe("settled");
    expect(
      resolveScreenshotMode(undefined, { AUTOMOBILE_OBSERVE_SETTLED_SCREENSHOT: "false" }, enabled),
    ).toBe("async");
    expect(
      resolveScreenshotMode(undefined, { AUTOMOBILE_OBSERVE_SETTLED_SCREENSHOT: "0" }, enabled),
    ).toBe("async");
    expect(resolveScreenshotMode(undefined, {}, enabled)).toBe("settled");
    expect(resolveScreenshotMode(undefined, {}, disabled)).toBe("async");
  });
});

describe("settled cancellation retry", () => {
  const timer = new FakeTimer();
  let directory: string;

  beforeEach(() => {
    ScreenshotJobTracker.clear();
    ScreenshotJobTracker.setTimer(timer);
    directory = mkdtempSync(join(tmpdir(), "settled-shot-"));
  });

  afterEach(() => {
    ScreenshotJobTracker.clear();
    ScreenshotJobTracker.resetTimer();
    rmSync(directory, { recursive: true, force: true });
  });

  function recorderWithCancelledFirstAttempt(secondResult: ScreenshotResult) {
    const firstStarted = gate();
    const path = join(directory, "capture.png");
    writeFileSync(path, "fake PNG bytes");
    let attempts = 0;
    const options: Array<{ queueAfterPending?: boolean }> = [];
    const service: TrackedScreenshotService = {
      async execute() {
        throw new Error("unused");
      },
      generateScreenshotPath() {
        return path;
      },
      async getActivityHash() {
        return "hash";
      },
      startTrackedCapture(_captureOptions, trackerOptions) {
        options.push(trackerOptions ?? {});
        const attempt = attempts++;
        return ScreenshotJobTracker.startJob(
          device.deviceId,
          async (signal) => {
            if (attempt === 0) {
              firstStarted.open();
              return new Promise<ScreenshotResult>((resolve) => {
                signal.addEventListener(
                  "abort",
                  () => resolve({ success: false, error: OPERATION_CANCELLED_MESSAGE }),
                  { once: true },
                );
              });
            }
            return secondResult;
          },
          trackerOptions,
        );
      },
    };
    const store = new FakeScreenshotStateStore(timer);
    return {
      recorder: new DefaultObserveScreenshotRecorder(device, service, store),
      firstStarted,
      options,
      store,
      path,
      get attempts() {
        return attempts;
      },
    };
  }

  test("waits behind an existing job before starting the settled capture", async () => {
    const priorGate = gate();
    const prior = ScreenshotJobTracker.startJob(device.deviceId, async () => {
      await priorGate.promise;
      return { success: true, path: "prior.png" };
    });
    const path = join(directory, "queued.png");
    writeFileSync(path, "fake PNG bytes");
    let started = false;
    const service: TrackedScreenshotService = {
      async execute() {
        throw new Error("unused");
      },
      generateScreenshotPath() {
        return path;
      },
      async getActivityHash() {
        return "hash";
      },
      startTrackedCapture(_captureOptions, trackerOptions) {
        return ScreenshotJobTracker.startJob(
          device.deviceId,
          async () => {
            started = true;
            return { success: true, path };
          },
          trackerOptions,
        );
      },
    };
    const recorder = new DefaultObserveScreenshotRecorder(
      device,
      service,
      new FakeScreenshotStateStore(timer),
    );
    const settled = recorder.captureSettled("queued-observation");
    await Promise.resolve();
    expect(started).toBe(false);
    priorGate.open();
    await prior.promise;
    expect(await settled).toBe(path);
    expect(started).toBe(true);
  });

  test("retries once, queued, after another caller cancels the first capture", async () => {
    const fake = recorderWithCancelledFirstAttempt({
      success: true,
      path: join(directory, "capture.png"),
    });
    const pending = fake.recorder.captureSettled("observation-1");
    await fake.firstStarted.promise;
    await ScreenshotJobTracker.startJob(device.deviceId, async () => ({
      success: true,
      path: "other.png",
    })).promise;
    expect(await pending).toBe(fake.path);
    expect(fake.attempts).toBe(2);
    expect(fake.options).toEqual([
      { queueAfterPending: true, parentSignal: undefined },
      { queueAfterPending: true, parentSignal: undefined },
    ]);
    expect(fake.store.getPathForObservation(device.deviceId, "observation-1")).toBe(fake.path);
  });

  test("reports the retry's validation failure after the first capture is cancelled", async () => {
    const fake = recorderWithCancelledFirstAttempt({ success: false, error: "retry failed" });
    const pending = fake.recorder.captureSettled("observation-2");
    await fake.firstStarted.promise;
    await ScreenshotJobTracker.startJob(device.deviceId, async () => ({
      success: true,
      path: "other.png",
    })).promise;
    await expect(pending).rejects.toThrow(
      "Screenshot capture failed for device settled-test-device: retry failed",
    );
    expect(fake.attempts).toBe(2);
    expect(fake.store.getPathForObservation(device.deviceId, "observation-2")).toBeUndefined();
  });
});
