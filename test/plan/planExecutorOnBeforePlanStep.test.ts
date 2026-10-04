import { describe, expect, mock, beforeEach, afterEach, test } from "bun:test";
import { DefaultPlanExecutor } from "../../src/utils/plan/PlanExecutor";
import { Plan } from "../../src/models/Plan";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { z } from "zod/v4";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";
import type { PlanStepLifecycleContext } from "../../src/models/ExecutePlanResult";
import { raceWithDeadline } from "../../src/utils/raceWithDeadline";
import { OPERATION_CANCELLED_MESSAGE } from "../../src/utils/constants";
import { FakeTimer } from "../fakes/FakeTimer";

describe("PlanExecutor — onBeforePlanStep", () => {
  let planExecutor: DefaultPlanExecutor;

  afterEach(() => {
    ToolRegistry.unregister("hookTestNoop");
  });

  beforeEach(() => {
    planExecutor = new DefaultPlanExecutor();
    const noopSchema = z.object({
      platform: z.string().optional(),
      deviceId: z.string().optional(),
    });
    ToolRegistry.register(
      "hookTestNoop",
      "Mock noop",
      noopSchema,
      mock(async () => createStructuredToolResponse({ ok: true })),
    );
    (ToolRegistry.getTool("hookTestNoop") as { requiresDevice: boolean }).requiresDevice = true;
  });

  test("forwards cancellation to a pending hook and classifies it as a plan abort", async () => {
    const timer = new FakeTimer();
    const controller = new AbortController();
    const hookEntered = Promise.withResolvers<void>();
    const pendingStop = Promise.withResolvers<void>();
    let hookSignal: AbortSignal | undefined;
    const hook = async (context: PlanStepLifecycleContext) => {
      hookSignal = context.signal;
      hookEntered.resolve();
      await raceWithDeadline(pendingStop.promise, {
        timer,
        signal: context.signal,
        label: "segment rotation stop",
      });
    };
    let finished = false;
    const execution = planExecutor
      .executePlan(
        { name: "cancel-hook", steps: [{ tool: "hookTestNoop", params: {} }] },
        0,
        "android",
        "emulator-5554",
        undefined,
        controller.signal,
        undefined,
        { onBeforePlanStep: hook },
      )
      .then((result) => {
        finished = true;
        return result;
      });
    await hookEntered.promise;
    controller.abort(new Error("caller-specific abort reason"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(finished).toBe(true);
    expect(hookSignal).toBe(controller.signal);
    const result = await execution;
    expect(result.success).toBe(false);
    expect(result.executedSteps).toBe(0);
    expect(result.failedStep?.error).toContain(OPERATION_CANCELLED_MESSAGE);
    expect(result.failedStep?.error).not.toContain("caller-specific abort reason");
    pendingStop.reject(new Error("late stop rejection"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(timer.now()).toBe(0);
  });

  test("invokes onBeforePlanStep once per step with correct indices", async () => {
    const hook = mock(async () => {});

    const plan: Plan = {
      name: "hook-test",
      steps: [
        { tool: "hookTestNoop", params: {} },
        { tool: "hookTestNoop", params: {} },
        { tool: "hookTestNoop", params: {} },
      ],
    };

    await planExecutor.executePlan(
      plan,
      0,
      "android",
      "emulator-5554",
      undefined,
      undefined,
      undefined,
      {
        onBeforePlanStep: hook,
      },
    );

    expect(hook).toHaveBeenCalledTimes(3);
    expect(hook.mock.calls[0]?.[0]).toEqual({ stepIndex: 0, totalSteps: 3 });
    expect(hook.mock.calls[1]?.[0]).toEqual({ stepIndex: 1, totalSteps: 3 });
    expect(hook.mock.calls[2]?.[0]).toEqual({ stepIndex: 2, totalSteps: 3 });
  });

  test("invokes hook from startStep offset with correct totalSteps", async () => {
    const hook = mock(async () => {});

    const plan: Plan = {
      name: "hook-offset",
      steps: [
        { tool: "hookTestNoop", params: {} },
        { tool: "hookTestNoop", params: {} },
        { tool: "hookTestNoop", params: {} },
      ],
    };

    await planExecutor.executePlan(
      plan,
      1,
      "android",
      "emulator-5554",
      undefined,
      undefined,
      undefined,
      {
        onBeforePlanStep: hook,
      },
    );

    expect(hook).toHaveBeenCalledTimes(2);
    expect(hook.mock.calls[0]?.[0]).toEqual({ stepIndex: 1, totalSteps: 3 });
    expect(hook.mock.calls[1]?.[0]).toEqual({ stepIndex: 2, totalSteps: 3 });
  });
});
