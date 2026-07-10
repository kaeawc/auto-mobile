import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { Plan } from "../../src/models/Plan";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { DefaultPlanExecutor } from "../../src/utils/plan/PlanExecutor";
import { logger } from "../../src/utils/logger";

const originalWarn = logger.warn;

interface WarnCall {
  message: string;
  args: unknown[];
}

function registerThrowingTool(name: string): void {
  ToolRegistry.register(
    name,
    "Throws for catch logging tests",
    z.object({}),
    async () => {
      throw new Error(`${name} boom`);
    }
  );
}

afterEach(() => {
  logger.warn = originalWarn;
  ToolRegistry.clearTools();
});

describe("PlanExecutor catch logging", () => {
  test("warns before returning a skipped status from an optional thrown step", async () => {
    const warnCalls: WarnCall[] = [];
    logger.warn = (message: string, ...args: unknown[]) => {
      warnCalls.push({ message, args });
    };
    registerThrowingTool("optionalThrowingTool");
    const executor = new DefaultPlanExecutor();
    const plan: Plan = {
      name: "optional catch logging",
      steps: [{ tool: "optionalThrowingTool", params: {}, optional: true }],
    };

    const result = await executor.executePlan(plan, 0);

    expect(result.success).toBe(true);
    expect(warnCalls).toContainEqual({
      message: "[PLAN_STEP_1] optional step optionalThrowingTool threw; returning skipped status",
      args: [expect.objectContaining({ message: "optionalThrowingTool boom" })],
    });
  });

  test("warns before returning a failed status from a thrown step", async () => {
    const warnCalls: WarnCall[] = [];
    logger.warn = (message: string, ...args: unknown[]) => {
      warnCalls.push({ message, args });
    };
    registerThrowingTool("requiredThrowingTool");
    const executor = new DefaultPlanExecutor();
    const plan: Plan = {
      name: "required catch logging",
      steps: [{ tool: "requiredThrowingTool", params: {} }],
    };

    const result = await executor.executePlan(plan, 0);

    expect(result.success).toBe(false);
    expect(warnCalls).toContainEqual({
      message: "[PLAN_STEP_1] step requiredThrowingTool threw; returning failed status",
      args: [expect.objectContaining({ message: "requiredThrowingTool boom" })],
    });
  });
});
