import { describe, expect, test } from "bun:test";
import {
  buildPlanHealthSummary,
  reportPlanHealth,
  planHealthWriterFromEnv,
  FilePlanHealthWriter,
  PLAN_HEALTH_DIR_ENV,
} from "../../src/server/planHealthSummary";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakePlanHealthWriter } from "../fakes/FakePlanHealthWriter";

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

describe("reportPlanHealth for a device-labelled plan", () => {
  const runInfoMs = 700;
  const labelled = (failed: boolean) => ({
    success: !failed,
    totalSteps: 3,
    executedSteps: failed ? 1 : 3,
    perDeviceResults: new Map([
      [
        "A",
        {
          device: "A",
          success: true,
          executedSteps: 2,
          totalSteps: 2,
          steps: [
            { step: "Execute step 1: observe", status: "completed" as const, durationMs: 40 },
            { step: "Execute step 2: tapOn", status: "completed" as const, durationMs: 90 },
          ],
        },
      ],
      [
        "B",
        {
          device: "B",
          success: !failed,
          executedSteps: failed ? 0 : 1,
          totalSteps: 1,
          steps: [
            {
              step: "Execute step 3: tapOn",
              status: failed ? ("failed" as const) : ("completed" as const),
              durationMs: 300,
            },
          ],
          ...(failed
            ? { failedStep: { stepIndex: 2, trackIndex: 0, tool: "tapOn", error: "no match" } }
            : {}),
        },
      ],
    ]),
  });

  test("aggregates the tracks of a successful run", async () => {
    const summary = await reportPlanHealth(new FakePlanHealthWriter(), labelled(false), runInfoMs);
    expect(summary?.failedSteps).toBe(0);
    expect(summary?.slowestStep).toEqual({ stepIndex: 2, tool: "tapOn", durationMs: 300 });
    expect(summary?.tools).toEqual([
      { tool: "observe", count: 1, failed: 0, skipped: 0, totalMs: 40, maxMs: 40 },
      { tool: "tapOn", count: 2, failed: 0, skipped: 0, totalMs: 390, maxMs: 300 },
    ]);
  });

  test("counts the failing track's step as failed", async () => {
    const summary = await reportPlanHealth(new FakePlanHealthWriter(), labelled(true), runInfoMs);
    expect(summary?.failedSteps).toBe(1);
    expect(summary?.tools.find((t) => t.tool === "tapOn")?.failed).toBe(1);
  });

  test("a track that failed without a trace still counts one failed step", async () => {
    const result = labelled(true);
    result.perDeviceResults.get("B")!.steps = undefined;
    const summary = await reportPlanHealth(new FakePlanHealthWriter(), result, runInfoMs);
    expect(summary?.failedSteps).toBe(1);
  });
});
