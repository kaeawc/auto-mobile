import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { ActionableError } from "../../src/models/ActionableError";
import { Plan } from "../../src/models/Plan";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { DefaultPlanExecutor } from "../../src/utils/plan/PlanExecutor";
import { FakeTimer } from "../fakes/FakeTimer";

const toolName = "parallelStartStepAction";
const parallelError = (index: number) =>
  new ActionableError(
    `Start step index ${index} is out of bounds. Parallel plan has 3 steps (plan-wide step index, valid range: 0-2)`,
  );

describe("PlanExecutor parallel startStep", () => {
  let executor: DefaultPlanExecutor;
  let calls: number[];
  let plan: Plan;

  beforeEach(() => {
    executor = new DefaultPlanExecutor(new FakeTimer());
    calls = [];
    ToolRegistry.register(
      toolName,
      "Record a plan-wide step index without device work",
      z.object({ device: z.string(), index: z.number() }),
      async (params) => {
        calls.push(params.index);
        return { success: true };
      },
    );
    plan = {
      name: "parallel-start-step",
      devices: ["A", "B"],
      steps: [
        { tool: toolName, params: { device: "A", index: 0 } },
        { tool: toolName, params: { device: "B", index: 1 } },
        { tool: toolName, params: { device: "B", index: 2 } },
      ],
    };
  });

  afterEach(() => ToolRegistry.unregister(toolName));

  test.each([3, 4])(
    "rejects out-of-range parallel startStep %p before invoking tools",
    async (index) => {
      const result = await executor.executePlan(plan, index);
      expect(calls).toEqual([]);
      expect(result).toMatchObject({
        success: false,
        executedSteps: 0,
        totalSteps: 3,
        failedStep: { stepIndex: -1, tool: "unknown", error: `${parallelError(index)}` },
      });
    },
  );

  test.each([1, 2])("resumes at global index %p even after A's last step", async (index) => {
    const result = await executor.executePlan(plan, index);
    expect(result.success).toBe(true);
    expect(result.executedSteps).toBe(3 - index);
    expect(calls).toEqual(index === 1 ? [1, 2] : [2]);
  });

  // The tool schema defaults an omitted startStep to 0; executePlan requires it.
  test.each([0, -1])("runs all parallel steps with startStep %p", async (index) => {
    const result = await executor.executePlan(plan, index);
    expect(result.success).toBe(true);
    expect(result.executedSteps).toBe(3);
    expect(calls.toSorted()).toEqual([0, 1, 2]);
  });

  test("sequential out-of-range startStep returns the original error", async () => {
    const sequentialPlan: Plan = { name: plan.name, steps: plan.steps };
    const result = await executor.executePlan(sequentialPlan, 3);
    expect(calls).toEqual([]);
    expect(result).toMatchObject({
      success: false,
      executedSteps: 0,
      totalSteps: 3,
      failedStep: {
        stepIndex: -1,
        tool: "unknown",
        error: "Error: Start step index 3 is out of bounds. Plan has 3 steps (valid range: 0-2)",
      },
    });
  });
});
