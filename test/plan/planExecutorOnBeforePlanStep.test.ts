import { describe, expect, mock, beforeEach, test } from "bun:test";
import { DefaultPlanExecutor } from "../../src/utils/plan/PlanExecutor";
import { Plan } from "../../src/models/Plan";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { z } from "zod/v4";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";

describe("PlanExecutor — onBeforePlanStep", () => {
  let planExecutor: DefaultPlanExecutor;

  beforeEach(() => {
    planExecutor = new DefaultPlanExecutor();
    const noopSchema = z.object({
      platform: z.string().optional(),
      deviceId: z.string().optional(),
    });
    ToolRegistry.register(
      "hookTestNoop",
      "Mock noop",
      noopSchema,
      mock(async () => createStructuredToolResponse({ ok: true }))
    );
    (ToolRegistry.getTool("hookTestNoop") as { requiresDevice: boolean }).requiresDevice = true;
  });

  test("invokes onBeforePlanStep once per step with correct indices", async () => {
    const hook = mock(async () => {});

    const plan: Plan = {
      name: "hook-test",
      steps: [
        { tool: "hookTestNoop", params: {} },
        { tool: "hookTestNoop", params: {} },
        { tool: "hookTestNoop", params: {} },
      ],
    };

    await planExecutor.executePlan(plan, 0, "android", "emulator-5554", undefined, undefined, undefined, {
      onBeforePlanStep: hook,
    });

    expect(hook).toHaveBeenCalledTimes(3);
    expect(hook.mock.calls[0]?.[0]).toEqual({ stepIndex: 0, totalSteps: 3 });
    expect(hook.mock.calls[1]?.[0]).toEqual({ stepIndex: 1, totalSteps: 3 });
    expect(hook.mock.calls[2]?.[0]).toEqual({ stepIndex: 2, totalSteps: 3 });
  });

  test("invokes hook from startStep offset with correct totalSteps", async () => {
    const hook = mock(async () => {});

    const plan: Plan = {
      name: "hook-offset",
      steps: [
        { tool: "hookTestNoop", params: {} },
        { tool: "hookTestNoop", params: {} },
        { tool: "hookTestNoop", params: {} },
      ],
    };

    await planExecutor.executePlan(plan, 1, "android", "emulator-5554", undefined, undefined, undefined, {
      onBeforePlanStep: hook,
    });

    expect(hook).toHaveBeenCalledTimes(2);
    expect(hook.mock.calls[0]?.[0]).toEqual({ stepIndex: 1, totalSteps: 3 });
    expect(hook.mock.calls[1]?.[0]).toEqual({ stepIndex: 2, totalSteps: 3 });
  });
});
