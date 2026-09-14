import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BootedDevice } from "../../../../src/models";
import { ScreenshotResult } from "../../../../src/models/ScreenshotResult";
import { OPERATION_CANCELLED_MESSAGE } from "../../../../src/utils/constants";
import { NoOpPerformanceTracker } from "../../../../src/utils/PerformanceTracker";
import type {
  ScreenshotJobHandle,
  ScreenshotJobOptions,
} from "../../../../src/utils/ScreenshotJobTracker";
import { ScreenshotJobTracker } from "../../../../src/utils/ScreenshotJobTracker";
import type { ScreenshotOptions } from "../../../../src/features/observe/TakeScreenshot";
import {
  DefaultObserveScreenshotRecorder,
  TrackedScreenshotService,
} from "../../../../src/features/observe/screenshot/ObserveScreenshotRecorder";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeScreenshotStateStore } from "../../../fakes/FakeScreenshotStateStore";

/**
 * Minimal fake `TrackedScreenshotService` that lets each test script the
 * `ScreenshotResult` returned by the capture and choose whether the capture
 * reports as the latest job / aborted.
 *
 * `lastCapturePromise()` lets tests synchronize deterministically with the
 * recorder's async chain. Both the fake's internal `.catch` (registered
 * inside `startTrackedCapture` before it returns) and the recorder's
 * `.finally(endOperation)` (registered immediately after) are reactions on
 * the same underlying capture promise, in that order. When it settles, the
 * fake's `.catch` fires first and resolves `latestPromise`; the recorder's
 * `.finally` fires next (still ahead of the test's resumption) and runs
 * `endOperation` before the test's await wakes up.
 */
class FakeTrackedScreenshotService implements TrackedScreenshotService {
  private nextResult: ScreenshotResult = { success: true, path: "/tmp/default.png" };
  private nextIsLatest: boolean = true;
  private nextAborted: boolean = false;
  private nextThrow: Error | null = null;
  private latestPromise: Promise<ScreenshotResult> | null = null;
  private activeCoalescedHandle: ScreenshotJobHandle | null = null;
  public lastTrackerOptions: ScreenshotJobOptions | null = null;
  public lastCaptureOptions: ScreenshotOptions | undefined;
  public captureCount = 0;

  setNextResult(result: ScreenshotResult): void {
    this.nextResult = result;
  }
  setNextIsLatest(isLatest: boolean): void {
    this.nextIsLatest = isLatest;
  }
  setNextAborted(aborted: boolean): void {
    this.nextAborted = aborted;
  }
  setNextThrow(err: Error): void {
    this.nextThrow = err;
  }

  /**
   * Returns the promise tracked by the most recent `startTrackedCapture` call.
   * Throws if no capture has been started. The promise has the same identity
   * as the one returned to `recorder.start()`, so any `.finally()` handlers
   * attached by the recorder run before the awaiter's continuation.
   */
  lastCapturePromise(): Promise<ScreenshotResult> {
    if (!this.latestPromise) {
      throw new Error("lastCapturePromise() called before startTrackedCapture()");
    }
    return this.latestPromise;
  }

  async execute(_options?: ScreenshotOptions, _signal?: AbortSignal): Promise<ScreenshotResult> {
    return this.nextResult;
  }

  generateScreenshotPath(_timestamp: number, _options: ScreenshotOptions): string {
    return "/tmp/path.png";
  }

  async getActivityHash(_activityHash: string | null): Promise<string> {
    return "hash";
  }

  startTrackedCapture(
    options: ScreenshotOptions = { format: "png" },
    trackerOptions: ScreenshotJobOptions = {},
  ): ScreenshotJobHandle {
    if (trackerOptions.coalesceWithPending && this.activeCoalescedHandle) {
      return this.activeCoalescedHandle;
    }
    this.captureCount++;
    this.lastCaptureOptions = options;
    this.lastTrackerOptions = trackerOptions;
    const abortController = new AbortController();
    const result = this.nextResult;
    const isLatest = this.nextIsLatest;
    const aborted = this.nextAborted;
    const toThrow = this.nextThrow;
    this.nextThrow = null;

    const promise: Promise<ScreenshotResult> = (async () => {
      if (trackerOptions.onComplete) {
        await trackerOptions.onComplete({
          deviceId: "test-device",
          jobId: "job-1",
          result,
          aborted,
          isLatest,
        });
      }
      if (toThrow) {
        throw toThrow;
      }
      return result;
    })();
    // Swallow rejections at the test boundary so awaiting lastCapturePromise()
    // never throws — failure modes are observed via the store, not exceptions.
    this.latestPromise = promise.catch(() => result);
    const handle = {
      jobId: "job-1",
      promise,
      signal: abortController.signal,
    };
    if (trackerOptions.coalesceWithPending) {
      this.activeCoalescedHandle = handle;
      void promise
        .finally(() => {
          this.activeCoalescedHandle = null;
        })
        .catch(() => {
          // The test fake intentionally preserves rejected captures for recorder coverage.
        });
    }
    return handle;
  }
}

function createGate(): { promise: Promise<void>; open: () => void } {
  let open: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

function createQueuedTrackedScreenshotService(results: ScreenshotResult[]) {
  const captureStarts = results.map(() => createGate());
  const captureGates = results.map(() => createGate());
  let captureCount = 0;
  let lastHandle: ScreenshotJobHandle | undefined;
  const service: TrackedScreenshotService = {
    async execute(): Promise<ScreenshotResult> {
      throw new Error("execute() is not used by tracked-capture tests");
    },
    generateScreenshotPath(): string {
      return "/tmp/path.png";
    },
    async getActivityHash(): Promise<string> {
      return "hash";
    },
    startTrackedCapture(_options, trackerOptions) {
      const handle = ScreenshotJobTracker.startJob(
        "test-device",
        async () => {
          const captureIndex = captureCount++;
          captureStarts[captureIndex]!.open();
          await captureGates[captureIndex]!.promise;
          return results[captureIndex]!;
        },
        trackerOptions,
      );
      lastHandle = handle;
      return handle;
    },
  };

  return {
    service,
    captureStarts,
    captureGates,
    get captureCount() {
      return captureCount;
    },
    get lastHandle() {
      return lastHandle;
    },
  };
}

const mockDevice: BootedDevice = {
  name: "test",
  platform: "android",
  deviceId: "test-device",
};

describe("DefaultObserveScreenshotRecorder.capture", () => {
  let store: FakeScreenshotStateStore;
  let svc: FakeTrackedScreenshotService;
  let recorder: DefaultObserveScreenshotRecorder;

  beforeEach(() => {
    ScreenshotJobTracker.clear();
    store = new FakeScreenshotStateStore(new FakeTimer());
    svc = new FakeTrackedScreenshotService();
    recorder = new DefaultObserveScreenshotRecorder(mockDevice, svc, store);
  });

  afterEach(() => {
    ScreenshotJobTracker.clear();
  });

  test("success path writes path to store", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "obs-rec-"));
    const file = path.join(dir, "shot.png");
    writeFileSync(file, "img");
    svc.setNextResult({ success: true, path: file });

    await recorder.capture("observation", new NoOpPerformanceTracker());

    expect(store.getPath("test-device")).toBe(file);
    expect(store.getError("test-device")).toBeUndefined();
  });

  test("requests native screenshot format", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "obs-rec-"));
    const file = path.join(dir, "shot.jpg");
    writeFileSync(file, "img");

    svc.setNextResult({ success: true, path: file, screenshotFormat: "jpeg" });
    await recorder.capture("observation", new NoOpPerformanceTracker());

    expect(svc.lastCaptureOptions).toEqual({});
  });

  test("failure writes error to store", async () => {
    svc.setNextResult({ success: false, error: "capture failed" });

    await recorder.capture("observation", new NoOpPerformanceTracker());

    expect(store.getPath("test-device")).toBeUndefined();
    expect(store.getError("test-device")).toBe("capture failed");
  });

  test("failure without explicit error message uses default", async () => {
    svc.setNextResult({ success: false });

    await recorder.capture("observation", new NoOpPerformanceTracker());

    expect(store.getError("test-device")).toBe("Failed to capture screenshot");
  });

  test("missing file path on success records descriptive error", async () => {
    svc.setNextResult({ success: true });

    await recorder.capture("observation", new NoOpPerformanceTracker());

    expect(store.getError("test-device")).toBe("Screenshot capture returned no file path");
  });

  test("success with path that no longer exists on disk records error", async () => {
    svc.setNextResult({ success: true, path: "/tmp/does-not-exist-xyz-12345.png" });

    await recorder.capture("observation", new NoOpPerformanceTracker());

    expect(store.getError("test-device")).toBe("Screenshot file missing after capture");
    expect(store.getPath("test-device")).toBeUndefined();
    expect(store.getErrorForObservation("test-device", "observation")).toBe(
      "Screenshot file missing after capture",
    );
    expect(store.getPathForObservation("test-device", "observation")).toBeUndefined();
  });

  test("cancelled capture does not write to store", async () => {
    svc.setNextResult({ success: false, error: `${OPERATION_CANCELLED_MESSAGE} mid-capture` });

    await recorder.capture("observation", new NoOpPerformanceTracker());

    expect(store.getUpdateCount()).toBe(0);
  });

  test("aborted completion does not write to store", async () => {
    svc.setNextAborted(true);
    svc.setNextResult({ success: true, path: "/tmp/x.png" });

    await recorder.capture("observation", new NoOpPerformanceTracker());

    expect(store.getUpdateCount()).toBe(0);
    expect(store.getPathForObservation("test-device", "observation")).toBeUndefined();
    expect(store.getErrorForObservation("test-device", "observation")).toBe("capture cancelled");
    expect(store.isObservationPending("test-device", "observation")).toBe(false);
  });

  test("non-latest completion does not write to store", async () => {
    svc.setNextIsLatest(false);
    svc.setNextResult({ success: true, path: "/tmp/x.png" });

    await recorder.capture("observation", new NoOpPerformanceTracker());

    expect(store.getUpdateCount()).toBe(0);
    expect(store.getPathForObservation("test-device", "observation")).toBeUndefined();
    expect(store.getErrorForObservation("test-device", "observation")).toBe("capture superseded");
    expect(store.isObservationPending("test-device", "observation")).toBe(false);
  });

  test("late cancellation does not replace a path already recorded for the observation", async () => {
    store.updateForObservation("test-device", "observation", "/tmp/already-recorded.png");
    svc.setNextAborted(true);
    svc.setNextResult({ success: true, path: "/tmp/stale.png" });

    await recorder.capture("observation", new NoOpPerformanceTracker());

    expect(store.getPathForObservation("test-device", "observation")).toBe(
      "/tmp/already-recorded.png",
    );
    expect(store.getErrorForObservation("test-device", "observation")).toBeUndefined();
  });

  test("thrown error from capture writes to store", async () => {
    svc.setNextThrow(new Error("network down"));
    svc.setNextResult({ success: true, path: "/tmp/skip.png" });
    svc.setNextIsLatest(false); // avoid the onComplete success path also writing

    await recorder.capture("observation", new NoOpPerformanceTracker());

    expect(store.getError("test-device")).toBe("network down");
  });

  test("capture() coalesces ordinary work so a fresh capture is not cancelled", async () => {
    svc.setNextResult({ success: false, error: OPERATION_CANCELLED_MESSAGE });

    await recorder.capture("observation", new NoOpPerformanceTracker());

    expect(svc.lastTrackerOptions?.coalesceWithPending).toBe(true);
  });

  test("captureFresh() queues terminal evidence after pending work", async () => {
    svc.setNextResult({ success: false, error: OPERATION_CANCELLED_MESSAGE });

    await recorder.captureFresh("observation", new NoOpPerformanceTracker());

    expect(svc.lastTrackerOptions?.queueAfterPending).toBe(true);
    expect(svc.lastTrackerOptions?.coalesceWithPending).toBeUndefined();
  });

  test("queues an overlapping observation behind a running capture", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "obs-rec-"));
    const firstFile = path.join(dir, "first.png");
    const secondFile = path.join(dir, "second.png");
    writeFileSync(firstFile, "first");
    writeFileSync(secondFile, "second");
    const queued = createQueuedTrackedScreenshotService([
      { success: true, path: firstFile },
      { success: true, path: secondFile },
    ]);
    const queuedRecorder = new DefaultObserveScreenshotRecorder(mockDevice, queued.service, store);

    const first = queuedRecorder.capture("observation-first", new NoOpPerformanceTracker());
    await queued.captureStarts[0]!.promise;
    const second = queuedRecorder.capture("observation-second", new NoOpPerformanceTracker());
    await Promise.resolve();

    expect(queued.captureCount).toBe(1);
    queued.captureGates[1]!.open();
    queued.captureGates[0]!.open();
    await Promise.all([first, second]);

    expect(queued.captureCount).toBe(2);
    expect(store.getPathForObservation("test-device", "observation-first")).toBe(firstFile);
    expect(store.getPathForObservation("test-device", "observation-second")).toBe(secondFile);
  });

  test("shared aborted captures do not record a path in a second recorder", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "obs-rec-"));
    const file = path.join(dir, "aborted.png");
    writeFileSync(file, "img");
    const shared = createQueuedTrackedScreenshotService([{ success: true, path: file }]);
    const firstRecorder = new DefaultObserveScreenshotRecorder(mockDevice, shared.service, store);
    const secondRecorder = new DefaultObserveScreenshotRecorder(mockDevice, shared.service, store);
    const abortController = new AbortController();

    const first = firstRecorder.capture(
      "observation-first",
      new NoOpPerformanceTracker(),
      abortController.signal,
    );
    const second = secondRecorder.capture("observation-second", new NoOpPerformanceTracker());
    await shared.captureStarts[0]!.promise;
    abortController.abort();
    shared.captureGates[0]!.open();
    await Promise.all([first, second]);

    expect(shared.captureCount).toBe(1);
    expect(store.getPathForObservation("test-device", "observation-first")).toBeUndefined();
    expect(store.getPathForObservation("test-device", "observation-second")).toBeUndefined();
  });
});

describe("DefaultObserveScreenshotRecorder.start", () => {
  let store: FakeScreenshotStateStore;
  let svc: FakeTrackedScreenshotService;
  let recorder: DefaultObserveScreenshotRecorder;

  beforeEach(() => {
    ScreenshotJobTracker.clear();
    store = new FakeScreenshotStateStore(new FakeTimer());
    svc = new FakeTrackedScreenshotService();
    recorder = new DefaultObserveScreenshotRecorder(mockDevice, svc, store);
  });

  afterEach(() => {
    ScreenshotJobTracker.clear();
  });

  test("start() returns synchronously and eventually writes state", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "obs-rec-"));
    const file = path.join(dir, "shot.png");
    writeFileSync(file, "img");
    svc.setNextResult({ success: true, path: file });

    const returnValue = recorder.start("observation", new NoOpPerformanceTracker());

    expect(returnValue).toBeUndefined();
    expect(store.getUpdateCount()).toBe(0); // nothing yet — runs async

    await svc.lastCapturePromise();

    expect(store.getPath("test-device")).toBe(file);
  });

  test("start() registers its observation before returning", () => {
    svc.setNextResult({ success: false, error: "still pending" });

    recorder.start("observation-pending", new NoOpPerformanceTracker());

    expect(store.hasPendingObservation("test-device", "observation-pending")).toBe(true);
  });

  test("awaitable capture methods register their observations before awaiting", async () => {
    svc.setNextResult({ success: false, error: "still pending" });

    const capture = recorder.capture("capture-observation", new NoOpPerformanceTracker());
    expect(store.hasPendingObservation("test-device", "capture-observation")).toBe(true);
    await capture;

    const freshCapture = recorder.captureFresh("fresh-observation", new NoOpPerformanceTracker());
    expect(store.hasPendingObservation("test-device", "fresh-observation")).toBe(true);
    await freshCapture;
  });

  test("start() with non-latest completion does not write state", async () => {
    svc.setNextIsLatest(false);
    svc.setNextResult({ success: true, path: "/tmp/x.png" });

    recorder.start("observation", new NoOpPerformanceTracker());

    await svc.lastCapturePromise();

    expect(store.getUpdateCount()).toBe(0);
    expect(store.getErrorForObservation("test-device", "observation")).toBe("capture superseded");
    expect(store.isObservationPending("test-device", "observation")).toBe(false);
  });

  test("start() with aborted completion does not write state", async () => {
    svc.setNextAborted(true);
    svc.setNextResult({ success: true, path: "/tmp/x.png" });

    recorder.start("observation", new NoOpPerformanceTracker());

    await svc.lastCapturePromise();

    expect(store.getUpdateCount()).toBe(0);
    expect(store.getErrorForObservation("test-device", "observation")).toBe("capture cancelled");
    expect(store.isObservationPending("test-device", "observation")).toBe(false);
  });

  test("start() with failed capture writes error", async () => {
    svc.setNextResult({ success: false, error: "boom" });

    recorder.start("observation", new NoOpPerformanceTracker());

    await svc.lastCapturePromise();

    expect(store.getError("test-device")).toBe("boom");
  });

  test("start() requests coalesceWithPending so rapid polling does not cancel in-flight captures", async () => {
    svc.setNextResult({ success: true, path: "/tmp/skip.png" });
    svc.setNextIsLatest(false);

    recorder.start("observation", new NoOpPerformanceTracker());
    await svc.lastCapturePromise();

    expect(svc.lastTrackerOptions?.coalesceWithPending).toBe(true);
  });

  test("queues an overlapping observation behind a running capture", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "obs-rec-"));
    const firstFile = path.join(dir, "first.png");
    const secondFile = path.join(dir, "second.png");
    writeFileSync(firstFile, "first");
    writeFileSync(secondFile, "second");
    const queued = createQueuedTrackedScreenshotService([
      { success: true, path: firstFile },
      { success: true, path: secondFile },
    ]);
    const queuedStore = new FakeScreenshotStateStore(new FakeTimer());
    const queuedRecorder = new DefaultObserveScreenshotRecorder(
      mockDevice,
      queued.service,
      queuedStore,
    );

    queuedRecorder.start("observation-first", new NoOpPerformanceTracker());
    await queued.captureStarts[0]!.promise;
    queuedRecorder.start("observation-second", new NoOpPerformanceTracker());
    await Promise.resolve();

    expect(queued.captureCount).toBe(1);
    const firstSettled = queuedStore.waitForObservation("test-device", "observation-first", 10);
    const secondSettled = queuedStore.waitForObservation("test-device", "observation-second", 10);
    queued.captureGates[0]!.open();
    await queued.captureStarts[1]!.promise;
    queued.captureGates[1]!.open();
    await Promise.all([firstSettled, secondSettled]);

    expect(queued.captureCount).toBe(2);
    expect(queuedStore.getPathForObservation("test-device", "observation-first")).toBe(firstFile);
    expect(queuedStore.getPathForObservation("test-device", "observation-second")).toBe(secondFile);
  });

  test("start() tracks performance via startOperation/endOperation", async () => {
    const calls: string[] = [];
    const fakeTracker = {
      serial: () => fakeTracker,
      parallel: () => fakeTracker,
      track: async <T>(_n: string, fn: () => Promise<T>) => fn(),
      trackSync: <T>(_n: string, fn: () => T) => fn(),
      end: () => fakeTracker,
      getTimings: () => null,
      isEnabled: () => true,
      addExternalTiming: () => {},
      startOperation: (name: string) => {
        calls.push(`start:${name}`);
      },
      endOperation: (name: string) => {
        calls.push(`end:${name}`);
      },
    };

    svc.setNextResult({ success: true, path: "/tmp/no-exist.png" });
    recorder.start("observation", fakeTracker);

    await svc.lastCapturePromise();

    expect(calls).toContain("start:screenshot");
    expect(calls).toContain("end:screenshot");
  });
});
