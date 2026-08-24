import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { DefaultPlanExecutor } from "../../src/utils/plan/PlanExecutor";
import { Plan } from "../../src/models/Plan";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { registerObserveTools } from "../../src/server/observeTools";
import { z } from "zod/v4";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";

describe("PlanExecutor — observe waitFor timeout", () => {
  let planExecutor: DefaultPlanExecutor;

  beforeEach(() => {
    planExecutor = new DefaultPlanExecutor();
    const observeSchema = z.object({
      platform: z.string().optional(),
      deviceId: z.string().optional(),
      sessionUuid: z.string().optional(),
      waitFor: z.any().optional(),
    });
    const observeHandler = mock(async () =>
      createStructuredToolResponse({
        updatedAt: Date.now(),
        screenSize: { width: 100, height: 100 },
        systemInsets: { left: 0, top: 0, right: 0, bottom: 0 },
        awaitTimeout: true,
        awaitDuration: 5000,
      }),
    );
    ToolRegistry.register("observe", "Mock observe timeout", observeSchema, observeHandler);
    (ToolRegistry.getTool("observe") as { requiresDevice: boolean }).requiresDevice = true;

    const noopSchema = z.object({ platform: z.string().optional() });
    ToolRegistry.register(
      "observeAwaitTimeoutChainNoop",
      "noop after observe",
      noopSchema,
      mock(async () => createStructuredToolResponse({ success: true })),
    );
  });

  afterEach(() => {
    registerObserveTools();
  });

  test("fails the plan when observe returns awaitTimeout true (does not advance to next step)", async () => {
    const plan: Plan = {
      name: "timeout-chain",
      steps: [
        { tool: "observe", params: { waitFor: { elementId: "x", timeout: 1 } } },
        { tool: "observeAwaitTimeoutChainNoop", params: {} },
      ],
    };

    const result = await planExecutor.executePlan(plan, 0, "android", "emulator-5554");

    expect(result.success).toBe(false);
    expect(result.executedSteps).toBe(0);
    expect(result.failedStep?.tool).toBe("observe");
    expect(String(result.failedStep?.error)).toContain("timed out");
    expect(String(result.failedStep?.error)).toContain("5000");
  });
});
