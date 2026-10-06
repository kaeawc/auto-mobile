import { afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { z } from "zod/v4";
import type { BootedDevice } from "../../src/models";
import type { Plan } from "../../src/models/Plan";
import { registerBarrierTools } from "../../src/server/barrierTools";
import { CriticalSectionCoordinator } from "../../src/server/CriticalSectionCoordinator";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { DefaultPlanExecutor } from "../../src/utils/plan/PlanExecutor";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainUntil } from "../helpers/fakeTimerStepping";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();

/**
 * #10023 (per-label platform) x #10024 (waitFor-timeout failure record) x #10025 (participant
 * failure at a barrier): in a mixed-platform two-device plan, track A fails by a waitFor timeout
 * while track B is parked at a barrier. B fails promptly with the participant-failed message,
 * and A's timeout stays the plan's failedStep with its failure observation and warnings intact.
 */
const prefixTool = "interactionPrefix";
const devicesByLabel: Record<string, BootedDevice> = {
  A: { platform: "android", deviceId: "device-a", name: "Device A" },
  B: { platform: "ios", deviceId: "device-b", name: "Device B" },
};

describe("mixed-platform waitFor-timeout failure with a survivor parked at a barrier", () => {
  let timer: FakeTimer;
  let coordinator: CriticalSectionCoordinator;
  let restoreCoordinator: () => void;
  let restorePipeline: () => void;
  let barrierCalls: string[];
  let seenPlatforms: Record<string, string | undefined>;
  let releaseTimeout: () => void;
  let toolCallRepository: { toolCallRepository: unknown };
  let originalToolCallRepository: unknown;

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
    seenPlatforms = {};
    const gate = Promise.withResolvers<void>();
    releaseTimeout = gate.resolve;
    const awaitBarrier = coordinator.awaitBarrier.bind(coordinator);
    spyOn(coordinator, "awaitBarrier").mockImplementation((lock, deviceId, ...rest) => {
      barrierCalls.push(deviceId);
      return awaitBarrier(lock, deviceId, ...rest);
    });

    const record = (params: { device?: string; platform?: string }) => {
      seenPlatforms[`${params.device}`] = params.platform;
    };
    ToolRegistry.register(
      prefixTool,
      "Records the platform it ran with",
      z.object({ device: z.string(), platform: z.string().optional() }),
      async (params) => {
        record(params);
        return { success: true };
      },
    );
    // `observe` is the tool whose timeout response is summarized into the failure
    // observation without touching a device (#10024).
    ToolRegistry.register(
      "observe",
      "observe that times out after the survivor parks",
      z.object({ device: z.string(), platform: z.string().optional(), waitFor: z.any() }),
      async (params) => {
        record(params);
        await gate.promise;
        return createStructuredToolResponse({
          updatedAt: 0,
          screenSize: { width: 100, height: 100 },
          systemInsets: { left: 0, top: 0, right: 0, bottom: 0 },
          awaitTimeout: true,
          awaitDuration: 5000,
          warnings: ["screen was animating"],
        });
      },
    );
    for (const name of [prefixTool, "observe"]) {
      (ToolRegistry.getTool(name) as { requiresDevice: boolean }).requiresDevice = true;
    }

    // Same no-op pipeline as planExecutorParticipantFailure.test.ts (no real DB, no device I/O).
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
      planLifecycleManager: { afterExecution: async () => {} },
    });
  });

  afterEach(() => {
    restorePipeline();
    toolCallRepository.toolCallRepository = originalToolCallRepository;
    coordinator.reset();
    restoreCoordinator();
    ToolRegistry.unregister(prefixTool);
    ToolRegistry.unregister("observe");
  });

  const plan: Plan = {
    name: "mixed timeout then barrier",
    devices: [
      { label: "A", platform: "android" },
      { label: "B", platform: "ios" },
    ],
    steps: [
      { tool: prefixTool, params: { device: "B" } },
      { tool: "barrier", params: { device: "B", lock: "ready", deviceCount: 2 } },
      { tool: "observe", params: { device: "A", waitFor: { text: "Done" } } },
      { tool: "barrier", params: { device: "A", lock: "ready", deviceCount: 2 } },
    ],
  };

  test("B fails promptly as a consequence; A's timeout keeps failedStep, observation and warnings", async () => {
    let settled = false;
    const execution = new DefaultPlanExecutor(timer)
      .executePlan(plan, 0, "android", "device-a", "base-uuid", undefined, "finish-current-step")
      .finally(() => {
        settled = true;
      });
    await drainUntil(() => barrierCalls.length === 1, { description: "B to park at barrier" });
    releaseTimeout();
    await drainUntil(() => settled, {
      description: "the plan to settle without advancing the FakeTimer",
      maxTurns: 2_000,
    });
    const result = await execution;

    // The barrier timer was never advanced, so B did not wait out its timeout.
    expect(timer.now()).toBe(0);
    expect(seenPlatforms).toEqual({ A: "android", B: "ios" });

    expect(result.success).toBe(false);
    expect(result.failedStep).toMatchObject({
      device: "A",
      stepIndex: 2,
      tool: "observe",
      error: "observe waitFor timed out after 5000ms",
      failureObservation: { awaitTimeout: true },
    });
    expect(result.warnings).toEqual([
      { stepIndex: 2, tool: "observe", device: "A", warnings: ["screen was animating"] },
    ]);

    expect(result.deviceFailures?.map(({ device, stepIndex }) => ({ device, stepIndex }))).toEqual([
      { device: "A", stepIndex: 2 },
      { device: "B", stepIndex: 1 },
    ]);
    const consequence = result.deviceFailures?.[1]?.error;
    expect(consequence).toContain('Barrier "ready" can no longer be satisfied');
    expect(consequence).toContain('participant track "A" failed at step 2 (observe)');
    expect(consequence).toContain("observe waitFor timed out after 5000ms");
    // B's consequence never replaces A's real failure on the per-device record either.
    expect(result.perDeviceResults?.get("A")?.failedStep?.error).toBe(
      "observe waitFor timed out after 5000ms",
    );
    expect(result.perDeviceResults?.get("B")?.failedStep?.stepIndex).toBe(1);
  });
});
