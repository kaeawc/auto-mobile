import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { z } from "zod/v4";
import type { BootedDevice } from "../../src/models";
import type { Plan, PlanExecutionResult } from "../../src/models/Plan";
import { registerBarrierTools } from "../../src/server/barrierTools";
import { CriticalSectionCoordinator } from "../../src/server/CriticalSectionCoordinator";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { DefaultPlanExecutor } from "../../src/utils/plan/PlanExecutor";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainUntil } from "../helpers/fakeTimerStepping";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();

/**
 * Issue #10025: with `abortStrategy: finish-current-step`, a surviving track that is
 * (or later gets) parked at a barrier shared with a track that already failed used to wait
 * out the full barrier timeout, and that timeout could be reported as the plan's failedStep.
 * Every wait below is on a FakeTimer coordinator that is never advanced, so a barrier that
 * still waited for its timeout would never settle.
 */

const workTool = "participantFailureWork";
const workSchema = z.object({ device: z.string(), fail: z.boolean().optional() });

const devicesByLabel: Record<string, BootedDevice> = {
  A: { platform: "android", deviceId: "device-a", name: "Device A" },
  B: { platform: "android", deviceId: "device-b", name: "Device B" },
  C: { platform: "android", deviceId: "device-c", name: "Device C" },
};

interface Gate {
  promise: Promise<void>;
  open: () => void;
}

function gate(): Gate {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, open: resolve };
}

describe("finish-current-step participant failure at a barrier (#10025)", () => {
  let timer: FakeTimer;
  let coordinator: CriticalSectionCoordinator;
  let restoreCoordinator: () => void;
  let restorePipeline: () => void;
  let barrierCalls: string[];
  let failedCalls: string[];
  let toolCallRepository: { toolCallRepository: unknown };
  let originalToolCallRepository: unknown;
  /** Work-tool gates by "<device>:<tag>"; an unset gate runs straight through. */
  let workGates: Map<string, Gate>;

  beforeAll(() => {
    if (!ToolRegistry.getToolForPlan("barrier")) {
      registerBarrierTools();
    }
  });

  beforeEach(() => {
    timer = new FakeTimer();
    coordinator = CriticalSectionCoordinator.createForTesting(timer);
    restoreCoordinator = CriticalSectionCoordinator.setInstanceForTesting(coordinator);
    barrierCalls = [];
    failedCalls = [];
    workGates = new Map();
    const awaitBarrier = coordinator.awaitBarrier.bind(coordinator);
    spyOn(coordinator, "awaitBarrier").mockImplementation((lock, deviceId, ...rest) => {
      barrierCalls.push(deviceId);
      return awaitBarrier(lock, deviceId, ...rest);
    });

    ToolRegistry.register(
      workTool,
      "Gated work step that can fail",
      workSchema,
      async (params: z.infer<typeof workSchema>) => {
        await workGates.get(`${params.device}:${params.fail ? "fail" : "ok"}`)?.promise;
        if (params.fail) {
          failedCalls.push(params.device);
          return { success: false, error: `real failure on ${params.device}` };
        }
        return { success: true };
      },
    );
    ToolRegistry.getTool(workTool)!.requiresDevice = false;

    // The device-aware wrapper records every call through ToolCallRepository, which would
    // resolve the real file-backed DB (#3067); swap in no-ops as barrierTools.test.ts does.
    toolCallRepository = ToolRegistry as unknown as { toolCallRepository: unknown };
    originalToolCallRepository = toolCallRepository.toolCallRepository;
    toolCallRepository.toolCallRepository = { recordToolCall: async () => {} };
    restorePipeline = ToolRegistry.setPipelineOverridesForTesting({
      executionTargetResolver: {
        resolveExecutionTarget: async (input) => {
          const label = typeof input.args.device === "string" ? input.args.device : "A";
          return {
            args: input.args,
            baseSessionUuid: "base-uuid",
            device: devicesByLabel[label],
            internalCall: true,
            sessionUuid: label === "A" ? "base-uuid" : `base-uuid:${label}`,
            shouldResolveDevice: true,
          };
        },
      },
      auditRunner: {
        run: async (input) => input.handler(input.device, input.args, input.progress, input.signal),
      },
      afterToolCall: {
        handle: async (input) => ({ durationMs: 0, finalizedResponse: input.response }),
      },
      planLifecycleManager: {
        afterExecution: async () => {},
      },
    });
  });

  afterEach(() => {
    restorePipeline();
    toolCallRepository.toolCallRepository = originalToolCallRepository;
    coordinator.reset();
    restoreCoordinator();
    ToolRegistry.unregister(workTool);
  });

  /** Run the plan to completion without ever advancing the barrier timers. */
  async function runWithoutAdvancingTimers(
    plan: Plan,
    whileRunning?: () => Promise<void>,
  ): Promise<PlanExecutionResult> {
    let settled = false;
    const execution = new DefaultPlanExecutor(timer)
      .executePlan(plan, 0, "android", "device-a", "base-uuid", undefined, "finish-current-step")
      .finally(() => {
        settled = true;
      });
    await whileRunning?.();
    await drainUntil(() => settled, {
      description: "the plan to settle without advancing the FakeTimer",
      maxTurns: 2_000,
    });
    expect(timer.now()).toBe(0);
    return execution;
  }

  // 0 B work, 1 B barrier, 2 A fails, 3 A barrier: the barrier B waits at has a LOWER plan
  // index than the step that really failed.
  const issuePlan = (barrierExtra: Record<string, unknown> = {}): Plan => ({
    name: "participant failure",
    devices: ["A", "B"],
    steps: [
      { tool: workTool, params: { device: "B" } },
      { tool: "barrier", params: { device: "B", lock: "ready", deviceCount: 2, ...barrierExtra } },
      { tool: workTool, params: { device: "A", fail: true } },
      { tool: "barrier", params: { device: "A", lock: "ready", deviceCount: 2 } },
    ],
  });

  test("a survivor parked at the barrier fails promptly and the real failure stays failedStep", async () => {
    const holdFailure = gate();
    workGates.set("A:fail", holdFailure);

    const result = await runWithoutAdvancingTimers(issuePlan(), async () => {
      // B is parked at the barrier before A fails.
      await drainUntil(() => barrierCalls.length === 1, { description: "B to park at barrier" });
      holdFailure.open();
    });

    expect(result.success).toBe(false);
    expect(result.failedStep).toMatchObject({
      device: "A",
      stepIndex: 2,
      tool: workTool,
      error: "real failure on A",
    });
    expect(result.deviceFailures?.map(({ device, stepIndex }) => ({ device, stepIndex }))).toEqual([
      { device: "A", stepIndex: 2 },
      { device: "B", stepIndex: 1 },
    ]);
    const consequence = result.deviceFailures?.[1];
    expect(consequence?.error).toContain('Barrier "ready" can no longer be satisfied');
    expect(consequence?.error).toContain('participant track "A" failed at step 2');
    expect(consequence?.error).toContain("real failure on A");
    expect(result.perDeviceResults?.get("B")?.failedStep?.stepIndex).toBe(1);
  });

  test("a survivor that reaches the barrier after the failure never arrives and fails the same way", async () => {
    const holdSurvivor = gate();
    workGates.set("B:ok", holdSurvivor);

    const result = await runWithoutAdvancingTimers(issuePlan(), async () => {
      // A has failed before B finishes its first step.
      await drainUntil(() => failedCalls.includes("A"), { description: "A to fail" });
      for (let turn = 0; turn < 100; turn++) {
        await Promise.resolve();
      }
      holdSurvivor.open();
    });

    expect(barrierCalls).toEqual([]);
    expect(result.failedStep).toMatchObject({ device: "A", stepIndex: 2 });
    expect(result.deviceFailures?.[1]).toMatchObject({ device: "B", stepIndex: 1 });
    expect(result.deviceFailures?.[1]?.error).toContain('participant track "A" failed at step 2');
  });

  test("an optional barrier the failed track would have joined is skipped, not failed", async () => {
    const holdFailure = gate();
    workGates.set("A:fail", holdFailure);
    const plan = issuePlan();
    plan.steps[1].optional = true;
    plan.steps.push({ tool: workTool, params: { device: "B" } });

    const result = await runWithoutAdvancingTimers(plan, async () => {
      await drainUntil(() => barrierCalls.length === 1, { description: "B to park at barrier" });
      holdFailure.open();
    });

    expect(result.failedStep).toMatchObject({ device: "A", stepIndex: 2 });
    expect(result.deviceFailures).toHaveLength(1);
    expect(result.perDeviceResults?.get("B")?.success).toBe(true);
    expect(result.perDeviceResults?.get("B")?.skippedSteps?.map((step) => step.stepIndex)).toEqual([
      1,
    ]);
  });

  test("a participant that is merely slow is still waited for", async () => {
    const holdSlow = gate();
    workGates.set("A:ok", holdSlow);
    const plan = issuePlan();
    plan.steps[2] = { tool: workTool, params: { device: "A" } };

    const result = await runWithoutAdvancingTimers(plan, async () => {
      await drainUntil(() => barrierCalls.length === 1, { description: "B to park at barrier" });
      // The barrier is still held open: nobody failed, so the survivor keeps waiting.
      for (let turn = 0; turn < 100; turn++) {
        await Promise.resolve();
      }
      expect(barrierCalls).toEqual(["device-b"]);
      holdSlow.open();
    });

    expect(result.success).toBe(true);
    expect(result.deviceFailures).toBeUndefined();
    expect(barrierCalls.sort()).toEqual(["device-a", "device-b"]);
  });

  test("tracks that never needed the failed track still run to completion", async () => {
    // B and C share a barrier; A fails and was never part of it.
    const plan: Plan = {
      name: "independent pair",
      devices: ["A", "B", "C"],
      steps: [
        { tool: "barrier", params: { device: "B", lock: "pair", deviceCount: 2 } },
        { tool: workTool, params: { device: "A", fail: true } },
        { tool: "barrier", params: { device: "C", lock: "pair", deviceCount: 2 } },
      ],
    };

    const result = await runWithoutAdvancingTimers(plan);

    expect(result.failedStep).toMatchObject({ device: "A", stepIndex: 1 });
    expect(result.deviceFailures).toHaveLength(1);
    expect(result.perDeviceResults?.get("B")?.success).toBe(true);
    expect(result.perDeviceResults?.get("C")?.success).toBe(true);
  });

  test("the failed track's own generation is the only one released", async () => {
    // Round one {B,C} is satisfiable; round two {B,A} is not, because A fails first.
    const plan: Plan = {
      name: "two rounds",
      devices: ["A", "B", "C"],
      steps: [
        { tool: "barrier", params: { device: "B", lock: "rounds", deviceCount: 2 } },
        { tool: "barrier", params: { device: "C", lock: "rounds", deviceCount: 2 } },
        { tool: workTool, params: { device: "A", fail: true } },
        { tool: "barrier", params: { device: "B", lock: "rounds", deviceCount: 2 } },
        { tool: "barrier", params: { device: "A", lock: "rounds", deviceCount: 2 } },
      ],
    };

    const result = await runWithoutAdvancingTimers(plan);

    expect(result.failedStep).toMatchObject({ device: "A", stepIndex: 2 });
    expect(result.perDeviceResults?.get("C")?.success).toBe(true);
    expect(result.perDeviceResults?.get("B")?.failedStep).toMatchObject({ stepIndex: 3 });
    expect(result.deviceFailures?.map(({ device }) => device)).toEqual(["A", "B"]);
  });
});
