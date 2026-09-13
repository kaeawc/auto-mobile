import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { DefaultPlanExecutor } from "../../src/utils/plan/PlanExecutor";
import { Plan } from "../../src/models/Plan";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { registerInteractionTools } from "../../src/server/interactionTools";
import { z } from "zod/v4";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";

/**
 * A best-effort epilogue that fails (a keyboard that would not dismiss) keeps the
 * step successful and reports itself through `warnings` (issue #6868). Inside
 * `executePlan` that used to be the step's whole failure signal, so dropping it
 * would let a plan report an entirely clean success while later steps ran against
 * a screen the caller thinks is in a different state.
 */
describe("PlanExecutor — best-effort warnings in debug.steps", () => {
  let planExecutor: DefaultPlanExecutor;

  const inputTextSchema = z.object({
    text: z.string(),
    dismissKeyboard: z.boolean().optional(),
    platform: z.string().optional(),
    deviceId: z.string().optional(),
    sessionUuid: z.string().optional(),
  });

  beforeEach(() => {
    planExecutor = new DefaultPlanExecutor();
  });

  afterEach(() => {
    registerInteractionTools();
  });

  const registerInputText = (payload: Record<string, unknown>) => {
    const handler = mock(async () => createStructuredToolResponse(payload));
    ToolRegistry.register("inputText", "Mock inputText", inputTextSchema, handler);
    (ToolRegistry.getTool("inputText") as { requiresDevice: boolean }).requiresDevice = true;
  };

  test("a successful step's warnings reach debug.steps[n].details", async () => {
    registerInputText({
      success: true,
      text: "hello",
      keyboardDismissed: false,
      warnings: ["keyboard dismissal failed: Keyboard state unavailable"],
    });

    const plan: Plan = {
      name: "input-warning-plan",
      steps: [{ tool: "inputText", params: { text: "hello", dismissKeyboard: true } }],
    };

    const result = await planExecutor.executePlan(plan, 0, "android", "emulator-5554");

    expect(result.success).toBe(true);
    const step = result.debug?.steps.find((s) => s.step.includes(": inputText"));
    expect(step?.status).toBe("completed");
    expect(step?.details?.warnings).toEqual([
      "keyboard dismissal failed: Keyboard state unavailable",
    ]);
  });

  test("a clean step carries no warnings key", async () => {
    registerInputText({ success: true, text: "hello", keyboardDismissed: true });

    const plan: Plan = {
      name: "input-clean-plan",
      steps: [{ tool: "inputText", params: { text: "hello", dismissKeyboard: true } }],
    };

    const result = await planExecutor.executePlan(plan, 0, "android", "emulator-5554");

    expect(result.success).toBe(true);
    const step = result.debug?.steps.find((s) => s.step.includes(": inputText"));
    expect(step?.details?.warnings).toBeUndefined();
  });
});
