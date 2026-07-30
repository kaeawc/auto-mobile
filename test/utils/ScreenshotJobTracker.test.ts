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

  test("reports isLatest and aborted correctly to each job's completion handler", async () => {
    const completions: Array<{ jobId: string; isLatest: boolean; aborted: boolean }> = [];
    const onComplete = (c: { jobId: string; isLatest: boolean; aborted: boolean }) => {
      completions.push({ jobId: c.jobId, isLatest: c.isLatest, aborted: c.aborted });
    };

    const job1 = ScreenshotJobTracker.startJob(
      "device-a",
      signal => new Promise(resolve => {
        signal.addEventListener("abort", () => {
          resolve({ success: false, error: OPERATION_CANCELLED_MESSAGE });
        }, { once: true });
      }),
      { onComplete }
    );
    // Let job1's runner attach its abort listener before it is superseded.
    await Promise.resolve();

    const job2 = ScreenshotJobTracker.startJob(
      "device-a",
      async () => ({ success: true, path: "latest" }),
      { onComplete }
    );

    await Promise.all([job1.promise, job2.promise]);

    const c1 = completions.find(c => c.jobId === job1.jobId)!;
    const c2 = completions.find(c => c.jobId === job2.jobId)!;
    // The superseded job is no longer latest and was aborted; its result must
    // not be allowed to overwrite the session cache.
    expect(c1.isLatest).toBe(false);
    expect(c1.aborted).toBe(true);
    expect(c2.isLatest).toBe(true);
    expect(c2.aborted).toBe(false);
  });

  test("swallows a throwing completion handler and still resolves the job", async () => {
    const job = ScreenshotJobTracker.startJob(
      "device-b",
      async () => ({ success: true, path: "ok" }),
      {
        onComplete: () => {
          throw new Error("handler boom");
        }
      }
    );

    const result = await job.promise;
    // A throwing onComplete must be logged and swallowed, not turned into a
    // rejected job promise.
    expect(result.success).toBe(true);
    expect(result.path).toBe("ok");
  });

  test("aborts a job whose parent signal is already aborted", async () => {
    const parent = new AbortController();
    parent.abort();

    let runnerSawAbort = false;
    const job = ScreenshotJobTracker.startJob(
      "device-c",
      async signal => {
        runnerSawAbort = signal.aborted;
        return signal.aborted
          ? { success: false, error: OPERATION_CANCELLED_MESSAGE }
          : { success: true };
      },
      { parentSignal: parent.signal }
    );

    const result = await job.promise;
    expect(job.signal.aborted).toBe(true);
    expect(runnerSawAbort).toBe(true);
    expect(result.success).toBe(false);
  });

  test("removes its abort listener from the long-lived parent signal once the job settles", async () => {
    const listeners = new Set<EventListenerOrEventListenerObject>();
    const parentSignal = {
      aborted: false,
      addEventListener: (_type: string, cb: EventListenerOrEventListenerObject) => {
        listeners.add(cb);
      },
      removeEventListener: (_type: string, cb: EventListenerOrEventListenerObject) => {
        listeners.delete(cb);
      }
    } as unknown as AbortSignal;

    const job = ScreenshotJobTracker.startJob(
      "device-d",
      async () => ({ success: true }),
      { parentSignal }
    );
    // While in flight the job holds exactly one abort listener on the parent.
    expect(listeners.size).toBe(1);

    await job.promise;
    await Promise.resolve();

    // Cleanup prevents listener accumulation across every observe poll.
    expect(listeners.size).toBe(0);
  });

  test("getMostRecentPendingDeviceId returns the last-registered device when start times tie", async () => {
    // Both jobs start at fake time 0, so their startedAt values are identical;
    // this exercises the `>=` tie rule (last registration wins).
    const hang = (signal: AbortSignal) => new Promise<{ success: boolean }>(resolve => {
      signal.addEventListener("abort", () => resolve({ success: false }), { once: true });
    });

    ScreenshotJobTracker.startJob("device-1", hang);
    ScreenshotJobTracker.startJob("device-2", hang);

    expect(ScreenshotJobTracker.getMostRecentPendingDeviceId()).toBe("device-2");
  });

  test("clear aborts every pending job, removes their parent-signal listeners, and empties the tracker", async () => {
    const listeners = new Set<EventListenerOrEventListenerObject>();
    const parentSignal = {
      aborted: false,
      addEventListener: (_type: string, cb: EventListenerOrEventListenerObject) => {
        listeners.add(cb);
      },
      removeEventListener: (_type: string, cb: EventListenerOrEventListenerObject) => {
        listeners.delete(cb);
      }
    } as unknown as AbortSignal;

    const hang = (signal: AbortSignal) => new Promise<{ success: boolean; error?: string }>(resolve => {
      signal.addEventListener("abort", () => {
        resolve({ success: false, error: OPERATION_CANCELLED_MESSAGE });
      }, { once: true });
    });

    const jobA = ScreenshotJobTracker.startJob("device-1", hang);
    const jobB = ScreenshotJobTracker.startJob("device-2", hang, { parentSignal });
    // Let both runners attach their abort listeners before clearing.
    await Promise.resolve();

    expect(ScreenshotJobTracker.isPending("device-1")).toBe(true);
    expect(ScreenshotJobTracker.isPending("device-2")).toBe(true);
    // The parent-signal-backed job holds exactly one abort listener while live.
    expect(listeners.size).toBe(1);

    ScreenshotJobTracker.clear();

    // Every in-flight job is aborted synchronously...
    expect(jobA.signal.aborted).toBe(true);
    expect(jobB.signal.aborted).toBe(true);
    // ...the tracker is emptied immediately, before the runners settle...
    expect(ScreenshotJobTracker.isPending("device-1")).toBe(false);
    expect(ScreenshotJobTracker.isPending("device-2")).toBe(false);
    expect(ScreenshotJobTracker.getMostRecentPendingDeviceId()).toBeUndefined();
    // ...and the long-lived parent-signal listener is removed to prevent leaks.
    expect(listeners.size).toBe(0);

    // The aborted runners still resolve with the cancellation result.
    const [rA, rB] = await Promise.all([jobA.promise, jobB.promise]);
    expect(rA.success).toBe(false);
    expect(rA.error).toContain(OPERATION_CANCELLED_MESSAGE);
    expect(rB.success).toBe(false);
    expect(rB.error).toContain(OPERATION_CANCELLED_MESSAGE);
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
