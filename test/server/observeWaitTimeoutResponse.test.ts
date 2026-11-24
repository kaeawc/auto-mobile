import { describe, expect, test } from "bun:test";
import type { ObserveResult } from "../../src/models";
import { createObserveWaitResponse } from "../../src/server/observeResponse";
import type { WaitForObservationOutcome } from "../../src/features/observe/wait/WaitEvaluation";
import { isToolResponseFailure } from "../../src/server/pipeline/afterToolCall";

/** Issue #16889: a timed-out observe waitFor is a failed call, not a success. */

const observation = {
  updatedAt: 0,
  screenSize: { width: 200, height: 200 },
  systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  activeWindow: { appId: "com.example", activityName: ".Main", layoutSeqSum: 0 },
} as ObserveResult;

const outcome = (awaitTimeout: boolean): WaitForObservationOutcome => ({
  observation,
  awaitDuration: 5000,
  awaitTimeout,
  matched: !awaitTimeout,
  timedOut: awaitTimeout,
  ...(awaitTimeout ? { timeoutReason: "no element matched text 'zzz not here'" } : {}),
  polls: 25,
  waitMs: 5000,
});

describe("createObserveWaitResponse", () => {
  test("marks a timed-out wait isError and keeps the wait diagnostics", async () => {
    const response = await createObserveWaitResponse(observation, outcome(true));

    expect(response.isError).toBe(true);
    expect(isToolResponseFailure(response)).toBe(true);
    expect(response.structuredContent).toMatchObject({
      awaitTimeout: true,
      timedOut: true,
      matched: false,
      awaitDuration: 5000,
      timeoutReason: "no element matched text 'zzz not here'",
      activeWindow: { appId: "com.example" },
    });
  });

  test("leaves a matched wait a success", async () => {
    const response = await createObserveWaitResponse(observation, outcome(false));

    expect(response.isError).toBeUndefined();
    expect(isToolResponseFailure(response)).toBe(false);
    expect(response.structuredContent).toMatchObject({ awaitTimeout: false, matched: true });
  });

  /** Issue #19123: a plain `stable` timeout still returns a usable observation. */
  const stableTimeout = (extra: Partial<WaitForObservationOutcome> = {}) => ({
    observation,
    awaitDuration: 3379,
    awaitTimeout: true,
    settled: false,
    timedOut: true,
    polls: 3,
    waitMs: 3379,
    unsettledBy: [{ elementId: "com.example:id/sheet", field: "bounds" }],
    timeoutIsResult: true as const,
    ...extra,
  });

  test("returns a stable timeout as a normal result with unsettledBy", async () => {
    const response = await createObserveWaitResponse(observation, stableTimeout());

    expect(response.isError).toBeUndefined();
    expect(isToolResponseFailure(response)).toBe(false);
    expect(response.structuredContent).toMatchObject({
      awaitTimeout: true,
      settled: false,
      timedOut: true,
      unsettledBy: [{ elementId: "com.example:id/sheet", field: "bounds" }],
    });
    expect(response.structuredContent).not.toHaveProperty("timeoutIsResult");
  });

  test("keeps a stable wait without a usable timeout capture an error", async () => {
    const response = await createObserveWaitResponse(
      observation,
      stableTimeout({ timedOut: false, unsettledBy: undefined, timeoutIsResult: undefined }),
    );

    expect(response.isError).toBe(true);
  });
});
