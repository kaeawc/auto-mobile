import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { DefaultPlanExecutor } from "../../src/utils/plan/PlanExecutor";
import { Plan } from "../../src/models/Plan";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { registerInteractionTools } from "../../src/server/interactionTools";
import { z } from "zod/v4";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";

describe("PlanExecutor — tapOn tapDebug in debug.steps", () => {
  let planExecutor: DefaultPlanExecutor;

  const tapOnSchema = z.object({
    text: z.string(),
    platform: z.string().optional(),
    deviceId: z.string().optional(),
    sessionUuid: z.string().optional(),
    action: z.string().optional(),
  });

  const sampleTapDebug = {
    platform: "android" as const,
    action: "tap",
    tapPoint: { x: 10, y: 20 },
    tapTargetBounds: { left: 0, top: 0, right: 100, bottom: 50 },
    tapTargetResourceId: "com.example:id/go",
    usedClickableParent: false,
    injectionAttempts: [{ method: "android-adb-shell-input-tap", success: true }],
  };

  beforeEach(() => {
    planExecutor = new DefaultPlanExecutor();
    const tapOnHandler = mock(async () =>
      createStructuredToolResponse({
        success: true,
        action: "tap",
        message: "ok",
        element: { bounds: { left: 0, top: 0, right: 1, bottom: 1 } },
        tapDebug: sampleTapDebug,
      }),
    );
    ToolRegistry.register("tapOn", "Mock tapOn", tapOnSchema, tapOnHandler);
    (ToolRegistry.getTool("tapOn") as { requiresDevice: boolean }).requiresDevice = true;
  });

  afterEach(() => {
    registerInteractionTools();
  });

  test("successful tapOn copies tapDebug into debug.steps[n].details", async () => {
    const plan: Plan = {
      name: "tap-debug-plan",
      steps: [{ tool: "tapOn", params: { text: "Go" } }],
    };

    const result = await planExecutor.executePlan(plan, 0, "android", "emulator-5554");

    expect(result.success).toBe(true);
    const tapStep = result.debug?.steps.find((s) => s.step.includes(": tapOn"));
    expect(tapStep?.details?.tapDebug).toEqual(sampleTapDebug);
  });

  test("failed tapOn still copies tapDebug when the tool returned it", async () => {
    const tapOnHandler = mock(async () =>
      createStructuredToolResponse({
        success: false,
        error: "not found",
        tapDebug: sampleTapDebug,
      }),
    );
    ToolRegistry.register("tapOn", "Mock tapOn fail", tapOnSchema, tapOnHandler);
    (ToolRegistry.getTool("tapOn") as { requiresDevice: boolean }).requiresDevice = true;

    const plan: Plan = {
      name: "tap-debug-fail",
      steps: [{ tool: "tapOn", params: { text: "Missing" } }],
    };

    const result = await planExecutor.executePlan(plan, 0, "android", "emulator-5554");

    expect(result.success).toBe(false);
    const tapStep = result.debug?.steps.find((s) => s.step.includes(": tapOn"));
    expect(tapStep?.status).toBe("failed");
    expect(tapStep?.details?.tapDebug).toEqual(sampleTapDebug);
  });
});
