import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import { Plan } from "../../src/models/Plan";
import { DefaultPlanExecutor } from "../../src/utils/plan/PlanExecutor";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { registerObserveTools } from "../../src/server/observeTools";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";
import { INTERNAL_NO_DIFF_PARAM } from "../../src/server/internalToolCall";
import { OPERATION_CANCELLED_MESSAGE } from "../../src/utils/constants";
import { defaultTimer } from "../../src/utils/SystemTimer";
import { DeviceLostError } from "../../src/server/deviceLossOutcome";
import type { SessionToolProfileService } from "../../src/features/toolCapabilities/SessionToolProfileService";

interface CapturedCall {
  params: Record<string, unknown>;
  signal?: AbortSignal;
}

describe("PlanExecutor executeStep refactor", () => {
  let planExecutor: DefaultPlanExecutor;
  let okCalls: CapturedCall[];

  beforeEach(() => {
    planExecutor = new DefaultPlanExecutor();
    okCalls = [];

    const deviceSchema = z.object({
      platform: z.string().optional(),
      deviceId: z.string().optional(),
      sessionUuid: z.string().optional(),
      device: z.string().optional(),
      label: z.string().optional(),
      waitFor: z.any().optional(),
    });

    ToolRegistry.register(
      "executeStepRefactorOk",
      "succeeds",
      deviceSchema,
      mock(async (params: Record<string, unknown>, _progress, signal?: AbortSignal) => {
        okCalls.push({ params, signal });
        return createStructuredToolResponse({ success: true });
      })
    );
    (ToolRegistry.getTool("executeStepRefactorOk") as { requiresDevice: boolean }).requiresDevice = true;

    ToolRegistry.register(
      "executeStepRefactorFail",
      "fails",
      deviceSchema,
      mock(async () => createStructuredToolResponse({ success: false, error: "button missing" }))
    );
    (ToolRegistry.getTool("executeStepRefactorFail") as { requiresDevice: boolean }).requiresDevice = true;

    ToolRegistry.register(
      "observe",
      "failure observation",
      deviceSchema,
      mock(async () =>
        createStructuredToolResponse({
          updatedAt: 0,
          activeWindow: { appId: "com.example" },
          elements: {
            text: [{ text: "Failure Screen", resourceId: "com.example:id/error" }],
          },
        })
      )
    );
    (ToolRegistry.getTool("observe") as { requiresDevice: boolean }).requiresDevice = true;
  });

  afterEach(() => {
    registerObserveTools();
  });

  test("successes share normalized params through sequential and device-track execution", async () => {
    const sequentialPlan: Plan = {
      name: "sequential-success",
      steps: [{ tool: "executeStepRefactorOk", params: {} }],
    };
    const parallelPlan: Plan = {
      name: "parallel-success",
      devices: ["device-a"],
      steps: [{ tool: "executeStepRefactorOk", params: { device: "device-a" } }],
    };

    const sequentialResult = await planExecutor.executePlan(sequentialPlan, 0, "android", "emulator-5554");
    const parallelResult = await planExecutor.executePlan(
      parallelPlan,
      0,
      "ios",
      "sim-1",
      "session-1"
    );

    expect(sequentialResult.success).toBe(true);
    expect(sequentialResult.executedSteps).toBe(1);
    expect(sequentialResult.debug?.steps[0].status).toBe("completed");
    expect(parallelResult.success).toBe(true);
    expect(parallelResult.executedSteps).toBe(1);
    expect(parallelResult.perDeviceResults?.get("device-a")?.success).toBe(true);
    expect(okCalls).toHaveLength(2);
    expect(okCalls[0].params).toMatchObject({
      platform: "android",
      deviceId: "emulator-5554",
      [INTERNAL_NO_DIFF_PARAM]: true,
    });
    expect(okCalls[1].params).toMatchObject({
      platform: "ios",
      device: "device-a",
      sessionUuid: "session-1",
      [INTERNAL_NO_DIFF_PARAM]: true,
    });
    expect(okCalls[1].params).not.toHaveProperty("deviceId");
  });

  test("sequential failures still include debug details and failure observation", async () => {
    const plan: Plan = {
      name: "sequential-failure",
      steps: [{ tool: "executeStepRefactorFail", params: {} }],
    };

    const result = await planExecutor.executePlan(plan, 0, "android", "emulator-5554");

    expect(result.success).toBe(false);
    expect(result.executedSteps).toBe(0);
    expect(result.failedStep?.tool).toBe("executeStepRefactorFail");
    expect(result.failedStep?.error).toBe("button missing");
    expect(result.failedStep?.failureObservation?.visibleTextsSample).toContain("Failure Screen");
    expect(result.debug?.steps).toHaveLength(1);
    expect(result.debug?.steps[0].status).toBe("failed");
    expect(result.debug?.steps[0].details.failureObservation).toBeDefined();
  });

  test("device-track failures use the same failure and observation pipeline", async () => {
    const plan: Plan = {
      name: "parallel-failure",
      devices: ["device-a"],
      steps: [{ tool: "executeStepRefactorFail", params: { device: "device-a" } }],
    };

    const result = await planExecutor.executePlan(plan, 0, "ios", "sim-1");

    expect(result.success).toBe(false);
    expect(result.executedSteps).toBe(0);
    expect(result.failedStep?.device).toBe("device-a");
    expect(result.failedStep?.tool).toBe("executeStepRefactorFail");
    expect(result.failedStep?.error).toBe("button missing");
    expect(result.failedStep?.failureObservation?.visibleTextsSample).toContain("Failure Screen");
    expect(result.perDeviceResults?.get("device-a")?.failedStep?.failureObservation).toBeDefined();
  });

  test("propagates confirmed device loss through sequential and parallel plans", async () => {
    ToolRegistry.register(
      "executeStepRefactorDeviceLost",
      "loses its device",
      z.object({
        platform: z.string().optional(),
        device: z.string().optional(),
        deviceId: z.string().optional(),
        sessionUuid: z.string().optional(),
      }),
      mock(async () => {
        throw new DeviceLostError("emulator-5554", "device-disconnected:emulator-5554");
      }),
    );
    (ToolRegistry.getTool("executeStepRefactorDeviceLost") as { requiresDevice: boolean }).requiresDevice = true;

    await expect(
      planExecutor.executePlan({
        name: "sequential-device-lost",
        steps: [{ tool: "executeStepRefactorDeviceLost", params: {} }],
      }, 0, "android", "emulator-5554", "session-a"),
    ).rejects.toThrow("device-disconnected:emulator-5554");

    await expect(
      planExecutor.executePlan({
        name: "parallel-device-lost",
        devices: ["device-a"],
        steps: [{ tool: "executeStepRefactorDeviceLost", params: { device: "device-a" } }],
      }, 0, "android", "emulator-5554", "session-a"),
    ).rejects.toThrow("device-disconnected:emulator-5554");
  });

  test("multi-device immediate abort uses AbortSignal.any and cancels sibling tracks", async () => {
    const originalAny = AbortSignal.any;
    const anyCalls: AbortSignal[][] = [];
    const anyReturnSignals: AbortSignal[] = [];
    (AbortSignal as any).any = (signals: AbortSignal[]) => {
      anyCalls.push([...signals]);
      const combined = originalAny(signals);
      anyReturnSignals.push(combined);
      return combined;
    };

    let siblingSignal: AbortSignal | undefined;
    ToolRegistry.register(
      "executeStepRefactorAbortWait",
      "waits for abort",
      z.object({
        platform: z.string().optional(),
        deviceId: z.string().optional(),
        sessionUuid: z.string().optional(),
        device: z.string().optional(),
      }),
      mock(async (_params: Record<string, unknown>, _progress, signal?: AbortSignal) => {
        siblingSignal = signal;
        if (!signal) {
          throw new Error("expected signal");
        }
        await new Promise<void>((resolve, reject) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          const timeout = defaultTimer.setTimeout(() => reject(new Error("abort not observed")), 50);
          signal.addEventListener(
            "abort",
            () => {
              defaultTimer.clearTimeout(timeout);
              resolve();
            },
            { once: true }
          );
        });
        return createStructuredToolResponse({ success: true });
      })
    );
    (ToolRegistry.getTool("executeStepRefactorAbortWait") as { requiresDevice: boolean }).requiresDevice = true;

    try {
      const externalAbort = new AbortController();
      const plan: Plan = {
        name: "parallel-abort",
        devices: ["device-a", "device-b"],
        steps: [
          { tool: "executeStepRefactorFail", params: { device: "device-a" } },
          { tool: "executeStepRefactorAbortWait", params: { device: "device-b" } },
        ],
      };

      const result = await planExecutor.executePlan(
        plan,
        0,
        "ios",
        "sim-1",
        undefined,
        externalAbort.signal
      );

      const siblingFailure = result.perDeviceResults?.get("device-b")?.failedStep;
      expect(anyCalls).toHaveLength(1);
      expect(anyCalls[0][0]).toBe(externalAbort.signal);
      expect(siblingSignal).toBe(anyReturnSignals[0]);
      expect(siblingSignal?.aborted).toBe(true);
      expect(siblingFailure?.error).toContain(OPERATION_CANCELLED_MESSAGE);
      expect(siblingFailure?.failureObservation).toBeUndefined();
    } finally {
      (AbortSignal as any).any = originalAny;
    }
  });

  test("rejects a base-profile-disabled labeled device step before target resolution", async () => {
    const clipboardHandler = mock(async () => createStructuredToolResponse({ success: true }));
    ToolRegistry.registerDeviceAware(
      "clipboard",
      "clipboard",
      z.object({
        device: z.string(),
        sessionUuid: z.string().optional(),
      }),
      clipboardHandler
    );
    const profileService: Pick<SessionToolProfileService, "isEnabled"> = {
      isEnabled: async (_sessionUuid, capability) => capability !== "clipboard",
    };
    const resolveExecutionTarget = mock(async () => {
      throw new Error("target resolution should not run");
    });
    const restorePipelineOverrides = ToolRegistry.setPipelineOverridesForTesting({
      executionTargetResolver: { resolveExecutionTarget },
    });

    try {
      const result = await planExecutor.executePlan(
        {
          name: "capability-denied-step",
          devices: ["B"],
          steps: [{ tool: "clipboard", params: { device: "B" } }],
        },
        0,
        "android",
        "emulator-5554",
        "session-1",
        undefined,
        undefined,
        { sessionToolProfileService: profileService }
      );

      expect(result.success).toBe(false);
      expect(result.failedStep).toMatchObject({
        stepIndex: 0,
        tool: "clipboard",
      });
      expect(result.failedStep?.error).toContain("requires the 'clipboard' capability");
      expect(clipboardHandler).not.toHaveBeenCalled();
      expect(resolveExecutionTarget).not.toHaveBeenCalled();
    } finally {
      restorePipelineOverrides();
    }
  });

  test("uses the execution session instead of a sessionUuid supplied by the plan", async () => {
    const clipboardHandler = mock(async () => createStructuredToolResponse({ success: true }));
    ToolRegistry.register(
      "clipboard",
      "clipboard",
      z.object({ sessionUuid: z.string().optional() }),
      clipboardHandler
    );
    const profileService: Pick<SessionToolProfileService, "isEnabled"> = {
      isEnabled: async sessionUuid => sessionUuid === "enabled-session",
    };

    const result = await planExecutor.executePlan(
      {
        name: "session-override-denied-step",
        steps: [{ tool: "clipboard", params: { sessionUuid: "enabled-session" } }],
      },
      0,
      "android",
      "emulator-5554",
      "disabled-session",
      undefined,
      undefined,
      { sessionToolProfileService: profileService }
    );

    expect(result.success).toBe(false);
    expect(result.failedStep?.error).toContain("requires the 'clipboard' capability");
    expect(clipboardHandler).not.toHaveBeenCalled();
  });

  test("uses the device-track execution session instead of a sessionUuid supplied by the plan", async () => {
    const clipboardHandler = mock(async () => createStructuredToolResponse({ success: true }));
    ToolRegistry.register(
      "clipboard",
      "clipboard",
      z.object({
        device: z.string(),
        sessionUuid: z.string().optional(),
      }),
      clipboardHandler
    );
    const profileService: Pick<SessionToolProfileService, "isEnabled"> = {
      isEnabled: async sessionUuid => sessionUuid === "enabled-session",
    };

    const result = await planExecutor.executePlan(
      {
        name: "parallel-session-override-denied-step",
        devices: ["device-a"],
        steps: [{
          tool: "clipboard",
          params: { device: "device-a", sessionUuid: "enabled-session" },
        }],
      },
      0,
      "android",
      "emulator-5554",
      "disabled-session",
      undefined,
      undefined,
      { sessionToolProfileService: profileService }
    );

    expect(result.success).toBe(false);
    expect(result.failedStep?.error).toContain("requires the 'clipboard' capability");
    expect(clipboardHandler).not.toHaveBeenCalled();
  });

  test("executes a capability-enabled step", async () => {
    const clipboardHandler = mock(async () => createStructuredToolResponse({ success: true }));
    ToolRegistry.register(
      "clipboard",
      "clipboard",
      z.object({
        platform: z.string().optional(),
        sessionUuid: z.string().optional(),
      }),
      clipboardHandler
    );
    (ToolRegistry.getTool("clipboard") as { requiresDevice: boolean }).requiresDevice = true;
    const profileService: Pick<SessionToolProfileService, "isEnabled"> = {
      isEnabled: async () => true,
    };

    const result = await planExecutor.executePlan(
      {
        name: "capability-enabled-step",
        steps: [{ tool: "clipboard", params: {} }],
      },
      0,
      "android",
      "emulator-5554",
      "session-1",
      undefined,
      undefined,
      { sessionToolProfileService: profileService }
    );

    expect(result.success).toBe(true);
    expect(clipboardHandler).toHaveBeenCalledTimes(1);
  });
});
