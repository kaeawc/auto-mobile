import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import type { BootedDevice } from "../../src/models";
import type { Plan } from "../../src/models/Plan";
import { runWithToolSelectionContext } from "../../src/features/toolSelection/toolSelectionContext";
import { registerPlanTools } from "../../src/server/planTools";
import { ToolRegistry, type PlanLifecycleInput } from "../../src/server/toolRegistry";
import { ActionableError } from "../../src/models";
import { MAX_PLAN_NESTING_DEPTH } from "../../src/utils/plan/planNesting";
import { DefaultPlanExecutor } from "../../src/utils/plan/PlanExecutor";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";

/**
 * A nested `executePlan` step must not release the OUTER plan's session when it returns (#10172).
 * The real registry wrapper, real plan executor and real async tool-selection context run here;
 * only the executePlan body (a stand-in for the orchestrator) and the lifecycle hook (a recorder)
 * are fakes.
 */
const device: BootedDevice = { deviceId: "device-1", platform: "android", name: "Pixel" };

interface LifecycleRecord {
  plan: string;
  nested: boolean | undefined;
}

describe("nested executePlan and the plan lifecycle hook (#10172)", () => {
  let restoreTools: () => void;
  let restorePipeline: () => void;
  let timeline: string[];
  let lifecycle: LifecycleRecord[];
  let plans: Record<string, Plan>;
  let innerBehaviour: "pass" | "fail" | "throw" | "gate";
  let gate: PromiseWithResolvers<void>;

  const step = (tool: string, params: Record<string, unknown> = {}) => ({ tool, params });

  beforeEach(() => {
    restoreTools = preserveToolRegistry();
    timeline = [];
    lifecycle = [];
    innerBehaviour = "pass";
    gate = Promise.withResolvers<void>();
    plans = {
      outer: {
        name: "outer",
        steps: [
          step("firstStep"),
          step("executePlan", { planName: "inner", platform: "android" }),
          step("lastStep"),
        ],
      },
      flat: { name: "flat", steps: [step("firstStep")] },
    };
    restorePipeline = ToolRegistry.setPipelineOverridesForTesting({
      executionTargetResolver: {
        resolveExecutionTarget: async (input) => ({
          args: input.args,
          baseSessionUuid: "S",
          device,
          sessionUuid: "S",
          internalCall: false,
          shouldResolveDevice: true,
        }),
      },
      auditRunner: {
        run: async (input) => input.handler(input.device, input.args, input.progress, input.signal),
      },
      afterToolCall: {
        handle: async (input) => ({ durationMs: 0, finalizedResponse: input.response }),
      },
      planLifecycleManager: {
        afterExecution: async (input: PlanLifecycleInput) => {
          if (input.name !== "executePlan") {
            return;
          }
          lifecycle.push({ plan: String(input.args.planName), nested: input.nestedInPlan });
          timeline.push(
            `lifecycle:${input.args.planName}:${input.nestedInPlan ? "nested" : "top"}`,
          );
        },
      },
    });

    const stepSchema = z.object({
      platform: z.string().optional(),
      deviceId: z.string().optional(),
    });
    for (const name of ["firstStep", "lastStep"]) {
      ToolRegistry.registerDeviceAware(name, `${name} probe`, stepSchema, async () => {
        timeline.push(name);
        return createStructuredToolResponse({ success: true });
      });
    }
    // Stand-in for executePlanTool: runs the named plan under a planRequest context, exactly the
    // context the real tool establishes for its steps.
    ToolRegistry.registerDeviceAware(
      "executePlan",
      "executePlan stand-in",
      z.object({
        planName: z.string(),
        platform: z.string().optional(),
        sessionUuid: z.string().optional(),
        deviceId: z.string().optional(),
      }),
      async (_device, params) => {
        if (params.planName === "inner") {
          if (innerBehaviour === "throw") {
            throw new ActionableError("inner exploded");
          }
          if (innerBehaviour === "fail") {
            return createStructuredToolResponse({ success: false, error: "inner plan failed" });
          }
          if (innerBehaviour === "gate") {
            await gate.promise;
          }
          return createStructuredToolResponse({ success: true });
        }
        const result = await runWithToolSelectionContext({ planRequest: { planDepth: 1 } }, () =>
          new DefaultPlanExecutor(new FakeTimer()).executePlan(
            plans[params.planName as string],
            0,
            "android",
            device.deviceId,
            "S",
          ),
        );
        return createStructuredToolResponse({ ...result });
      },
    );
  });

  afterEach(() => {
    restorePipeline();
    restoreTools();
  });

  const runTopLevel = async (planName: string) => {
    const response = await ToolRegistry.getToolForPlan("executePlan")!.handler({
      planName,
      platform: "android",
      sessionUuid: "S",
    });
    return response.structuredContent as {
      success: boolean;
      executedSteps: number;
      failedStep?: { stepIndex: number; tool: string; error: string };
    };
  };

  test("only the outermost executePlan reaches the release path; the step after the sub-plan still runs", async () => {
    const result = await runTopLevel("outer");

    expect(result.success).toBe(true);
    expect(result.executedSteps).toBe(3);
    expect(timeline).toEqual([
      "firstStep",
      "lifecycle:inner:nested",
      "lastStep",
      "lifecycle:outer:top",
    ]);
  });

  test("a failing nested plan is the outer plan's failed step and still releases nothing early", async () => {
    innerBehaviour = "fail";
    const result = await runTopLevel("outer");

    expect(result.success).toBe(false);
    expect(result.failedStep).toMatchObject({ stepIndex: 1, tool: "executePlan" });
    expect(result.failedStep?.error).toContain("inner plan failed");
    expect(timeline).toEqual(["firstStep", "lifecycle:inner:nested", "lifecycle:outer:top"]);
  });

  test("a throwing nested plan is the outer plan's failed step and still releases nothing early", async () => {
    innerBehaviour = "throw";
    const result = await runTopLevel("outer");

    expect(result.success).toBe(false);
    expect(result.failedStep).toMatchObject({ stepIndex: 1, tool: "executePlan" });
    expect(result.failedStep?.error).toContain("inner exploded");
    expect(timeline).toEqual(["firstStep", "lifecycle:inner:nested", "lifecycle:outer:top"]);
  });

  test("a plain top-level executePlan is not flagged as nested", async () => {
    await runTopLevel("flat");
    expect(lifecycle).toEqual([{ plan: "flat", nested: false }]);
  });

  test("nesting is tracked per request: a concurrent top-level plan is not marked nested", async () => {
    innerBehaviour = "gate";
    const running = runTopLevel("outer");
    // The outer plan is parked inside its nested step; an independent top-level call now runs to
    // completion. A process-wide counter would flag it as nested and skip its release.
    await Promise.resolve();
    await runTopLevel("flat");
    gate.resolve();
    await running;

    expect(lifecycle).toEqual([
      { plan: "flat", nested: false },
      { plan: "inner", nested: true },
      { plan: "outer", nested: false },
    ]);
  });
});

describe("executePlan nesting depth (#10172)", () => {
  let restoreTools: () => void;
  beforeEach(() => {
    restoreTools = preserveToolRegistry();
    registerPlanTools();
  });
  afterEach(() => restoreTools());

  const nestedParams = {
    planContent: "name: self\nsteps: []",
    startStep: 0,
    platform: "android" as const,
    deviceAllocationTimeoutMs: 1000,
    abortStrategy: "immediate" as const,
  };

  test("a plan nested past the limit is refused with a clear error instead of recursing", async () => {
    const tool = ToolRegistry.getToolForPlan("executePlan")!;
    await expect(
      runWithToolSelectionContext({ planRequest: { planDepth: MAX_PLAN_NESTING_DEPTH } }, () =>
        tool.deviceAwareHandler!(device, nestedParams),
      ),
    ).rejects.toThrow(`nested more than ${MAX_PLAN_NESTING_DEPTH} plans deep`);
  });
});
