import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { Plan } from "../../src/models/Plan";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { DefaultPlanExecutor } from "../../src/utils/plan/PlanExecutor";
import { FakeLogger } from "../fakes/FakeLogger";

function registerThrowingTool(name: string): void {
  ToolRegistry.register(name, "Throws for catch logging tests", z.object({}), async () => {
    throw new Error(`${name} boom`);
  });
}

function registerStructuredFailureTool(name: string): void {
  ToolRegistry.register(
    name,
    "Returns a structured failure for plan execution tests",
    z.object({}),
    async () => ({
      isError: true,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            success: false,
            error: {
              code: "device_already_stopped",
              message: "The device is already stopped",
            },
          }),
        },
      ],
    }),
  );
}

afterEach(() => {
  ToolRegistry.clearTools();
});

describe("PlanExecutor catch logging", () => {
  test("warns before returning a skipped status from an optional thrown step", async () => {
    const log = new FakeLogger();
    registerThrowingTool("optionalThrowingTool");
    const executor = new DefaultPlanExecutor(undefined, log);
    const plan: Plan = {
      name: "optional catch logging",
      steps: [{ tool: "optionalThrowingTool", params: {}, optional: true }],
    };

    const result = await executor.executePlan(plan, 0);

    expect(result.success).toBe(true);
    expect(log.at("warn")).toContainEqual(
      expect.objectContaining({
        message: "[PLAN_STEP_1] optional step optionalThrowingTool threw; returning skipped status",
        args: [expect.objectContaining({ message: "optionalThrowingTool boom" })],
      }),
    );
  });

  test("warns before returning a failed status from a thrown step", async () => {
    const log = new FakeLogger();
    registerThrowingTool("requiredThrowingTool");
    const executor = new DefaultPlanExecutor(undefined, log);
    const plan: Plan = {
      name: "required catch logging",
      steps: [{ tool: "requiredThrowingTool", params: {} }],
    };

    const result = await executor.executePlan(plan, 0);

    expect(result.success).toBe(false);
    expect(log.at("warn")).toContainEqual(
      expect.objectContaining({
        message: "[PLAN_STEP_1] step requiredThrowingTool threw; returning failed status",
        args: [expect.objectContaining({ message: "requiredThrowingTool boom" })],
      }),
    );
  });

  test("returns a failed status for a structured failure envelope", async () => {
    registerStructuredFailureTool("structuredFailureTool");
    const executor = new DefaultPlanExecutor(undefined, new FakeLogger());
    const plan: Plan = {
      name: "structured failure",
      steps: [{ tool: "structuredFailureTool", params: {} }],
    };

    const result = await executor.executePlan(plan, 0);

    expect(result.success).toBe(false);
    expect(result.failedStep).toMatchObject({
      stepIndex: 0,
      tool: "structuredFailureTool",
      error: "device_already_stopped: The device is already stopped",
    });
  });
});
