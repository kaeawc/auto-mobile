import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { PlanExecutionResult } from "../../src/models";
import * as planUtils from "../../src/utils/planUtils";
import { PlanExecutionOrchestrator } from "../../src/server/planExecutionOrchestrator";
import { PLAN_HEALTH_DIR_ENV } from "../../src/server/planHealthSummary";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakePlanHealthWriter } from "../fakes/FakePlanHealthWriter";

const base: PlanExecutionResult = {
  success: true,
  executedSteps: 1,
  totalSteps: 1,
  debug: {
    executionTimeMs: 40,
    steps: [{ step: "Execute step 1: observe", status: "completed", durationMs: 40 }],
  },
};
let execute: ReturnType<typeof spyOn<typeof planUtils, "executePlan">>;

beforeEach(() => {
  execute = spyOn(planUtils, "executePlan").mockResolvedValue(base);
});
afterEach(() => execute.mockRestore());

function run(healthWriter: FakePlanHealthWriter | undefined, validYaml = true) {
  return new PlanExecutionOrchestrator(
    {
      device: { platform: "android", deviceId: "fake-device", name: "Fake" },
      request: {
        platform: "android",
        planContent: "name: health\nsteps:\n  - tool: observe\n    params: {}\n",
        startStep: 0,
        deviceAllocationTimeoutMs: 5000,
      },
    },
    {
      timer: new FakeTimer(),
      healthWriter,
      createSchemaValidator: () => ({
        loadSchema: async () => undefined,
        validateYaml: () =>
          validYaml ? { valid: true } : { valid: false, errors: [{ field: "x", message: "bad" }] },
      }),
    },
  ).execute();
}

test("a successful plan attaches and writes a healthSummary without exposing debug", async () => {
  const writer = new FakePlanHealthWriter();
  const result = await run(writer);
  expect(result.healthSummary?.tools).toEqual([
    { tool: "observe", count: 1, failed: 0, skipped: 0, totalMs: 40, maxMs: 40 },
  ]);
  expect(writer.written).toEqual([result.healthSummary!]);
  expect(result).not.toHaveProperty("debug");
});

test("a plan that fails before running still reports a healthSummary", async () => {
  const writer = new FakePlanHealthWriter();
  const result = await run(writer, false);
  expect(result.success).toBe(false);
  expect(result.healthSummary).toMatchObject({ success: false, executedSteps: 0, tools: [] });
  expect(writer.written).toHaveLength(1);
});

test("without a writer the result carries no healthSummary key (opt-in pin)", async () => {
  const saved = process.env[PLAN_HEALTH_DIR_ENV];
  delete process.env[PLAN_HEALTH_DIR_ENV];
  try {
    const result = await run(undefined);
    expect(result).not.toHaveProperty("healthSummary");
    const failed = await run(undefined, false);
    expect(failed).not.toHaveProperty("healthSummary");
  } finally {
    if (saved !== undefined) {
      process.env[PLAN_HEALTH_DIR_ENV] = saved;
    }
  }
});
