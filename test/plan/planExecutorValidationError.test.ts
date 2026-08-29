import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod/v4";
import { Plan } from "../../src/models/Plan";
import { DefaultPlanExecutor } from "../../src/utils/plan/PlanExecutor";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { registerObserveTools } from "../../src/server/observeTools";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";

// Issue #5854 §3: PlanExecutor called `tool.schema.parse(...)` directly, so a
// ZodError surfaced unformatted (raw "expected number, received number") instead
// of the same `formatToolParamError` rendering the MCP boundary produces. This
// pins that the plan path now names the constraint the same way.
describe("PlanExecutor validation error rendering (#5854)", () => {
  let planExecutor: DefaultPlanExecutor;
  const TOOL = "validationErrorTool5854";

  beforeEach(() => {
    planExecutor = new DefaultPlanExecutor();

    ToolRegistry.register(
      TOOL,
      "requires a finite duration",
      z.object({
        platform: z.string().optional(),
        deviceId: z.string().optional(),
        sessionUuid: z.string().optional(),
        duration: z.number(),
      }),
      mock(async () => createStructuredToolResponse({ success: true })),
    );
    (ToolRegistry.getTool(TOOL) as { requiresDevice: boolean }).requiresDevice = true;

    // The failure-observation `observe` capture also parses against a schema; stub
    // it so it does not interfere with the assertion under test.
    ToolRegistry.register(
      "observe",
      "failure observation",
      z.object({
        platform: z.string().optional(),
        deviceId: z.string().optional(),
        sessionUuid: z.string().optional(),
      }),
      mock(async () =>
        createStructuredToolResponse({ updatedAt: 0, activeWindow: { appId: "com.example" } }),
      ),
    );
    (ToolRegistry.getTool("observe") as { requiresDevice: boolean }).requiresDevice = true;
  });

  afterEach(() => {
    registerObserveTools();
  });

  test("a non-finite step param names the finite constraint with the MCP wording", async () => {
    const plan: Plan = {
      name: "non-finite-duration",
      steps: [{ tool: TOOL, params: { duration: Infinity } }],
    };

    const result = await planExecutor.executePlan(plan, 0, "android", "emulator-5554");

    expect(result.success).toBe(false);
    const error = result.failedStep?.error ?? "";
    expect(error).toContain(`Invalid parameters for tool ${TOOL}`);
    expect(error).toContain("duration must be a finite number");
    expect(error).not.toContain("expected number, received number");
  });
});
