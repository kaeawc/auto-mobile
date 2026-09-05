import { describe, it, expect, beforeEach } from "bun:test";
import { DefaultRetryExecutor } from "../../../src/utils/retry/RetryExecutor";
import { exponentialBackoff } from "../../../src/utils/Backoff";
import { FakeTimer } from "../../fakes/FakeTimer";

describe("DefaultRetryExecutor", () => {
  let executor: DefaultRetryExecutor;
  let timer: FakeTimer;

  beforeEach(() => {
    timer = new FakeTimer();
    executor = new DefaultRetryExecutor(timer);
  });

  describe("execute", () => {
    it("succeeds on first attempt when operation succeeds", async () => {
      timer.enableAutoAdvance();
      const result = await executor.execute(async () => "success");

      expect(result.success).toBe(true);
      expect(result.value).toBe("success");
      expect(result.attempts).toBe(1);
    });

    it("retries on failure and eventually succeeds", async () => {
      timer.enableAutoAdvance();
      let attempts = 0;

      const result = await executor.execute(async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error("Not yet");
        }
        return "success";
      });

      expect(result.success).toBe(true);
      expect(result.value).toBe("success");
      expect(result.attempts).toBe(3);
    });

    it("fails after max attempts", async () => {
      timer.enableAutoAdvance();
      const result = await executor.execute(
        async () => {
          throw new Error("Always fails");
        },
        { maxAttempts: 3 },
      );

      expect(result.success).toBe(false);
      expect(result.error?.message).toBe("Always fails");
      expect(result.attempts).toBe(3);
    });

    it("respects fixed delay between retries", async () => {
      let attempts = 0;

      const resultPromise = executor.execute(
        async () => {
          attempts++;
          if (attempts < 2) {
            throw new Error("Retry");
          }
          return "done";
        },
        { delays: 500, maxAttempts: 3 },
      );

      // Wait for first attempt
      await Promise.resolve();
      expect(attempts).toBe(1);
      expect(timer.getPendingSleepCount()).toBe(1);

      // Advance time to trigger retry
      timer.advanceTime(500);
      await Promise.resolve();

      const result = await resultPromise;
      expect(result.success).toBe(true);
      expect(result.attempts).toBe(2);
      expect(timer.wasSleepCalled(500)).toBe(true);
    });

    it("respects array-based delays (exponential backoff)", async () => {
      timer.enableAutoAdvance();
      let attempts = 0;
      const delays = [50, 100, 200];

      const result = await executor.execute(
        async () => {
          attempts++;
          if (attempts < 4) {
            throw new Error("Retry");
          }
          return "done";
        },
        { delays, maxAttempts: 4 },
      );

      expect(result.success).toBe(true);
      expect(result.attempts).toBe(4);
      expect(timer.wasSleepCalled(50)).toBe(true);
      expect(timer.wasSleepCalled(100)).toBe(true);
      expect(timer.wasSleepCalled(200)).toBe(true);
    });

    it("respects function-based delays", async () => {
      timer.enableAutoAdvance();
      let attempts = 0;

      const result = await executor.execute(
        async () => {
          attempts++;
          if (attempts < 3) {
            throw new Error("Retry");
          }
          return "done";
        },
        {
          delays: (attempt) => attempt * 100,
          maxAttempts: 3,
        },
      );

      expect(result.success).toBe(true);
      expect(timer.wasSleepCalled(100)).toBe(true); // First retry: attempt 1 * 100
      expect(timer.wasSleepCalled(200)).toBe(true); // Second retry: attempt 2 * 100
    });

    it("respects BackoffPolicy delays", async () => {
      timer.enableAutoAdvance();
      let attempts = 0;

      const result = await executor.execute(
        async () => {
          attempts++;
          if (attempts < 4) {
            throw new Error("Retry");
          }
          return "done";
        },
        {
          delays: exponentialBackoff({ initialDelayMs: 50, multiplier: 2, maxDelayMs: 200 }),
          maxAttempts: 4,
        },
      );

      expect(result.success).toBe(true);
      expect(timer.wasSleepCalled(50)).toBe(true);
      expect(timer.wasSleepCalled(100)).toBe(true);
      expect(timer.wasSleepCalled(200)).toBe(true);
    });

    it("aborts when signal is aborted", async () => {
      const controller = new AbortController();
      let attempts = 0;

      const resultPromise = executor.execute(
        async () => {
          attempts++;
          throw new Error("Retry");
        },
        { signal: controller.signal, delays: 100, maxAttempts: 5 },
      );

      await Promise.resolve();
      expect(attempts).toBe(1);

      // Abort before retry
      controller.abort();
      timer.advanceTime(100);

      const result = await resultPromise;
      expect(result.success).toBe(false);
      expect(result.error?.message).toBe("Operation aborted");
      expect(attempts).toBe(1);
    });

    it("removes its abort listener after every retry sleep on a shared signal", async () => {
      // #6138: the sleep/abort race registered a { once: true } listener that was
      // only removed when the signal aborted. A long-lived signal shared across
      // executions accumulated one listener per retry.
      timer.enableAutoAdvance();
      const controller = new AbortController();
      const signal = controller.signal;
      let added = 0;
      let removed = 0;
      const originalAdd = signal.addEventListener.bind(signal);
      const originalRemove = signal.removeEventListener.bind(signal);
      signal.addEventListener = ((...args: Parameters<AbortSignal["addEventListener"]>) => {
        added++;
        return originalAdd(...args);
      }) as AbortSignal["addEventListener"];
      signal.removeEventListener = ((...args: Parameters<AbortSignal["removeEventListener"]>) => {
        removed++;
        return originalRemove(...args);
      }) as AbortSignal["removeEventListener"];

      const executions = 20;
      const maxAttempts = 3;
      for (let i = 0; i < executions; i++) {
        const result = await executor.execute(
          async () => {
            throw new Error("Retry");
          },
          { signal, delays: 10, maxAttempts },
        );
        expect(result.success).toBe(false);
        expect(result.attempts).toBe(maxAttempts);
      }

      expect(added).toBe(executions * (maxAttempts - 1));
      expect(removed).toBe(added);
    });

    it("removes the abort listener when abort wins the race mid-sleep", async () => {
      // Manual FakeTimer: the sleep never resolves, so the only way execute()
      // settles is via the abort listener. This pins that `finally` runs after
      // the race settles (a `return Promise.race` without `await` would remove
      // the listener before it could fire and hang here).
      const controller = new AbortController();
      const signal = controller.signal;
      let removed = 0;
      const originalRemove = signal.removeEventListener.bind(signal);
      signal.removeEventListener = ((...args: Parameters<AbortSignal["removeEventListener"]>) => {
        removed++;
        return originalRemove(...args);
      }) as AbortSignal["removeEventListener"];

      const resultPromise = executor.execute(
        async () => {
          throw new Error("Retry");
        },
        { signal, delays: 100, maxAttempts: 3 },
      );

      await Promise.resolve();
      expect(timer.getPendingSleepCount()).toBe(1);

      controller.abort();
      const result = await resultPromise;

      expect(result.success).toBe(false);
      expect(result.error?.message).toBe("Operation aborted");
      expect(result.attempts).toBe(1);
      expect(removed).toBe(1);
      // The losing sleep stays registered on the fake timer; it is bounded
      // (one per abort) and pre-existing behavior.
      expect(timer.getPendingSleepCount()).toBe(1);
    });

    it("settles when the injected sleep aborts the signal synchronously", async () => {
      // timer.sleep() is evaluated before the abort-promise executor runs, so a
      // Timer that aborts synchronously must be caught by the recheck inside the
      // executor; otherwise the listener registers after the event already fired
      // and execute() never settles.
      const controller = new AbortController();
      class SyncAbortingTimer extends FakeTimer {
        override sleep(ms: number): Promise<void> {
          controller.abort();
          return super.sleep(ms);
        }
      }
      const abortingExecutor = new DefaultRetryExecutor(new SyncAbortingTimer());
      let attempts = 0;

      const result = await abortingExecutor.execute(
        async () => {
          attempts++;
          throw new Error("Retry");
        },
        { signal: controller.signal, delays: 100, maxAttempts: 3 },
      );

      expect(result.success).toBe(false);
      expect(result.error?.message).toBe("Operation aborted");
      expect(attempts).toBe(1);
    });

    it("respects shouldRetry predicate", async () => {
      timer.enableAutoAdvance();

      const result = await executor.execute(
        async () => {
          throw new Error("Fatal error");
        },
        {
          maxAttempts: 5,
          shouldRetry: (error) => !error.message.includes("Fatal"),
        },
      );

      expect(result.success).toBe(false);
      expect(result.attempts).toBe(1); // Should not retry
    });

    it("calls onRetry callback before each retry", async () => {
      timer.enableAutoAdvance();
      const retryInfo: Array<{ error: Error; attempt: number; delay: number }> = [];

      const result = await executor.execute(
        async () => {
          throw new Error("Test error");
        },
        {
          maxAttempts: 3,
          delays: 500,
          onRetry: (error, attempt, delay) => {
            retryInfo.push({ error, attempt, delay });
          },
        },
      );

      expect(result.success).toBe(false);
      expect(retryInfo.length).toBe(2); // 2 retries after initial attempt
      expect(retryInfo[0].attempt).toBe(1);
      expect(retryInfo[0].delay).toBe(500);
      expect(retryInfo[1].attempt).toBe(2);
    });

    it("tracks total time in result", async () => {
      timer.enableAutoAdvance();
      timer.setCurrentTime(1000);

      const result = await executor.execute(async () => "done", { maxAttempts: 1 });

      expect(result.totalTimeMs).toBeGreaterThanOrEqual(0);
    });

    it("reports the exact elapsed time measured by the injected timer", async () => {
      // autoAdvance moves the fake clock to each sleep's due time deterministically,
      // so the single 250ms retry delay makes totalTimeMs exactly 250.
      timer.enableAutoAdvance();
      let attempts = 0;

      const result = await executor.execute(
        async () => {
          attempts++;
          if (attempts < 2) {
            throw new Error("retry me");
          }
          return "ok";
        },
        { maxAttempts: 2, delays: 250 },
      );

      expect(result.success).toBe(true);
      expect(result.attempts).toBe(2);
      expect(result.totalTimeMs).toBe(250);
    });
  });

  describe("executeOrThrow", () => {
    it("returns value on success", async () => {
      timer.enableAutoAdvance();
      const value = await executor.executeOrThrow(async () => "success");
      expect(value).toBe("success");
    });

    it("throws on failure", async () => {
      timer.enableAutoAdvance();

      await expect(
        executor.executeOrThrow(
          async () => {
            throw new Error("Failed");
          },
          { maxAttempts: 2 },
        ),
      ).rejects.toThrow("Failed");
    });
  });
});
