import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { DefaultPlanExecutor } from "../../src/utils/plan/PlanExecutor";
import { Plan } from "../../src/models/Plan";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { registerInteractionTools } from "../../src/server/interactionTools";
import { z } from "zod/v4";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";

/**
 * A best-effort epilogue that fails keeps the step successful and reports itself
 * through `warnings` (issue #6868). Inside
 * `executePlan` that used to be the step's whole failure signal, so dropping it
 * would let a plan report an entirely clean success while later steps ran against
 * a screen the caller thinks is in a different state.
 */
describe("PlanExecutor — best-effort warnings in debug.steps", () => {
  let planExecutor: DefaultPlanExecutor;

  const sendKeysSchema = z.object({
    commands: z.array(z.object({ action: z.string() })),
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

  const registerSendKeys = (payload: Record<string, unknown>) => {
    const handler = mock(async () => createStructuredToolResponse(payload));
    ToolRegistry.register("sendKeys", "Mock sendKeys", sendKeysSchema, handler);
    (ToolRegistry.getTool("sendKeys") as { requiresDevice: boolean }).requiresDevice = true;
  };

  test("a successful step's warnings reach debug.steps[n].details", async () => {
    registerSendKeys({
      success: true,
      text: "hello",
      keyboardDismissed: false,
      warnings: ["keyboard dismissal failed: Keyboard state unavailable"],
    });

    const plan: Plan = {
      name: "input-warning-plan",
      steps: [{ tool: "sendKeys", params: { commands: [{ action: "clear" }] } }],
    };

    const result = await planExecutor.executePlan(plan, 0, "android", "emulator-5554");

    expect(result.success).toBe(true);
    const step = result.debug?.steps.find((s) => s.step.includes(": sendKeys"));
    expect(step?.status).toBe("completed");
    expect(step?.details?.warnings).toEqual([
      "keyboard dismissal failed: Keyboard state unavailable",
    ]);
  });

  // `debug` is only forwarded into the executePlan response when the unrelated
  // `captureObserveSteps` option is set, so a warning that lives only in the
  // debug trace never reaches an ordinary plan's caller (#6887 review). The
  // executor promotes it to a first-class `warnings` field on the result.
  test("a successful step's warnings are promoted onto the plan result", async () => {
    registerSendKeys({
      success: true,
      text: "hello",
      keyboardDismissed: false,
      warnings: ["keyboard dismissal failed: Keyboard state unavailable"],
    });

    const plan: Plan = {
      name: "input-warning-plan",
      steps: [
        { tool: "sendKeys", params: { commands: [{ action: "clear" }] } },
        { tool: "sendKeys", params: { commands: [{ action: "key" }] } },
      ],
    };

    const result = await planExecutor.executePlan(plan, 0, "android", "emulator-5554");

    expect(result.success).toBe(true);
    expect(result.warnings).toEqual([
      {
        stepIndex: 0,
        tool: "sendKeys",
        warnings: ["keyboard dismissal failed: Keyboard state unavailable"],
      },
      {
        stepIndex: 1,
        tool: "sendKeys",
        warnings: ["keyboard dismissal failed: Keyboard state unavailable"],
      },
    ]);
  });

  test("a multi-device plan labels each promoted warning with its device", async () => {
    registerSendKeys({
      success: true,
      text: "hello",
      keyboardDismissed: false,
      warnings: ["keyboard dismissal failed: Keyboard state unavailable"],
    });

    const plan: Plan = {
      name: "input-warning-multi-device-plan",
      devices: ["A", "B"],
      steps: [
        { tool: "sendKeys", params: { commands: [{ action: "clear" }], device: "A" } },
        { tool: "sendKeys", params: { commands: [{ action: "clear" }], device: "B" } },
      ],
    };

    const result = await planExecutor.executePlan(plan, 0, "android", "emulator-5554");

    expect(result.success).toBe(true);
    expect(
      [...(result.warnings ?? [])].sort((a, b) => (a.device ?? "").localeCompare(b.device ?? "")),
    ).toEqual([
      {
        stepIndex: 0,
        tool: "sendKeys",
        device: "A",
        warnings: ["keyboard dismissal failed: Keyboard state unavailable"],
      },
      {
        stepIndex: 1,
        tool: "sendKeys",
        device: "B",
        warnings: ["keyboard dismissal failed: Keyboard state unavailable"],
      },
    ]);
  });

  test("a clean plan carries no warnings key", async () => {
    registerSendKeys({ success: true });

    const plan: Plan = {
      name: "input-clean-result-plan",
      steps: [{ tool: "sendKeys", params: { commands: [{ action: "clear" }] } }],
    };

    const result = await planExecutor.executePlan(plan, 0, "android", "emulator-5554");

    expect(result.warnings).toBeUndefined();
  });

  test("a clean step carries no warnings key", async () => {
    registerSendKeys({ success: true });

    const plan: Plan = {
      name: "input-clean-plan",
      steps: [{ tool: "sendKeys", params: { commands: [{ action: "clear" }] } }],
    };

    const result = await planExecutor.executePlan(plan, 0, "android", "emulator-5554");

    expect(result.success).toBe(true);
    const step = result.debug?.steps.find((s) => s.step.includes(": sendKeys"));
    expect(step?.details?.warnings).toBeUndefined();
  });
});
