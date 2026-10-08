import { expect, test, spyOn } from "bun:test";
import { logger } from "../../../src/utils/logger";
import { DefaultRetryExecutor } from "../../../src/utils/retry/RetryExecutor";
import { FakeTimer } from "../../fakes/FakeTimer";

for (const scenario of ["aborted attempt", "non-retryable", "aborted delay"] as const) {
  test(`logs once with the caught error for ${scenario} and preserves the failure`, async () => {
    const timer = new FakeTimer();
    const executor = new DefaultRetryExecutor(timer);
    const controller = new AbortController();
    const caught = new Error("attempt failed");
    const reason = new Error("cancelled");
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    const debug = spyOn(logger, "debug").mockImplementation(() => {});
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
      const terminalLog = scenario === "non-retryable" ? warning : debug;
      expect(terminalLog).toHaveBeenCalledTimes(1);
      expect(terminalLog.mock.calls[0]?.[1]).toBe(caught);
      expect(scenario === "non-retryable" ? debug : warning).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
      debug.mockRestore();
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

for (const exit of ["non-retryable", "exhausted"] as const) {
  for (const matches of [true, false]) {
    test(`${exit} logs at ${matches ? "debug" : "warn"} when the expected outcome predicate is ${matches}`, async () => {
      const timer = new FakeTimer();
      timer.enableAutoAdvance();
      const error = new Error("probe failed");
      const warning = spyOn(logger, "warn").mockImplementation(() => {});
      const debug = spyOn(logger, "debug").mockImplementation(() => {});
      try {
        const result = await new DefaultRetryExecutor(timer).execute(
          async () => {
            throw error;
          },
          {
            maxAttempts: 2,
            delays: 10,
            shouldRetry: () => exit !== "non-retryable",
            expectedFailure: {
              reason: "The caller handles an unavailable optional probe",
              matches: (caught) => {
                expect(caught).toBe(error);
                return matches;
              },
            },
          },
        );
        expect(result).toEqual({
          success: false,
          error,
          attempts: exit === "non-retryable" ? 1 : 2,
          totalTimeMs: exit === "non-retryable" ? 0 : 10,
        });
        const terminalLog = matches ? debug : warning;
        expect(terminalLog).toHaveBeenCalledTimes(1);
        expect(terminalLog.mock.calls[0]?.[1]).toBe(error);
        if (matches) {
          expect(terminalLog.mock.calls[0]?.[0]).toContain(
            "The caller handles an unavailable optional probe",
          );
        }
        expect(matches ? warning : debug).not.toHaveBeenCalled();
      } finally {
        warning.mockRestore();
        debug.mockRestore();
      }
    });
  }
}

test("expected exhaustion needs only a reason, and executeOrThrow preserves the error", async () => {
  const error = new Error("optional probe unavailable");
  const warning = spyOn(logger, "warn").mockImplementation(() => {});
  const debug = spyOn(logger, "debug").mockImplementation(() => {});
  try {
    await expect(
      new DefaultRetryExecutor(new FakeTimer()).executeOrThrow(
        async () => {
          throw error;
        },
        { maxAttempts: 1, expectedFailure: { reason: "An unavailable probe is expected" } },
      ),
    ).rejects.toBe(error);
    expect(warning).not.toHaveBeenCalled();
    // Count only this executor's logs: unrelated background work (such as the
    // logger's startup log-prune sweep) may log at debug while this test runs.
    const retryDebug = debug.mock.calls.filter((call) => call[1] === error);
    expect(retryDebug).toHaveLength(1);
    expect(retryDebug[0]?.[0]).toContain("An unavailable probe is expected");
  } finally {
    warning.mockRestore();
    debug.mockRestore();
  }
});
