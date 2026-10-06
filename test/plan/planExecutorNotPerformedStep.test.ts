import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod/v4";
import { DefaultPlanExecutor } from "../../src/utils/plan/PlanExecutor";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";
import type { BootedDevice } from "../../src/models";
import {
  resetSetPostureFactory,
  setPostureHandler,
  setSetPostureFactory,
} from "../../src/server/interactionTools";
import { FakeTimer } from "../fakes/FakeTimer";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();

/**
 * A plan step whose tool answers "not performed" without an error (`setPosture` returns
 * `{ status: "unsupported", message }`) must not count as completed (#10175): the plan would pass
 * without the state change it asked for. The direct tool result shape is unchanged.
 */
describe("PlanExecutor — a step the tool did not perform", () => {
  const nextStep = mock(async () => createStructuredToolResponse({ success: true }));
  const NOT_FOLDABLE = "This iOS simulator is not a foldable device.";
  const simulator: BootedDevice = { deviceId: "sim", platform: "ios", name: "sim" };
  let executor: DefaultPlanExecutor;

  beforeEach(() => {
    nextStep.mockClear();
    executor = new DefaultPlanExecutor(new FakeTimer());
    // The real setPosture response wrapper over a fake action that refuses, so the plan sees the
    // exact payload shape a non-foldable simulator produces.
    setSetPostureFactory(() => ({
      execute: async () => ({ status: "unsupported" as const, message: NOT_FOLDABLE }),
      executeHingeAngle: async () => ({ status: "unsupported" as const, message: NOT_FOLDABLE }),
    }));
    ToolRegistry.register(
      "setPosture",
      "setPosture handler over a fake refusing action",
      z.object({ hingeAngle: z.number().optional(), platform: z.string().optional() }),
      async (args) => setPostureHandler(simulator, args),
    );
    ToolRegistry.register("notPerformedNext", "next step", z.object({}).passthrough(), nextStep);
  });

  afterEach(() => {
    resetSetPostureFactory();
    ToolRegistry.unregister("setPosture");
    ToolRegistry.unregister("notPerformedNext");
  });

  test("fails the plan with the tool's message and does not run later steps", async () => {
    const result = await executor.executePlan(
      {
        name: "cover screen",
        steps: [
          { tool: "setPosture", params: { hingeAngle: 0 } },
          { tool: "notPerformedNext", params: {} },
        ],
      },
      0,
      "ios",
    );

    expect(result.success).toBe(false);
    expect(result.executedSteps).toBe(0);
    expect(result.failedStep).toEqual({
      stepIndex: 0,
      tool: "setPosture",
      error: NOT_FOLDABLE,
    });
    expect(result.debug?.steps[0].status).toBe("failed");
    expect(nextStep).not.toHaveBeenCalled();
  });

  test("an optional step is skipped with the message and the plan continues", async () => {
    const result = await executor.executePlan(
      {
        name: "optional posture",
        steps: [
          { tool: "setPosture", params: { hingeAngle: 0 }, optional: true },
          { tool: "notPerformedNext", params: {} },
        ],
      },
      0,
      "ios",
    );

    expect(result.success).toBe(true);
    expect(result.executedSteps).toBe(1);
    expect(result.failedStep).toBeUndefined();
    expect(result.debug?.steps[0]).toMatchObject({
      status: "skipped",
      details: { error: NOT_FOLDABLE, optional: true },
    });
    expect(nextStep).toHaveBeenCalledTimes(1);
  });

  test("a setPosture step that did set the posture still completes", async () => {
    ToolRegistry.unregister("setPosture");
    ToolRegistry.register(
      "setPosture",
      "Fake setPosture that works",
      z.object({ hingeAngle: z.number().optional(), platform: z.string().optional() }),
      async () =>
        createStructuredToolResponse({
          message: "Set device posture to closed",
          posture: "closed",
        }),
    );

    const result = await executor.executePlan(
      { name: "folded", steps: [{ tool: "setPosture", params: { hingeAngle: 0 } }] },
      0,
      "ios",
    );

    expect(result.success).toBe(true);
    expect(result.executedSteps).toBe(1);
  });

  test("a direct call of the tool keeps its non-error unsupported result", async () => {
    const response = await setPostureHandler(simulator, { hingeAngle: 0 });
    expect(response.isError).toBeUndefined();
    expect(response.structuredContent).toEqual({ message: NOT_FOLDABLE, status: "unsupported" });
  });
});
