import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { DefaultRetryExecutor } from "../../../src/utils/retry/RetryExecutor";
import { type BackoffInput, delayForAttempt } from "../../../src/utils/Backoff";
import { FakeTimer } from "../../fakes/FakeTimer";

// Property-based coverage for the retry LOOP invariants (the delay MATH itself is
// covered by test/utils/Backoff.property.test.ts). The existing example tests pin
// specific scenarios; these assert the same contracts hold across the whole
// parameter space: how many times the operation runs, when success vs. exhaustion
// is reported, how `shouldRetry` short-circuits, and the exact cadence + delay
// arguments handed to `onRetry`.
//
// A pinned seed keeps CI deterministic, matching the repo's reproducibility
// conventions. On failure fast-check prints the seed and the shrunk counterexample.
const RUN_OPTIONS = { seed: 0x5e7_3a1, numRuns: 150 } as const;
// The onRetry-cadence property drives the FakeTimer through real sleeps (one
// auto-advance dispatch per retry), so it runs fewer cases to stay well under the
// 100ms-per-test budget while still sweeping the delay-shape space.
const TIMED_RUN_OPTIONS = { seed: 0x5e7_3a1, numRuns: 60 } as const;

// `maxAttempts` across the realistic operating range (RetryExecutor's default is 3).
const maxAttempts = fc.integer({ min: 1, max: 6 });
// The 1-based attempt on which the operation first succeeds. Values above the
// budget mean "never succeeds within maxAttempts", exercising exhaustion.
const succeedAt = fc.integer({ min: 1, max: 8 });

// Build an operation that throws a distinctly-numbered error on each attempt until
// the `succeedAt`-th call, then returns `value`. Defined at module scope so the
// inner async closure never nests inside a property body (max-nested-callbacks: 3).
function makeOperation(
  succeedOnCall: number,
  value: string,
): { op: (attempt: number) => Promise<string>; calls: () => number } {
  let callCount = 0;
  const op = async (): Promise<string> => {
    callCount++;
    if (callCount >= succeedOnCall) {
      return value;
    }
    throw new Error(`fail-${callCount}`);
  };
  return { op, calls: (): number => callCount };
}

// An always-throwing operation, distinctly numbered per attempt.
function makeAlwaysThrow(): { op: (attempt: number) => Promise<never>; calls: () => number } {
  let callCount = 0;
  const op = async (): Promise<never> => {
    callCount++;
    throw new Error(`fail-${callCount}`);
  };
  return { op, calls: (): number => callCount };
}

describe("DefaultRetryExecutor (property-based)", () => {
  test("attempts equals the number of operation invocations, and success iff it succeeds within budget", async () => {
    await fc.assert(
      fc.asyncProperty(maxAttempts, succeedAt, async (max, succeed) => {
        const executor = new DefaultRetryExecutor(new FakeTimer());
        const { op, calls } = makeOperation(succeed, "ok");

        const result = await executor.execute(op, { maxAttempts: max, delays: 0 });

        // The reported attempt count is exactly how many times the op actually ran.
        expect(result.attempts).toBe(calls());
        expect(result.totalTimeMs).toBeGreaterThanOrEqual(0);

        if (succeed <= max) {
          expect(result.success).toBe(true);
          expect(result.value).toBe("ok");
          expect(result.attempts).toBe(succeed);
        } else {
          expect(result.success).toBe(false);
          expect(result.value).toBeUndefined();
          expect(result.attempts).toBe(max);
          // The surfaced error is the one from the final (last) attempt.
          expect(result.error?.message).toBe(`fail-${max}`);
        }
      }),
      RUN_OPTIONS,
    );
  });

  test("onRetry fires once per retry, in order, with the delay delayForAttempt() prescribes", async () => {
    const delayInput: fc.Arbitrary<BackoffInput> = fc.oneof(
      fc.integer({ min: 0, max: 500 }),
      fc.array(fc.integer({ min: 0, max: 500 }), { minLength: 1, maxLength: 6 }),
      fc.func(fc.integer({ min: 0, max: 500 })),
    );

    await fc.assert(
      fc.asyncProperty(maxAttempts, delayInput, async (max, delays) => {
        const timer = new FakeTimer();
        timer.enableAutoAdvance();
        const executor = new DefaultRetryExecutor(timer);
        const { op } = makeAlwaysThrow();
        const retries: Array<{ attempt: number; delay: number }> = [];

        const result = await executor.execute(op, {
          maxAttempts: max,
          delays,
          onRetry: (_error, attempt, delay): void => {
            retries.push({ attempt, delay });
          },
        });

        expect(result.success).toBe(false);
        // Exactly one retry callback per gap between attempts.
        expect(retries.length).toBe(max - 1);
        for (let i = 0; i < retries.length; i++) {
          const attempt = i + 1;
          expect(retries[i].attempt).toBe(attempt);
          // The retry loop and the Backoff policy agree on the delay for each attempt.
          expect(retries[i].delay).toBe(delayForAttempt(delays, attempt));
        }
      }),
      TIMED_RUN_OPTIONS,
    );
  });

  test("a false shouldRetry stops immediately at that attempt", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 6 }),
        fc.integer({ min: 1, max: 5 }),
        async (max, rawStop) => {
          // Stop strictly before the budget is exhausted so shouldRetry is consulted.
          const stopAt = Math.min(rawStop, max - 1);
          const executor = new DefaultRetryExecutor(new FakeTimer());
          const { op, calls } = makeAlwaysThrow();
          const retryAttempts: number[] = [];

          const result = await executor.execute(op, {
            maxAttempts: max,
            delays: 0,
            shouldRetry: (_error, attempt): boolean => attempt !== stopAt,
            onRetry: (_error, attempt): void => {
              retryAttempts.push(attempt);
            },
          });

          expect(result.success).toBe(false);
          expect(result.attempts).toBe(stopAt);
          expect(calls()).toBe(stopAt);
          expect(result.error?.message).toBe(`fail-${stopAt}`);
          // Only the attempts before the stop point were retried.
          expect(retryAttempts).toEqual(Array.from({ length: stopAt - 1 }, (_v, i) => i + 1));
        },
      ),
      RUN_OPTIONS,
    );
  });

  test("executeOrThrow returns the value on success and rethrows the final error on exhaustion", async () => {
    await fc.assert(
      fc.asyncProperty(maxAttempts, succeedAt, async (max, succeed) => {
        const executor = new DefaultRetryExecutor(new FakeTimer());
        const { op } = makeOperation(succeed, "ok");

        if (succeed <= max) {
          const value = await executor.executeOrThrow(op, { maxAttempts: max, delays: 0 });
          expect(value).toBe("ok");
        } else {
          await expect(
            executor.executeOrThrow(op, { maxAttempts: max, delays: 0 }),
          ).rejects.toThrow(`fail-${max}`);
        }
      }),
      RUN_OPTIONS,
    );
  });

  test("an already-aborted signal returns without ever invoking the operation", async () => {
    await fc.assert(
      fc.asyncProperty(maxAttempts, async (max) => {
        const executor = new DefaultRetryExecutor(new FakeTimer());
        const { op, calls } = makeAlwaysThrow();
        const controller = new AbortController();
        controller.abort();

        const result = await executor.execute(op, {
          maxAttempts: max,
          delays: 0,
          signal: controller.signal,
        });

        expect(calls()).toBe(0);
        expect(result.success).toBe(false);
        expect(result.attempts).toBe(1);
        expect(result.error?.message).toBe("Operation aborted");
      }),
      RUN_OPTIONS,
    );
  });
});
