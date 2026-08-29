import { describe, expect, test, mock, afterEach } from "bun:test";
import { DefaultPlanExecutor } from "../../src/utils/plan/PlanExecutor";
import { Plan } from "../../src/models/Plan";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { registerInteractionTools } from "../../src/server/interactionTools";
import { z } from "zod/v4";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";

// Issue #5854, AC3: PlanExecutor called `tool.schema.parse(...)` directly, so a
// ZodError surfaced raw (the self-contradictory "expected number, received
// number" for a non-finite value) instead of the MCP boundary's formatted
// message. The plan path must render validation errors the same way.
describe("PlanExecutor validation errors match the MCP boundary rendering", () => {
  afterEach(() => {
    registerInteractionTools();
  });

  test("a non-finite param yields the formatted finite-number message", async () => {
    const schema = z.object({
      value: z.number(),
      platform: z.string().optional(),
      deviceId: z.string().optional(),
      sessionUuid: z.string().optional(),
    });
    const handler = mock(async () =>
      createStructuredToolResponse({ success: true, message: "ok" }),
    );
    ToolRegistry.register("mockNum", "Mock numeric tool", schema, handler);

    const plan: Plan = {
      name: "validation-plan",
      steps: [{ tool: "mockNum", params: { value: Infinity } }],
    };

    const planExecutor = new DefaultPlanExecutor();
    const result = await planExecutor.executePlan(plan, 0, "android", "emulator-5554");

    expect(result.success).toBe(false);
    const serialized = JSON.stringify(result);
    // Same "Invalid parameters for tool <name>: <formatted>" rendering the MCP
    // boundary produces, and the finite-number constraint is named.
    expect(serialized).toContain("Invalid parameters for tool mockNum");
    expect(serialized).toContain("value must be a finite number");
    // Never the raw, self-contradictory zod default.
    expect(serialized).not.toContain("expected number, received number");
    // The tool handler must never run when validation fails.
    expect(handler).not.toHaveBeenCalled();
  });
});
