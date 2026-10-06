import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { z } from "zod/v4";
import type { BootedDevice, Plan, PlanStep } from "../../src/models";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { registerCriticalSectionTools } from "../../src/server/criticalSectionTools";
import { CriticalSectionCoordinator } from "../../src/server/CriticalSectionCoordinator";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";
import { DefaultPlanExecutor } from "../../src/utils/plan/PlanExecutor";
import { FakeTimer } from "../fakes/FakeTimer";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";

// Compare both callers at their public boundaries using only registered fake tools.
describe("criticalSection shares plan step execution (#6535)", () => {
  const device: BootedDevice = { platform: "android", deviceId: "owner-id", name: "Owner" };
  const schema = z.object({
    device: z.string().optional(),
    deviceId: z.string().optional(),
    platform: z.string().optional(),
    sessionUuid: z.string().optional(),
  });
  let timer: FakeTimer;
  let executor: DefaultPlanExecutor;
  let restoreTools: () => void;
  let restoreCoordinator: () => void;
  let coordinator: CriticalSectionCoordinator;
  let restoreObserve: () => void;
  const next = mock(async () => ({ success: true }));
  const observe = mock(async (_device: BootedDevice, _params: unknown) =>
    createStructuredToolResponse({
      activeWindow: { appId: "owner.app" },
    }),
  );

  beforeEach(() => {
    restoreTools = preserveToolRegistry();
    timer = new FakeTimer();
    executor = new DefaultPlanExecutor(timer);
    coordinator = CriticalSectionCoordinator.createForTesting(new FakeTimer());
    restoreCoordinator = CriticalSectionCoordinator.setInstanceForTesting(coordinator);
    registerCriticalSectionTools(timer);
    next.mockClear();
    observe.mockClear();
    ToolRegistry.register("sharedNext", "Next fake step", schema, next);
    ToolRegistry.registerDeviceAware("observe", "Fake owner observation", schema, observe);
    const observationHandler = spyOn(
      ToolRegistry.getTool("observe")!,
      "handler",
    ).mockImplementation(async (params) => observe(device, params));
    restoreObserve = () => observationHandler.mockRestore();
  });

  afterEach(() => {
    coordinator.reset();
    restoreObserve();
    restoreCoordinator();
    restoreTools();
  });

  function runSection(steps: PlanStep[], signal?: AbortSignal) {
    return ToolRegistry.getToolForPlan("criticalSection")!.deviceAwareHandler!(
      device,
      { lock: "shared-step", deviceCount: 1, sessionUuid: "owner-session", steps },
      undefined,
      signal,
    );
  }

  function runPlan(steps: PlanStep[]) {
    const plan: Plan = { name: "shared-step", steps };
    return executor.executePlan(plan, 0, device.platform, device.deviceId);
  }

  test.each([false, true])(
    "optional failure continues in both callers (throws=%s)",
    async (throws) => {
      ToolRegistry.register("sharedFailure", "Failure", schema, async () => {
        if (throws) {
          throw new Error("missing element");
        }
        return { success: false, error: "missing element" };
      });
      const steps: PlanStep[] = [
        { tool: "sharedFailure", params: { device: "A" }, optional: true },
        { tool: "sharedNext", params: { device: "A" } },
      ];
      const topLevel = await runPlan(steps);
      const section = await runSection(steps);
      expect(topLevel.success).toBe(true);
      expect(topLevel.skippedSteps).toHaveLength(1);
      expect(JSON.parse(section.content[0].text)).toMatchObject({
        success: true,
        executedSteps: 2,
        warnings: ["step 1 (sharedFailure): optional step failed; skipped: missing element"],
      });
      expect(next).toHaveBeenCalledTimes(2);
      expect(observe).not.toHaveBeenCalled();
      expect(timer.getPendingTimeoutCount()).toBe(0);
      expect(timer.getSleepHistory()).toEqual([]);
    },
  );

  test.each([false, true])(
    "required failure has the plan error and owner observation (throws=%s)",
    async (throws) => {
      ToolRegistry.register("sharedFailure", "Failure", schema, async () => {
        if (throws) {
          throw new Error("missing element");
        }
        return { success: false, error: { message: "missing element" } };
      });
      const steps: PlanStep[] = [
        { tool: "sharedFailure", params: { device: "A" } },
        { tool: "sharedNext", params: { device: "A" } },
      ];
      const topLevel = await runPlan(steps);
      const failure: unknown = await runSection(steps).catch((error: unknown) => error);
      expect(failure).toMatchObject({
        failedStep: { ...topLevel.failedStep, failureObservation: expect.any(Object) },
        failureObservation: { activeWindow: { appId: "owner.app" } },
      });
      expect(topLevel.failedStep?.failureObservation?.activeWindow).toEqual({ appId: "owner.app" });
      expect(observe).toHaveBeenCalledTimes(2);
      expect(observe.mock.calls[1]?.[0]).toBe(device);
      expect(next).not.toHaveBeenCalled();
      expect(timer.getPendingTimeoutCount()).toBe(0);
      expect(timer.getSleepHistory()).toEqual([]);
    },
  );

  test("device-aware sub-steps receive injected params and stay pinned to the owner", async () => {
    const step = mock(async (_device: BootedDevice, _params: unknown) => ({ success: true }));
    ToolRegistry.registerDeviceAware("sharedParams", "Params", schema, step);
    await runSection([{ tool: "sharedParams", params: { device: "A" } }]);
    expect(step).toHaveBeenCalledWith(
      device,
      expect.objectContaining({
        device: "A",
        platform: "android",
        sessionUuid: "owner-session",
      }),
      undefined,
      undefined,
    );
  });

  test.each([false, true])(
    "unsupported result stays failed or skipped (optional=%s)",
    async (optional) => {
      ToolRegistry.register("sharedUnsupported", "Unsupported", schema, async () => ({
        content: [{ type: "text", text: "unsupported plain-text result" }],
      }));
      const steps: PlanStep[] = [
        { tool: "sharedUnsupported", params: { device: "A" }, optional },
        { tool: "sharedNext", params: { device: "A" } },
      ];
      const topLevel = await runPlan(steps);
      expect(topLevel.success).toBe(optional);
      if (optional) {
        const section = await runSection(steps);
        expect(JSON.parse(section.content[0].text).success).toBe(true);
        expect(next).toHaveBeenCalledTimes(2);
      } else {
        await expect(runSection(steps)).rejects.toMatchObject({
          failedStep: {
            error: topLevel.failedStep?.error,
            tool: "sharedUnsupported",
            stepIndex: 0,
          },
        });
        expect(next).not.toHaveBeenCalled();
      }
    },
  );
});
