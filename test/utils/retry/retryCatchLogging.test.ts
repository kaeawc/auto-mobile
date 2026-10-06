import { expect, test, spyOn } from "bun:test";
import { logger } from "../../../src/utils/logger";
import { DefaultRetryExecutor } from "../../../src/utils/retry/RetryExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";

for (const scenario of ["aborted attempt", "non-retryable", "aborted delay"] as const) {
  test(`warns once with the caught error for ${scenario} and preserves the failure`, async () => {
    const timer = new FakeTimer();
    const executor = new DefaultRetryExecutor(timer);
    const controller = new AbortController();
    const caught = new Error("attempt failed");
    const reason = new Error("cancelled");
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const pending = executor.execute(
        async () => {
          if (scenario === "aborted attempt") {
            controller.abort(reason);
          }
          throw caught;
        },
        {
          signal: controller.signal,
          shouldRetry: () => scenario !== "non-retryable",
          delays: 25,
        },
      );
      if (scenario === "aborted delay") {
        await Promise.resolve();
        controller.abort(reason);
      }
      expect(await pending).toEqual({
        success: false,
        error: scenario === "non-retryable" ? caught : reason,
        attempts: 1,
        totalTimeMs: 0,
      });
      expect(warning).toHaveBeenCalledTimes(1);
      expect(warning.mock.calls[0]?.[1]).toBe(caught);
    } finally {
      warning.mockRestore();
    }
  });
}

test("recoverable attempts do not emit warnings", async () => {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const warning = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    const result = await new DefaultRetryExecutor(timer).execute(
      async (attempt) => {
        if (attempt < 3) {
          throw new Error("retry");
        }
        return "ok";
      },
      { delays: 10 },
    );
    expect(result).toEqual({ success: true, value: "ok", attempts: 3, totalTimeMs: 20 });
    expect(warning).not.toHaveBeenCalled();
  } finally {
    warning.mockRestore();
  }
});

test("exhaustion warns once after all attempts and preserves the final failure", async () => {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const error = new Error("exhausted");
  const warning = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    const result = await new DefaultRetryExecutor(timer).execute(
      async () => {
        throw error;
      },
      { delays: 10 },
    );
    expect(result).toEqual({ success: false, error, attempts: 3, totalTimeMs: 20 });
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0]?.[1]).toBe(error);
  } finally {
    warning.mockRestore();
  }
});
