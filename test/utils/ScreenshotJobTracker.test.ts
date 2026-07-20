import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ScreenshotJobTracker } from "../../src/utils/ScreenshotJobTracker";
import { OPERATION_CANCELLED_MESSAGE } from "../../src/utils/constants";
import { FakeTimer } from "../fakes/FakeTimer";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";

describe("ScreenshotJobTracker", () => {
  let fakeTimer: FakeTimer;

  beforeEach(() => {
    fakeTimer = new FakeTimer();
    ScreenshotJobTracker.setTimer(fakeTimer);
    ScreenshotJobTracker.setIdGenerator(new CountingIdGenerator("job"));
  });

  afterEach(() => {
    ScreenshotJobTracker.clear();
    ScreenshotJobTracker.resetTimer();
    ScreenshotJobTracker.resetIdGenerator();
  });

  test("cancels the previous job for the same device", async () => {
    const job1 = ScreenshotJobTracker.startJob("device-1", signal => {
      return new Promise(resolve => {
        if (signal.aborted) {
          resolve({ success: false, error: OPERATION_CANCELLED_MESSAGE });
          return;
        }
        const timeoutId = fakeTimer.setTimeout(() => {
          resolve({ success: true, path: "job1" });
        }, 50);

        signal.addEventListener("abort", () => {
          fakeTimer.clearTimeout(timeoutId);
          resolve({ success: false, error: OPERATION_CANCELLED_MESSAGE });
        }, { once: true });
      });
    });

    const job2 = ScreenshotJobTracker.startJob("device-1", async () => {
      return { success: true, path: "job2" };
    });

    const result1 = await job1.promise;
    const result2 = await job2.promise;

    expect(result1.success).toBe(false);
    expect(result1.error).toContain(OPERATION_CANCELLED_MESSAGE);
    expect(result2.success).toBe(true);
    expect(result2.path).toBe("job2");
  });

  test("uses the injected ID generator when jobs start in the same tick", async () => {
    const first = ScreenshotJobTracker.startJob("device-id-1", async () => ({ success: true }));
    const second = ScreenshotJobTracker.startJob("device-id-2", async () => ({ success: true }));

    expect(first.jobId).toBe("screenshot_0_job-1");
    expect(second.jobId).toBe("screenshot_0_job-2");
    await Promise.all([first.promise, second.promise]);
  });

  test("waitForCompletion resolves with result when job completes", async () => {
    ScreenshotJobTracker.startJob("device-2", async signal => {
      return new Promise(resolve => {
        const timeoutId = fakeTimer.setTimeout(() => {
          resolve({ success: true, path: "done" });
        }, 50);

        signal.addEventListener("abort", () => {
          fakeTimer.clearTimeout(timeoutId);
          resolve({ success: false, error: OPERATION_CANCELLED_MESSAGE });
        }, { once: true });
      });
    });

    const waitPromise = ScreenshotJobTracker.waitForCompletion("device-2", 200);
    await Promise.resolve();
    fakeTimer.advanceTime(100);
    await Promise.resolve();
    const result = await waitPromise;
    expect(result?.success).toBe(true);
    expect(result?.path).toBe("done");
  });

  test("coalesceWithPending reuses an in-flight job instead of cancelling it", async () => {
    let runnerInvocations = 0;
    const startCoalescedJob = () => ScreenshotJobTracker.startJob(
      "device-3",
      signal => {
        runnerInvocations += 1;
        return new Promise(resolve => {
          const timeoutId = fakeTimer.setTimeout(() => {
            resolve({ success: true, path: "shared" });
          }, 200);

          signal.addEventListener("abort", () => {
            fakeTimer.clearTimeout(timeoutId);
            resolve({ success: false, error: OPERATION_CANCELLED_MESSAGE });
          }, { once: true });
        });
      },
      { coalesceWithPending: true }
    );

    const job1 = startCoalescedJob();
    const job2 = startCoalescedJob();
    const job3 = startCoalescedJob();

    expect(job2.jobId).toBe(job1.jobId);
    expect(job3.jobId).toBe(job1.jobId);

    // Flush microtasks so the runner attaches its setTimeout before we advance time.
    await Promise.resolve();
    expect(runnerInvocations).toBe(1);

    fakeTimer.advanceTime(200);
    const [r1, r2, r3] = await Promise.all([job1.promise, job2.promise, job3.promise]);
    expect(r1.success).toBe(true);
    expect(r1.path).toBe("shared");
    expect(r2).toBe(r1);
    expect(r3).toBe(r1);
  });

  test("coalesceWithPending starts fresh when previous job has been aborted", async () => {
    const job1 = ScreenshotJobTracker.startJob("device-4", signal => {
      return new Promise(resolve => {
        signal.addEventListener("abort", () => {
          resolve({ success: false, error: OPERATION_CANCELLED_MESSAGE });
        }, { once: true });
      });
    });
    await Promise.resolve();

    ScreenshotJobTracker.cancelJob("device-4");
    await job1.promise;

    let secondRunnerCalled = false;
    const job2 = ScreenshotJobTracker.startJob(
      "device-4",
      async () => {
        secondRunnerCalled = true;
        return { success: true, path: "fresh" };
      },
      { coalesceWithPending: true }
    );

    expect(job2.jobId).not.toBe(job1.jobId);
    const r2 = await job2.promise;
    expect(secondRunnerCalled).toBe(true);
    expect(r2.success).toBe(true);
    expect(r2.path).toBe("fresh");
  });

  test("without coalesceWithPending, startJob still cancels the previous job", async () => {
    let secondRunnerCalled = false;
    const job1 = ScreenshotJobTracker.startJob("device-5", signal => {
      return new Promise(resolve => {
        signal.addEventListener("abort", () => {
          resolve({ success: false, error: OPERATION_CANCELLED_MESSAGE });
        }, { once: true });
      });
    });
    await Promise.resolve();

    const job2 = ScreenshotJobTracker.startJob("device-5", async () => {
      secondRunnerCalled = true;
      return { success: true, path: "replacement" };
    });

    const [r1, r2] = await Promise.all([job1.promise, job2.promise]);
    expect(secondRunnerCalled).toBe(true);
    expect(r1.success).toBe(false);
    expect(r1.error).toContain(OPERATION_CANCELLED_MESSAGE);
    expect(r2.success).toBe(true);
    expect(r2.path).toBe("replacement");
    expect(job2.jobId).not.toBe(job1.jobId);
  });

  test("waitForCompletion returns null when the job times out", async () => {
    ScreenshotJobTracker.startJob("device-2", async signal => {
      return new Promise(resolve => {
        const timeoutId = fakeTimer.setTimeout(() => {
          resolve({ success: true, path: "late" });
        }, 200);

        signal.addEventListener("abort", () => {
          fakeTimer.clearTimeout(timeoutId);
          resolve({ success: false, error: OPERATION_CANCELLED_MESSAGE });
        }, { once: true });
      });
    });

    const waitPromise = ScreenshotJobTracker.waitForCompletion("device-2", 50);
    await Promise.resolve();
    fakeTimer.advanceTime(50);
    await Promise.resolve();
    const result = await waitPromise;
    expect(result).toBeNull();
  });
});
