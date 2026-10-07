import { afterEach, describe, expect, test, mock } from "bun:test";
import { z } from "zod/v4";
import { DefaultPlanExecutor } from "../../src/utils/plan/PlanExecutor";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();

describe("PlanExecutor unsupported tool results", () => {
  afterEach(() => {
    ToolRegistry.unregister("setPosture");
    ToolRegistry.unregister("unsupportedNext");
  });

  test("fails with the unsupported message and skips optional unsupported steps", async () => {
    ToolRegistry.register("setPosture", "mock posture", z.object({}).passthrough(), async () =>
      createStructuredToolResponse({ message: "not foldable", status: "unsupported" }),
    );
    const next = mock(async () => createStructuredToolResponse({ success: true }));
    ToolRegistry.register("unsupportedNext", "next", z.object({}).passthrough(), next);
    const executor = new DefaultPlanExecutor(new FakeTimer());
    const failed = await executor.executePlan(
      {
        name: "unsupported",
        steps: [
          { tool: "setPosture", params: {} },
          { tool: "unsupportedNext", params: {} },
        ],
      },
      0,
    );
    expect(failed.success).toBe(false);
    expect(failed.failedStep).toMatchObject({ stepIndex: 0, error: "not foldable" });
    expect(next).not.toHaveBeenCalled();

    const optional = await executor.executePlan(
      {
        name: "optional",
        steps: [
          { tool: "setPosture", params: {}, optional: true },
          { tool: "unsupportedNext", params: {} },
        ],
      },
      0,
    );
    expect(optional.success).toBe(true);
    expect(optional.skippedSteps?.[0]).toMatchObject({ stepIndex: 0, error: "not foldable" });
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("normal setPosture success still completes", async () => {
    ToolRegistry.register("setPosture", "mock posture", z.object({}).passthrough(), async () =>
      createStructuredToolResponse({ success: true, status: "success" }),
    );
    const result = await new DefaultPlanExecutor(new FakeTimer()).executePlan(
      { name: "success", steps: [{ tool: "setPosture", params: {} }] },
      0,
    );
    expect(result.success).toBe(true);
    expect(result.executedSteps).toBe(1);
  });
});
