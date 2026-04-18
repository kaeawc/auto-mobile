import { describe, expect, test, beforeEach } from "bun:test";
import { DefaultPlanExecutor } from "../../src/utils/plan/PlanExecutor";
import { Plan } from "../../src/models/Plan";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { z } from "zod";
import { OPERATION_CANCELLED_MESSAGE } from "../../src/utils/constants";


const toolName = `abortTest_${Date.now()}`;

const toolSchema = z.object({
  platform: z.string().optional(),
  deviceId: z.string().optional(),
  sessionUuid: z.string().optional(),
});

describe("PlanExecutor - abort signal checked after each step", () => {
  let planExecutor: DefaultPlanExecutor;
  let toolCallCount: number;

  beforeEach(() => {
    planExecutor = new DefaultPlanExecutor();
    toolCallCount = 0;
  });

  test("aborts immediately after tool returns when signal fired during execution", async () => {
    const abortController = new AbortController();

    ToolRegistry.register(
      toolName,
      "Tool that aborts the signal mid-execution on step 1",
      toolSchema,
      async () => {
        toolCallCount++;
        if (toolCallCount === 1) {
          abortController.abort();
        }
        return { success: true };
      },
    );

    const tool = ToolRegistry.getTool(toolName)!;
    (tool as any).requiresDevice = false;

    const plan: Plan = {
      name: "Abort After Step",
      mcpVersion: "1.0",
      steps: [
        { tool: toolName, params: {} },
        { tool: toolName, params: {} },
        { tool: toolName, params: {} },
      ],
    };

    const result = await planExecutor.executePlan(
      plan,
      0,
      "android",
      undefined,
      undefined,
      abortController.signal,
    );

    expect(toolCallCount).toBe(1);
    expect(result.success).toBe(false);
    expect(result.failedStep?.error).toInclude(OPERATION_CANCELLED_MESSAGE);
  });

  test("completes normally when signal is never aborted", async () => {
    const completionToolName = `abortTestComplete_${Date.now()}`;
    const abortController = new AbortController();

    ToolRegistry.register(
      completionToolName,
      "Tool that never aborts",
      toolSchema,
      async () => {
        toolCallCount++;
        return { success: true };
      },
    );

    const tool = ToolRegistry.getTool(completionToolName)!;
    (tool as any).requiresDevice = false;

    const plan: Plan = {
      name: "No Abort",
      mcpVersion: "1.0",
      steps: [
        { tool: completionToolName, params: {} },
        { tool: completionToolName, params: {} },
      ],
    };

    const result = await planExecutor.executePlan(
      plan,
      0,
      "android",
      undefined,
      undefined,
      abortController.signal,
    );

    expect(toolCallCount).toBe(2);
    expect(result.success).toBe(true);
    expect(result.executedSteps).toBe(2);
  });
});
