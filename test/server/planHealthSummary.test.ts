import { describe, expect, test } from "bun:test";
import {
  buildPlanHealthSummary,
  planHealthWriterFromEnv,
  FilePlanHealthWriter,
  PLAN_HEALTH_DIR_ENV,
} from "../../src/server/planHealthSummary";
import { FakeTimer } from "../fakes/FakeTimer";

const run = { success: false, totalSteps: 4, executedSteps: 3, warningCount: 1, durationMs: 900 };

describe("buildPlanHealthSummary", () => {
  test("aggregates per-tool latency, failures and skips from the step trace", () => {
    const summary = buildPlanHealthSummary(
      [
        { step: "Execute step 1: tapOn", status: "completed", durationMs: 100 },
        { step: "Execute step 2: tapOn", status: "skipped", durationMs: 300 },
        { step: "Execute step 3: observe", status: "completed", durationMs: 50 },
        { step: "Execute step 4: tapOn", status: "failed", durationMs: 200 },
      ],
      run,
    );
    expect(summary.failedSteps).toBe(1);
    expect(summary.skippedSteps).toBe(1);
    expect(summary.slowestStep).toEqual({ stepIndex: 1, tool: "tapOn", durationMs: 300 });
    expect(summary.tools).toEqual([
      { tool: "tapOn", count: 3, failed: 1, skipped: 1, totalMs: 600, maxMs: 300 },
      { tool: "observe", count: 1, failed: 0, skipped: 0, totalMs: 50, maxMs: 50 },
    ]);
    expect(summary.warningCount).toBe(1);
  });

  test("an empty trace yields an empty tool list and no slowest step", () => {
    const summary = buildPlanHealthSummary(undefined, run);
    expect(summary.tools).toEqual([]);
    expect(summary.slowestStep).toBeUndefined();
  });
});

describe("planHealthWriterFromEnv", () => {
  test("is off unless the env var is set", () => {
    expect(planHealthWriterFromEnv(new FakeTimer(), {})).toBeUndefined();
    expect(
      planHealthWriterFromEnv(new FakeTimer(), { [PLAN_HEALTH_DIR_ENV]: "/x" }),
    ).toBeInstanceOf(FilePlanHealthWriter);
  });
});
