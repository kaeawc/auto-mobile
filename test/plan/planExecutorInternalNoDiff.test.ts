import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { DefaultPlanExecutor } from "../../src/utils/plan/PlanExecutor";
import { Plan } from "../../src/models/Plan";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { registerInteractionTools } from "../../src/server/interactionTools";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";

/**
 * Regression guard for issue #3053 part 2: PlanExecutor must mark its tool-to-tool
 * calls internal (`__internalNoDiff`) so a plan step's finalized envelope is never
 * diffed or stripped under `--actions-diff-observe`/`--actions-no-observe`. This
 * pins the marker injection at the PlanExecutor boundary (the wrapped-handler →
 * finalize half is covered by toolRegistry.internalNoDiff.test.ts) and confirms
 * the marker does not disturb the success/error step logic.
 */
describe("PlanExecutor internal no-diff marker (#3053)", () => {
  let planExecutor: DefaultPlanExecutor;
  let capturedArgs: Record<string, unknown>[];

  const schema = z.object({
    text: z.string().optional(),
    platform: z.string().optional(),
    deviceId: z.string().optional(),
    sessionUuid: z.string().optional(),
  });

  beforeEach(() => {
    planExecutor = new DefaultPlanExecutor();
    capturedArgs = [];
  });

  afterEach(() => {
    registerInteractionTools();
  });

  function registerCapturingTool(success: boolean): void {
    ToolRegistry.register("tapOn", "Mock tapOn", schema, async (args: any) => {
      capturedArgs.push(args);
      return createStructuredToolResponse(
        success ? { success: true, message: "ok" } : { success: false, error: "not found" },
      );
    });
    (ToolRegistry.getTool("tapOn") as { requiresDevice: boolean }).requiresDevice = true;
  }

  test("EC2.4: injects __internalNoDiff on the tool call and leaves success logic intact", async () => {
    registerCapturingTool(true);
    const plan: Plan = { name: "p", steps: [{ tool: "tapOn", params: { text: "Go" } }] };

    const result = await planExecutor.executePlan(plan, 0, "android", "emulator-5554", "sess-1");

    expect(result.success).toBe(true);
    expect(capturedArgs).toHaveLength(1);
    // The internal marker reaches the handler (set after schema.parse).
    expect(capturedArgs[0].__internalNoDiff).toBe(true);
    // Existing injected routing params are unaffected.
    expect(capturedArgs[0].sessionUuid).toBe("sess-1");
  });

  test("EC2.4: a failed step still gets the marker and reports failure normally", async () => {
    registerCapturingTool(false);
    const plan: Plan = { name: "p", steps: [{ tool: "tapOn", params: { text: "Missing" } }] };

    const result = await planExecutor.executePlan(plan, 0, "android", "emulator-5554");

    expect(result.success).toBe(false);
    expect(capturedArgs[0].__internalNoDiff).toBe(true);
  });
});
