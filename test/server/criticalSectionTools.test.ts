import { drainMicrotasks } from "../helpers/fakeTimerStepping";
import { createStructuredToolResponse, getStructuredPayload } from "../../src/utils/toolUtils";
import { DefaultPlanExecutor } from "../../src/utils/plan/PlanExecutor";
import { FakeTimer } from "../fakes/FakeTimer";
import { isolateToolRegistry, preserveToolRegistry } from "../helpers/withTemporaryTool";
import { afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { registerCriticalSectionTools } from "../../src/server/criticalSectionTools";
import { CriticalSectionCoordinator } from "../../src/server/CriticalSectionCoordinator";
import { ActionableError, type BootedDevice } from "../../src/models";
import {
  DeviceLostError,
  isDeviceLostError,
  rememberDeviceLossAbort,
} from "../../src/models/DeviceLostError";
import { z } from "zod/v4";
import { setDebugModeEnabled } from "../../src/utils/debug";
import { logger } from "../../src/utils/logger";
import { serverConfig } from "../../src/utils/ServerConfig";
import type { SessionToolSelectionService } from "../../src/features/toolSelection/SessionToolSelectionService";
import { runWithToolSelectionContext } from "../../src/features/toolSelection/toolSelectionContext";
import { throwIfAborted } from "../../src/utils/toolUtils";

isolateToolRegistry();

describe("criticalSection tool", () => {
  beforeAll(() => {
    // Register the tool if not already registered
    if (!ToolRegistry.getToolForPlan("criticalSection")) {
      registerCriticalSectionTools();
    }
  });

  beforeEach(() => {
    // Reset coordinator before each test
    CriticalSectionCoordinator.getInstance().reset();
    setDebugModeEnabled(false);
    serverConfig.setEmbeddedSdkEnabled(false);
  });

  test("rejects every mismatched sub-step up front before any sub-step runs", async () => {
    const timer = new FakeTimer();
    const coordinator = CriticalSectionCoordinator.createForTesting(timer);
    const restore = CriticalSectionCoordinator.setInstanceForTesting(coordinator);
    const step = mock(async () => ({ success: true }));
    ToolRegistry.register("ownerLabelProbe", "Owner probe", z.object({ device: z.string() }), step);
    const device: BootedDevice = { platform: "android", deviceId: "serial-for-A", name: "A" };
    try {
      const tool = ToolRegistry.getToolForPlan("criticalSection")!;
      await expect(
        tool.deviceAwareHandler!(device, {
          lock: "owner",
          device: "A",
          deviceCount: 1,
          steps: [
            { tool: "ownerLabelProbe", params: { device: "A" } },
            { tool: "ownerLabelProbe", params: { device: "B" } },
          ],
        }),
      ).rejects.toThrow(ActionableError);
      expect(step).not.toHaveBeenCalled();
      expect(timer.getPendingTimeouts()).toEqual([]);
      await expect(
        tool.deviceAwareHandler!(device, {
          lock: "owner",
          device: "A",
          deviceCount: 1,
          steps: [{ tool: "ownerLabelProbe", params: { device: "B" } }],
        }),
      ).rejects.toThrow(
        'steps[0] (ownerLabelProbe): device="B" differs from criticalSection owner device="A"',
      );
      expect(step).not.toHaveBeenCalled();
    } finally {
      coordinator.forceCleanup("owner");
      restore();
    }
  });

  test("owner mismatch immediately rejects a parked peer in the same namespace", async () => {
    const timer = new FakeTimer();
    const coordinator = CriticalSectionCoordinator.createForTesting(timer);
    const restore = CriticalSectionCoordinator.setInstanceForTesting(coordinator);
    let peerError: unknown;
    const peer = coordinator.awaitBarrier("mismatch", "peer", 2, 120000, "plan").then(
      () => "unexpected success",
      (error: unknown) => {
        peerError = error;
      },
    );
    try {
      await expect(
        ToolRegistry.getToolForPlan("criticalSection")!.deviceAwareHandler!(
          { platform: "android", deviceId: "A", name: "A" },
          {
            lock: "mismatch",
            device: "A",
            deviceCount: 2,
            __lockNamespace: "plan",
            steps: [{ tool: "tapOn", params: { device: "B" } }],
          },
        ),
      ).rejects.toThrow('differs from criticalSection owner device="A"');
      await drainMicrotasks(40);
      expect(peerError).toBeInstanceOf(ActionableError);
      expect(timer.getPendingTimeouts()).toEqual([]);
    } finally {
      coordinator.forceCleanup("mismatch", "plan");
      await peer;
      restore();
    }
  });

  for (const owner of ["A", undefined]) {
    test(`runs owner-labeled sub-steps when owner is ${owner ?? "unknown"}`, async () => {
      const coordinator = CriticalSectionCoordinator.createForTesting(new FakeTimer());
      const restore = CriticalSectionCoordinator.setInstanceForTesting(coordinator);
      const step = mock(async () => ({ success: true }));
      ToolRegistry.register(
        "sameOwnerProbe",
        "Owner probe",
        z.object({ device: z.string() }),
        step,
      );
      try {
        const tool = ToolRegistry.getToolForPlan("criticalSection")!;
        await tool.deviceAwareHandler!(
          { platform: "android", deviceId: "serial-for-A", name: "A" },
          {
            lock: "owner",
            device: owner,
            deviceCount: 1,
            steps: [{ tool: "sameOwnerProbe", params: { device: "A" } }],
          },
        );
        expect(step).toHaveBeenCalledTimes(1);
      } finally {
        coordinator.forceCleanup("owner");
        restore();
      }
    });
  }

  for (const recoverLoss of [true, false]) {
    for (const alreadyAborted of [false, true]) {
      test(`hidden ${recoverLoss ? "device loss" : "cancellation"} is an Error (${alreadyAborted ? "before arrival" : "parked handler"})`, async () => {
        const timer = new FakeTimer();
        const coordinator = CriticalSectionCoordinator.createForTesting(timer);
        const restore = CriticalSectionCoordinator.setInstanceForTesting(coordinator);
        const controller = new AbortController();
        const loss = new DeviceLostError("A", "disconnected");
        Object.defineProperty(controller.signal, "reason", { get: () => undefined });
        if (recoverLoss) {
          rememberDeviceLossAbort(controller.signal, loss);
        }
        if (alreadyAborted) {
          controller.abort(loss);
        }
        try {
          const pending = ToolRegistry.getToolForPlan("criticalSection")!.deviceAwareHandler!(
            { platform: "android", deviceId: "A", name: "A" },
            {
              lock: "hidden-abort",
              device: "A",
              deviceCount: 2,
              steps: [{ tool: "tapOn", params: { device: "A" } }],
            },
            undefined,
            controller.signal,
          ).then(
            () => "unexpected success",
            (error: unknown) => error,
          );
          if (!alreadyAborted) {
            controller.abort(loss);
          }
          const error = await pending;
          expect(error).toBeInstanceOf(Error);
          if (recoverLoss) {
            expect(error).toBe(loss);
          } else {
            expect(error).toEqual(new Error("Operation cancelled"));
          }
          expect(timer.getPendingTimeouts()).toEqual([]);
        } finally {
          coordinator.forceCleanup("hidden-abort");
          restore();
        }
      });
    }
  }

  test("preserves an already-aborted handler reason without creating timers", async () => {
    const timer = new FakeTimer();
    const coordinator = CriticalSectionCoordinator.createForTesting(timer);
    const restore = CriticalSectionCoordinator.setInstanceForTesting(coordinator);
    const controller = new AbortController();
    const reason = new Error("client cancelled");
    controller.abort(reason);
    try {
      const error = await ToolRegistry.getToolForPlan("criticalSection")!.deviceAwareHandler!(
        { platform: "android", deviceId: "A", name: "A" },
        {
          lock: "already-aborted",
          device: "A",
          deviceCount: 2,
          steps: [{ tool: "tapOn", params: { device: "A" } }],
        },
        undefined,
        controller.signal,
      ).then(
        () => undefined,
        (rejection: unknown) => rejection,
      );
      expect(error).toBe(reason);
      expect(timer.getPendingTimeouts()).toEqual([]);
    } finally {
      restore();
    }
  });

  test("abort rejects a parked section with the device loss reason before running steps", async () => {
    const timer = new FakeTimer();
    const coordinator = CriticalSectionCoordinator.createForTesting(timer);
    const restore = CriticalSectionCoordinator.setInstanceForTesting(coordinator);
    const controller = new AbortController();
    const loss = new DeviceLostError("A", "disconnected");
    const step = mock(async () => ({ success: true }));
    ToolRegistry.register(
      "abortSectionProbe",
      "Abort probe",
      z.object({ device: z.string() }),
      step,
    );
    let error: unknown;
    const pending = ToolRegistry.getToolForPlan("criticalSection")!.deviceAwareHandler!(
      { platform: "android", deviceId: "A", name: "A" },
      {
        lock: "abort",
        device: "A",
        deviceCount: 2,
        steps: [{ tool: "abortSectionProbe", params: { device: "A" } }],
      },
      undefined,
      controller.signal,
    ).then(undefined, (rejection: unknown) => {
      error = rejection;
    });
    controller.abort(loss);
    await drainMicrotasks(40);
    try {
      expect(error).toBe(loss);
      expect(step).not.toHaveBeenCalled();
      expect(timer.getPendingTimeouts()).toEqual([]);
    } finally {
      coordinator.forceCleanup("abort");
      await pending;
      restore();
    }
  });

  const envelopeCases: Array<{
    name: string;
    response: unknown;
    success: boolean;
    error?: string;
  }> = [
    {
      name: "direct wait timeout",
      response: { success: true, awaitTimeout: true, awaitDuration: 50 },
      success: false,
      error: "envelopeVerdictProbe waitFor timed out after 50ms",
    },
    {
      name: "text wait timeout",
      response: { content: [{ type: "text", text: '{"awaitTimeout":true,"awaitDuration":50}' }] },
      success: false,
      error: "envelopeVerdictProbe waitFor timed out after 50ms",
    },
    {
      name: "hoisted success with structured wait timeout",
      response: createStructuredToolResponse({
        success: true,
        awaitTimeout: true,
        awaitDuration: 50,
      }),
      success: false,
      error: "envelopeVerdictProbe waitFor timed out after 50ms",
    },
    {
      name: "numeric awaitTimeout input echo",
      response: createStructuredToolResponse({
        success: true,
        awaitTimeout: 5000,
        timedOut: true,
        matched: false,
      }),
      success: true,
    },
    {
      name: "unrelated timedOut and matched fields",
      response: { success: true, timedOut: true, matched: false },
      success: true,
    },
    {
      name: "non JSON",
      response: { content: [{ type: "text", text: "not json" }] },
      success: false,
      error: 'Tool "envelopeVerdictProbe" result could not be interpreted',
    },
    {
      name: "truncated JSON",
      response: { content: [{ type: "text", text: '{"success":tr' }] },
      success: false,
      error: 'Tool "envelopeVerdictProbe" result could not be interpreted',
    },
    {
      name: "JSON success",
      response: { content: [{ type: "text", text: '{"success":true}' }] },
      success: true,
    },
    {
      name: "JSON failure",
      response: {
        content: [{ type: "text", text: '{"success":false,"error":"original failure"}' }],
      },
      success: false,
      error: "original failure",
    },
    {
      name: "isError text",
      response: { isError: true, content: [{ type: "text", text: "Error: original failure" }] },
      success: false,
      error: "Error: original failure",
    },
    {
      name: "isError JSON without success",
      response: {
        isError: true,
        content: [{ type: "text", text: '{"error":"original failure"}' }],
      },
      success: false,
      error: "original failure",
    },
    {
      name: "image only",
      response: { content: [{ type: "image", data: "synthetic", mimeType: "image/png" }] },
      success: true,
    },
    {
      name: "JSON without success",
      response: { content: [{ type: "text", text: '{"enabled":true}' }] },
      success: true,
    },
    {
      name: "structured without success",
      response: {
        structuredContent: { updatedAt: 0 },
        content: [{ type: "text", text: "not json" }],
      },
      success: true,
    },
    {
      name: "structured failure",
      response: { structuredContent: { success: false, error: "original failure" } },
      success: false,
      error: "original failure",
    },
    {
      name: "image before failure",
      response: {
        content: [
          { type: "image", data: "synthetic", mimeType: "image/png" },
          { type: "text", text: '{"success":false,"error":"original failure"}' },
        ],
      },
      success: false,
      error: "original failure",
    },
  ];

  for (const fixture of envelopeCases) {
    test(`plan and criticalSection agree on ${fixture.name}`, async () => {
      const calls: string[] = [];
      ToolRegistry.register(
        "envelopeVerdictProbe",
        "synthetic envelope",
        z.object({}).passthrough(),
        async () => {
          calls.push("probe");
          return fixture.response;
        },
      );
      ToolRegistry.register(
        "envelopeNextProbe",
        "next step",
        z.object({}).passthrough(),
        async () => {
          calls.push("next");
          return { success: true };
        },
      );
      const steps = [
        { tool: "envelopeVerdictProbe", params: { device: "A" } },
        { tool: "envelopeNextProbe", params: { device: "A" } },
      ];
      const plan = await new DefaultPlanExecutor(new FakeTimer()).executePlan(
        { name: "envelope verdict", steps },
        0,
      );
      const section = ToolRegistry.getToolForPlan("criticalSection")!;
      const execution = section.deviceAwareHandler!(
        { platform: "android", deviceId: "synthetic-device", name: "Synthetic" },
        { lock: "envelope-verdict", deviceCount: 1, steps },
      );
      if (fixture.success) {
        expect(getStructuredPayload(await execution)?.success).toBe(true);
      } else {
        await expect(execution).rejects.toThrow(fixture.error);
      }
      expect(plan.success).toBe(fixture.success);
      expect(plan.debug?.steps[0].status).toBe(fixture.success ? "completed" : "failed");
      if (fixture.error) {
        expect(plan.failedStep?.error).toBe(fixture.error);
      }
      expect(calls).toEqual(
        fixture.success ? ["probe", "next", "probe", "next"] : ["probe", "probe"],
      );
    });
  }

  describe("waitFor verdicts", () => {
    const device: BootedDevice = {
      platform: "android",
      deviceId: "wait-device",
      name: "Wait Device",
    };
    let coordinator: CriticalSectionCoordinator;
    let restoreCoordinator: () => void;
    let restoreTools: () => void;
    const nextStep = mock(async () => ({ success: true }));

    beforeEach(() => {
      restoreTools = preserveToolRegistry();
      coordinator = CriticalSectionCoordinator.createForTesting(new FakeTimer());
      restoreCoordinator = CriticalSectionCoordinator.setInstanceForTesting(coordinator);
      nextStep.mockClear();
      ToolRegistry.register("afterWait", "next step", z.object({}).passthrough(), nextStep);
    });

    afterEach(() => {
      coordinator.reset();
      restoreCoordinator();
      restoreTools();
    });

    const runSteps = (tool: string, optional = false, withNext = false) => {
      const section = ToolRegistry.getToolForPlan("criticalSection")!;
      return section.deviceAwareHandler!(
        device,
        section.schema.parse({
          lock: "wait-lock",
          deviceCount: 1,
          steps: [
            { tool, params: { device: "A", waitFor: { text: "Pay" } }, optional },
            ...(withNext ? [{ tool: "afterWait", params: { device: "A" } }] : []),
          ],
        }),
      );
    };

    test.each(["observe", "openLink"])("rejects a required %s waitFor timeout", async (tool) => {
      ToolRegistry.register(tool, "wait timeout", z.object({}).passthrough(), async () =>
        createStructuredToolResponse({
          success: true,
          awaitTimeout: true,
          timedOut: true,
          matched: false,
          awaitDuration: 5000,
        }),
      );
      await expect(runSteps(tool)).rejects.toThrow(
        `Failed at step 1/1 (${tool}): ${tool} waitFor timed out after 5000ms`,
      );
    });

    test("fails an unsupported setPosture sub-step with its message", async () => {
      ToolRegistry.register(
        "setPosture",
        "unsupported posture",
        z.object({}).passthrough(),
        async () =>
          createStructuredToolResponse({ message: "not foldable", status: "unsupported" }),
      );
      await expect(runSteps("setPosture", false, true)).rejects.toThrow(
        "Failed at step 1/2 (setPosture): not foldable",
      );
      expect(nextStep).not.toHaveBeenCalled();
    });

    test.each(["observe", "openLink"])(
      "skips an optional %s timeout with a warning",
      async (tool) => {
        ToolRegistry.register(tool, "wait timeout", z.object({}).passthrough(), async () =>
          createStructuredToolResponse({ success: true, awaitTimeout: true, awaitDuration: 5000 }),
        );
        const result = getStructuredPayload(await runSteps(tool, true, true));
        expect(result).toMatchObject({
          success: true,
          executedSteps: 2,
          warnings: [
            `step 1 (${tool}): optional step failed; skipped: ${tool} waitFor timed out after 5000ms`,
          ],
        });
        expect(nextStep).toHaveBeenCalledTimes(1);
      },
    );

    for (const tool of ["observe", "openLink"]) {
      test.each([false, undefined])(
        "passes satisfied " + tool + " waitFor with awaitTimeout=%s",
        async (awaitTimeout) => {
          ToolRegistry.register(tool, "satisfied wait", z.object({}).passthrough(), async () =>
            createStructuredToolResponse({
              success: true,
              awaitTimeout,
              matched: true,
              timedOut: false,
            }),
          );
          const result = getStructuredPayload(await runSteps(tool, false, true));
          expect(result).toMatchObject({ success: true, executedSteps: 2 });
          expect(result?.warnings).toBeUndefined();
          expect(nextStep).toHaveBeenCalledTimes(1);
        },
      );
    }
  });

  test("tool is registered with correct schema", () => {
    const tool = ToolRegistry.getToolForPlan("criticalSection");

    expect(tool).toBeDefined();
    expect(tool?.name).toBe("criticalSection");
    expect(tool?.description).toContain("Synchronize multiple devices");
    expect(tool?.deviceAwareHandler).toBeDefined();
  });

  test("validates schema with valid parameters", () => {
    const tool = ToolRegistry.getToolForPlan("criticalSection");
    expect(tool).toBeDefined();

    const validParams = {
      lock: "test-lock",
      deviceCount: 2,
      steps: [
        {
          tool: "observe",
          params: { device: "A" },
        },
      ],
    };

    // Should not throw
    const parsed = tool!.schema.parse(validParams);
    expect(parsed.lock).toBe("test-lock");
    expect(parsed.deviceCount).toBe(2);
    expect(parsed.steps.length).toBe(1);
  });

  test("rejects invalid schema - missing required fields", () => {
    const tool = ToolRegistry.getToolForPlan("criticalSection");
    expect(tool).toBeDefined();

    const invalidParams = {
      lock: "test-lock",
      // missing deviceCount and steps
    };

    expect(() => tool!.schema.parse(invalidParams)).toThrow();
  });

  test("rejects invalid schema - empty steps array", () => {
    const tool = ToolRegistry.getToolForPlan("criticalSection");
    expect(tool).toBeDefined();

    const invalidParams = {
      lock: "test-lock",
      deviceCount: 2,
      steps: [], // Empty array not allowed
    };

    expect(() => tool!.schema.parse(invalidParams)).toThrow();
  });

  test("rejects schema when a sub-step is missing the device parameter", () => {
    const tool = ToolRegistry.getToolForPlan("criticalSection");
    expect(tool).toBeDefined();

    const invalidParams = {
      lock: "test-lock",
      deviceCount: 2,
      steps: [
        { tool: "observe", params: { device: "A" } },
        { tool: "sendKeys", params: { commands: [{ action: "type", text: "hi" }] } }, // no device
      ],
    };

    expect(() => tool!.schema.parse(invalidParams)).toThrow(
      /Every step inside a criticalSection must declare a non-empty 'device' parameter/,
    );
  });

  test("rejects schema when a sub-step's device is an empty string", () => {
    const tool = ToolRegistry.getToolForPlan("criticalSection");
    expect(tool).toBeDefined();

    const invalidParams = {
      lock: "test-lock",
      deviceCount: 1,
      steps: [{ tool: "observe", params: { device: "" } }],
    };

    expect(() => tool!.schema.parse(invalidParams)).toThrow(
      /Every step inside a criticalSection must declare a non-empty 'device' parameter/,
    );
  });

  test("rejects invalid schema - non-positive device count", () => {
    const tool = ToolRegistry.getToolForPlan("criticalSection");
    expect(tool).toBeDefined();

    const invalidParams = {
      lock: "test-lock",
      deviceCount: 0,
      steps: [{ tool: "observe", params: {} }],
    };

    expect(() => tool!.schema.parse(invalidParams)).toThrow();
  });

  test("detects nested critical sections", async () => {
    const tool = ToolRegistry.getToolForPlan("criticalSection");
    expect(tool).toBeDefined();

    const fakeDevice: BootedDevice = {
      platform: "android",
      deviceId: "test-device",
      name: "Test Device",
    };

    const coordinator = CriticalSectionCoordinator.getInstance();
    coordinator.registerExpectedDevices("outer-lock", 1);

    const params = {
      lock: "outer-lock",
      deviceCount: 1,
      steps: [
        {
          tool: "criticalSection", // Nested critical section
          params: {
            lock: "inner-lock",
            deviceCount: 1,
            steps: [{ tool: "observe", params: {} }],
          },
        },
      ],
    };

    await expect(
      tool!.deviceAwareHandler!(fakeDevice, params, undefined, undefined),
    ).rejects.toThrow(/Nested critical sections are not supported/);
  });

  test("detects a barrier nested inside a critical section", async () => {
    const tool = ToolRegistry.getToolForPlan("criticalSection");
    expect(tool).toBeDefined();

    const fakeDevice: BootedDevice = {
      platform: "android",
      deviceId: "test-device",
      name: "Test Device",
    };

    const coordinator = CriticalSectionCoordinator.getInstance();
    coordinator.registerExpectedDevices("outer-lock", 1);

    const params = {
      lock: "outer-lock",
      deviceCount: 1,
      steps: [
        {
          tool: "barrier", // Nested barrier would deadlock
          params: { lock: "inner-barrier", deviceCount: 1 },
        },
      ],
    };

    await expect(
      tool!.deviceAwareHandler!(fakeDevice, params, undefined, undefined),
    ).rejects.toThrow(/Nested critical sections are not supported.*barrier/);
  });

  test("executes steps in order for single device", async () => {
    const tool = ToolRegistry.getToolForPlan("criticalSection");
    expect(tool).toBeDefined();

    const fakeDevice: BootedDevice = {
      platform: "android",
      deviceId: "test-device-1",
      name: "Test Device 1",
    };

    // Register a mock tool to track execution
    const executionLog: string[] = [];
    ToolRegistry.register(
      "mockStep",
      "Mock step for testing",
      z.object({ message: z.string() }),
      async (params: { message: string }) => {
        executionLog.push(params.message);
        return { success: true };
      },
    );

    const coordinator = CriticalSectionCoordinator.getInstance();
    coordinator.registerExpectedDevices("test-lock", 1);

    const params = {
      lock: "test-lock",
      deviceCount: 1,
      steps: [
        { tool: "mockStep", params: { message: "step1" } },
        { tool: "mockStep", params: { message: "step2" } },
        { tool: "mockStep", params: { message: "step3" } },
      ],
    };

    const response = await tool!.deviceAwareHandler!(fakeDevice, params, undefined, undefined);

    // Parse the JSON tool response
    expect(response.content).toBeDefined();
    expect(response.content[0].type).toBe("text");
    const result = JSON.parse(response.content[0].text);

    expect(result.success).toBe(true);
    expect(result.executedSteps).toBe(3);
    expect(executionLog).toEqual(["step1", "step2", "step3"]);
  });

  test("does not apply public tool selection to a nested critical-section step", async () => {
    const tool = ToolRegistry.getToolForPlan("criticalSection");
    expect(tool).toBeDefined();
    const nestedHandler = mock(async () => ({ success: true }));
    ToolRegistry.register(
      "clipboard",
      "clipboard",
      z.object({ device: z.string() }),
      nestedHandler,
    );
    const profileService: Pick<SessionToolSelectionService, "isEnabled"> = {
      isEnabled: async (_sessionUuid, capability) => capability === "test-authoring",
    };
    const fakeDevice: BootedDevice = {
      platform: "android",
      deviceId: "test-device-capability",
      name: "Test Device Capability",
    };

    await expect(
      ToolRegistry.callInternal(
        tool!,
        {
          lock: "capability-lock",
          deviceCount: 1,
          steps: [{ tool: "clipboard", params: { device: "A" } }],
        },
        undefined,
        undefined,
        {
          forPlan: true,
          targetDevice: fakeDevice,
          sessionUuid: "session-1",
          sessionToolSelectionService: profileService,
        },
      ),
    ).resolves.toBeDefined();

    expect(nestedHandler).toHaveBeenCalledTimes(1);
  });

  test("routes a labeled critical-section nested step with the derived session (union re-enables)", async () => {
    // Issue #4611 Gaps B/C: a `${base}:${label}` label session carries its own
    // routing identity into nested steps, and capability enforcement is the
    // UNION of base + derived. Here the base narrows clipboard away but the
    // derived label re-enables it, so the nested step must run AND route with
    // the derived session (previously it collapsed to the base and was denied).
    const tool = ToolRegistry.getToolForPlan("criticalSection");
    expect(tool).toBeDefined();
    const nestedHandler = mock(async () => ({ success: true }));
    ToolRegistry.register(
      "clipboard",
      "clipboard",
      z.object({ device: z.string(), sessionUuid: z.string().optional() }),
      nestedHandler,
    );
    const profileService: Pick<SessionToolSelectionService, "isEnabled"> = {
      isEnabled: async (sessionUuid, capability) =>
        sessionUuid !== "base-session" || capability === "test-authoring",
    };
    const fakeDevice: BootedDevice = {
      platform: "android",
      deviceId: "test-device-base-profile",
      name: "Test Device Base Profile",
    };
    const restorePipelineOverrides = ToolRegistry.setPipelineOverridesForTesting({
      executionTargetResolver: {
        resolveExecutionTarget: async (input) => ({
          args: input.args,
          baseSessionUuid: "base-session",
          device: fakeDevice,
          internalCall: false,
          sessionUuid: "base-session:B",
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
        afterExecution: async () => {},
      },
    });

    try {
      await runWithToolSelectionContext(
        { routingSessionUuid: "base-session", sessionToolSelectionService: profileService },
        () =>
          tool!.handler({
            lock: "base-profile-lock",
            device: "B",
            deviceCount: 1,
            steps: [{ tool: "clipboard", params: { device: "B" } }],
          }),
      );

      expect(nestedHandler).toHaveBeenCalledTimes(1);
      const nestedArgs = nestedHandler.mock.calls[0][0] as { sessionUuid?: string };
      expect(nestedArgs.sessionUuid).toBe("base-session:B");
    } finally {
      restorePipelineOverrides();
    }
  });

  test("keeps a labeled nested step independent of public tool selection", async () => {
    // Union semantics remain restrictive when NEITHER session grants the
    // capability (issue #4611 Gap B, the "both narrow" direction).
    const tool = ToolRegistry.getToolForPlan("criticalSection");
    expect(tool).toBeDefined();
    const nestedHandler = mock(async () => ({ success: true }));
    ToolRegistry.register(
      "clipboard",
      "clipboard",
      z.object({ device: z.string(), sessionUuid: z.string().optional() }),
      nestedHandler,
    );
    const profileService: Pick<SessionToolSelectionService, "isEnabled"> = {
      // Only test-authoring is granted; clipboard is denied for every session.
      isEnabled: async (_sessionUuid, capability) => capability === "test-authoring",
    };
    const fakeDevice: BootedDevice = {
      platform: "android",
      deviceId: "test-device-both-narrow",
      name: "Test Device Both Narrow",
    };
    const restorePipelineOverrides = ToolRegistry.setPipelineOverridesForTesting({
      executionTargetResolver: {
        resolveExecutionTarget: async (input) => ({
          args: input.args,
          baseSessionUuid: "base-session",
          device: fakeDevice,
          internalCall: false,
          sessionUuid: "base-session:B",
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
        afterExecution: async () => {},
      },
    });

    try {
      await expect(
        runWithToolSelectionContext(
          { routingSessionUuid: "base-session", sessionToolSelectionService: profileService },
          () =>
            tool!.handler({
              lock: "both-narrow-lock",
              device: "B",
              deviceCount: 1,
              steps: [{ tool: "clipboard", params: { device: "B" } }],
            }),
        ),
      ).resolves.toBeDefined();

      expect(nestedHandler).toHaveBeenCalledTimes(1);
    } finally {
      restorePipelineOverrides();
    }
  });

  test("executes plan-executable debug-only steps hidden from MCP discovery", async () => {
    const tool = ToolRegistry.getToolForPlan("criticalSection");
    expect(tool).toBeDefined();

    const fakeDevice: BootedDevice = {
      platform: "android",
      deviceId: "test-device-hidden-plan-tool",
      name: "Test Device Hidden Plan Tool",
    };

    const executionLog: string[] = [];
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    ToolRegistry.registerDeviceAware(
      "mockPlanExecutableHiddenStep",
      "Mock hidden plan-executable step",
      z.object({
        device: z.string(),
        value: z.string(),
      }),
      async (_device, params: { device: string; value: string }) => {
        executionLog.push(`${params.device}:${params.value}`);
        return { success: true };
      },
      { debugOnly: true, planExecutable: true },
    );

    expect(ToolRegistry.getTool("mockPlanExecutableHiddenStep")).toBeUndefined();
    expect(ToolRegistry.getToolForPlan("mockPlanExecutableHiddenStep")).toBeDefined();
    warnSpy.mockClear();

    const params = {
      lock: "hidden-plan-tool-lock",
      deviceCount: 1,
      steps: [
        {
          tool: "mockPlanExecutableHiddenStep",
          params: { device: "A", value: "filled" },
        },
      ],
    };

    const response = await tool!.deviceAwareHandler!(fakeDevice, params, undefined, undefined);

    expect(response.content).toBeDefined();
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(true);
    expect(result.executedSteps).toBe(1);
    expect(executionLog).toEqual(["A:filled"]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Plan execution is using gated tool "mockPlanExecutableHiddenStep"'),
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("--debug is disabled"));

    warnSpy.mockRestore();
  });

  test("rejects debug-only steps that are not plan-executable", async () => {
    const tool = ToolRegistry.getToolForPlan("criticalSection");
    expect(tool).toBeDefined();

    const fakeDevice: BootedDevice = {
      platform: "android",
      deviceId: "test-device-hidden-debug-tool",
      name: "Test Device Hidden Debug Tool",
    };

    ToolRegistry.registerDeviceAware(
      "mockDebugOnlyHiddenStep",
      "Mock debug-only hidden step",
      z.object({ device: z.string() }),
      async () => ({ success: true }),
      { debugOnly: true },
    );

    expect(ToolRegistry.getTool("mockDebugOnlyHiddenStep")).toBeUndefined();
    expect(ToolRegistry.getToolForPlan("mockDebugOnlyHiddenStep")).toBeUndefined();

    const params = {
      lock: "hidden-debug-tool-lock",
      deviceCount: 1,
      steps: [
        {
          tool: "mockDebugOnlyHiddenStep",
          params: { device: "A" },
        },
      ],
    };

    await expect(
      tool!.deviceAwareHandler!(fakeDevice, params, undefined, undefined),
    ).rejects.toThrow(/Tool "mockDebugOnlyHiddenStep" not found in registry/);
  });

  test("executes plan-executable steps gated by non-debug feature flags with a warning", async () => {
    const tool = ToolRegistry.getToolForPlan("criticalSection");
    expect(tool).toBeDefined();

    const fakeDevice: BootedDevice = {
      platform: "android",
      deviceId: "test-device-embedded-plan-tool",
      name: "Test Device Embedded Plan Tool",
    };

    const executionLog: string[] = [];
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    ToolRegistry.registerDeviceAware(
      "mockEmbeddedPlanExecutableStep",
      "Mock embedded plan-executable step",
      z.object({
        device: z.string(),
        value: z.string(),
      }),
      async (_device, params: { device: string; value: string }) => {
        executionLog.push(`${params.device}:${params.value}`);
        return { success: true };
      },
      { embeddedSdkOnly: true, planExecutable: true },
    );

    expect(ToolRegistry.getTool("mockEmbeddedPlanExecutableStep")).toBeUndefined();
    expect(ToolRegistry.getToolForPlan("mockEmbeddedPlanExecutableStep")).toBeDefined();
    warnSpy.mockClear();

    const params = {
      lock: "embedded-plan-tool-lock",
      deviceCount: 1,
      steps: [
        {
          tool: "mockEmbeddedPlanExecutableStep",
          params: { device: "A", value: "synced" },
        },
      ],
    };

    const response = await tool!.deviceAwareHandler!(fakeDevice, params, undefined, undefined);

    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(true);
    expect(result.executedSteps).toBe(1);
    expect(executionLog).toEqual(["A:synced"]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'Plan execution is using gated tool "mockEmbeddedPlanExecutableStep"',
      ),
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("embedded SDK mode is disabled"));

    warnSpy.mockRestore();
  });

  test("preserves device loss from a sub-step after cleanup and lock release", async () => {
    const coordinator = CriticalSectionCoordinator.createForTesting(new FakeTimer());
    const restoreCoordinator = CriticalSectionCoordinator.setInstanceForTesting(coordinator);
    const cleanup = spyOn(coordinator, "forceCleanup");
    const enter = coordinator.enterCriticalSection.bind(coordinator);
    const release = mock(() => {});
    const enterSpy = spyOn(coordinator, "enterCriticalSection").mockImplementation(
      async (...args) => {
        const releaseLock = await enter(...args);
        return () => {
          release();
          releaseLock();
        };
      },
    );
    const device: BootedDevice = {
      platform: "android",
      deviceId: "emulator-5554",
      name: "Test Device",
    };
    const loss = new DeviceLostError(device.deviceId, "device-disconnected:emulator-5554");
    const signal = new AbortController().signal;
    const step = mock(async (_params: unknown, _progress: unknown, passedSignal?: AbortSignal) => {
      expect(passedSignal).toBe(signal);
      expect(passedSignal?.aborted).toBe(false);
      throw loss;
    });
    ToolRegistry.register("mockDeviceLoss", "Device loss", z.object({ device: z.string() }), step);

    try {
      const tool = ToolRegistry.getToolForPlan("criticalSection")!;
      const error = await tool.deviceAwareHandler!(
        device,
        {
          lock: "loss-lock",
          __lockNamespace: "loss-session",
          deviceCount: 1,
          steps: [{ tool: "mockDeviceLoss", params: { device: "A" } }],
        },
        undefined,
        signal,
      ).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(step).toHaveBeenCalledTimes(1);
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(cleanup).toHaveBeenCalledWith("loss-lock", "loss-session");
      expect(release).toHaveBeenCalledTimes(1);
      expect(error).toBe(loss);
      expect(isDeviceLostError(error)).toBe(true);
    } finally {
      enterSpy.mockRestore();
      cleanup.mockRestore();
      coordinator.reset();
      restoreCoordinator();
    }
  });

  test("fails fast when a step fails", async () => {
    const tool = ToolRegistry.getToolForPlan("criticalSection");
    expect(tool).toBeDefined();

    const fakeDevice: BootedDevice = {
      platform: "android",
      deviceId: "test-device-2",
      name: "Test Device 2",
    };

    // Register mock tools
    const executionLog: string[] = [];
    ToolRegistry.register(
      "mockSuccess",
      "Mock success step",
      z.object({ message: z.string() }),
      async (params: { message: string }) => {
        executionLog.push(params.message);
        return { success: true };
      },
    );

    ToolRegistry.register("mockFailure", "Mock failure step", z.object({}), async () => {
      executionLog.push("failure");
      throw new Error("Simulated failure");
    });

    const coordinator = CriticalSectionCoordinator.getInstance();
    coordinator.registerExpectedDevices("fail-lock", 1);

    const params = {
      lock: "fail-lock",
      deviceCount: 1,
      steps: [
        { tool: "mockSuccess", params: { message: "step1" } },
        { tool: "mockFailure", params: {} },
        { tool: "mockSuccess", params: { message: "step3" } }, // Should not execute
      ],
    };

    await expect(
      tool!.deviceAwareHandler!(fakeDevice, params, undefined, undefined),
    ).rejects.toThrow(/Simulated failure/);

    // Verify only first two steps executed
    expect(executionLog).toEqual(["step1", "failure"]);
  });

  test("fails when a nested tool returns a structured MCP error envelope", async () => {
    const tool = ToolRegistry.getToolForPlan("criticalSection");
    expect(tool).toBeDefined();

    const fakeDevice: BootedDevice = {
      platform: "android",
      deviceId: "test-device-structured-failure",
      name: "Test Device Structured Failure",
    };

    ToolRegistry.register(
      "mockStructuredFailure",
      "structured failure",
      z.object({}),
      async () => ({
        isError: true,
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: false,
              message: "Failed to kill android device: Emulator is not running",
              error: {
                code: "device_already_stopped",
                message: "Failed to kill android device: Emulator is not running",
              },
            }),
          },
        ],
      }),
    );

    CriticalSectionCoordinator.getInstance().registerExpectedDevices("structured-failure-lock", 1);

    await expect(
      tool!.deviceAwareHandler!(
        fakeDevice,
        {
          lock: "structured-failure-lock",
          deviceCount: 1,
          steps: [{ tool: "mockStructuredFailure", params: {} }],
        },
        undefined,
        undefined,
      ),
    ).rejects.toThrow(
      /device_already_stopped: Failed to kill android device: Emulator is not running/,
    );
  });

  test("wraps a step failure with the documented device + step context", async () => {
    const tool = ToolRegistry.getToolForPlan("criticalSection");
    expect(tool).toBeDefined();

    const fakeDevice: BootedDevice = {
      platform: "android",
      deviceId: "dev-wrap",
      name: "Dev Wrap",
    };

    ToolRegistry.register("mockWrapOk", "ok", z.object({}), async () => ({
      success: true,
    }));
    ToolRegistry.register("mockWrapBoom", "boom", z.object({}), async () => {
      throw new Error("kaboom");
    });

    CriticalSectionCoordinator.getInstance().registerExpectedDevices("wrap-lock", 1);

    const params = {
      lock: "wrap-lock",
      deviceCount: 1,
      steps: [
        { tool: "mockWrapOk", params: {} },
        { tool: "mockWrapBoom", params: {} },
      ],
    };

    // Both wrapper layers are documented verbatim: the outer "Critical section
    // <lock> failed for device <id>" and the inner "Failed at step X/Y (<tool>)".
    await expect(
      tool!.deviceAwareHandler!(fakeDevice, params, undefined, undefined),
    ).rejects.toThrow(
      /Critical section "wrap-lock" failed for device dev-wrap: Failed at step 2\/2 \(mockWrapBoom\): kaboom/,
    );
  });
  describe("optional sub-steps", () => {
    const fakeDevice: BootedDevice = {
      platform: "android",
      deviceId: "optional-device",
      name: "Optional Device",
    };
    let coordinator: CriticalSectionCoordinator;
    let fakeTimer: FakeTimer;
    let restoreCoordinator: () => void;
    const nextStep = mock(async () => ({ success: true }));

    beforeEach(() => {
      fakeTimer = new FakeTimer();
      coordinator = CriticalSectionCoordinator.createForTesting(fakeTimer);
      restoreCoordinator = CriticalSectionCoordinator.setInstanceForTesting(coordinator);
      nextStep.mockClear();
      ToolRegistry.register("mockAfterOptional", "next step", z.object({}), nextStep);
    });

    afterEach(() => {
      coordinator.reset();
      fakeTimer.reset();
      restoreCoordinator();
      ToolRegistry.unregister("mockOptionalStep");
      ToolRegistry.unregister("mockAfterOptional");
    });

    const runSteps = (optional: boolean | undefined, signal?: AbortSignal) => {
      const tool = ToolRegistry.getToolForPlan("criticalSection")!;
      const params = tool.schema.parse({
        lock: "optional-lock",
        deviceCount: 1,
        steps: [
          {
            tool: "mockOptionalStep",
            params: { device: "A" },
            ...(optional === undefined ? {} : { optional }),
          },
          { tool: "mockAfterOptional", params: { device: "A" } },
        ],
      });
      return tool.deviceAwareHandler!(fakeDevice, params, undefined, signal);
    };

    test.each(["returned failure", "MCP failure envelope", "ordinary exception"])(
      "continues after an optional %s and reports a warning",
      async (failureKind) => {
        ToolRegistry.register("mockOptionalStep", "optional step", z.object({}), async () => {
          if (failureKind === "ordinary exception") {
            throw new Error("optional failure");
          }
          const result = { success: false, error: "optional failure" };
          return failureKind === "MCP failure envelope"
            ? { content: [{ type: "text", text: JSON.stringify(result) }] }
            : result;
        });
        const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
        const cleanupSpy = spyOn(coordinator, "forceCleanup");
        try {
          const response = await runSteps(true);
          expect(JSON.parse(response.content[0].text)).toEqual({
            success: true,
            lock: "optional-lock",
            deviceId: "optional-device",
            executedSteps: 2,
            totalSteps: 2,
            warnings: [
              "step 1 (mockOptionalStep): optional step failed; skipped: optional failure",
            ],
          });
          expect(nextStep).toHaveBeenCalledTimes(1);
          expect(cleanupSpy).not.toHaveBeenCalled();
          expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining(
              "optional step mockOptionalStep failed; skipping and continuing: optional failure",
            ),
          );
        } finally {
          warnSpy.mockRestore();
          cleanupSpy.mockRestore();
        }
      },
    );

    test.each([
      { optional: false, throws: false },
      { optional: undefined, throws: false },
      { optional: false, throws: true },
      { optional: undefined, throws: true },
    ])("keeps required failure wrapping for %j", async ({ optional, throws }) => {
      ToolRegistry.register("mockOptionalStep", "required step", z.object({}), async () => {
        if (throws) {
          throw new Error("required failure");
        }
        return { success: false, error: "required failure" };
      });
      const response = runSteps(optional);
      await expect(response).rejects.toThrow(
        'Critical section "optional-lock" failed for device optional-device: Failed at step 1/2 (mockOptionalStep): required failure',
      );
      expect(nextStep).not.toHaveBeenCalled();
    });

    test("does not skip an optional tool that is not found", async () => {
      await expect(runSteps(true)).rejects.toThrow(
        'Failed at step 1/2 (mockOptionalStep): Tool "mockOptionalStep" not found in registry',
      );
      expect(nextStep).not.toHaveBeenCalled();
    });

    test.each([true, false])("propagates device loss with optional=%s", async (optional) => {
      const deviceLoss = new DeviceLostError(fakeDevice.deviceId, "device disconnected");
      ToolRegistry.register("mockOptionalStep", "lost device", z.object({}), async () => {
        throw deviceLoss;
      });
      const error = await runSteps(optional).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(error).toBe(deviceLoss);
      expect(isDeviceLostError(error)).toBe(true);
      expect(nextStep).not.toHaveBeenCalled();
    });

    test("does not skip an optional schema validation error", async () => {
      const schema = z.object({ required: z.string() });
      const validation = schema.safeParse({});
      if (validation.success) {
        throw new Error("Expected a validation error");
      }
      ToolRegistry.register("mockOptionalStep", "invalid step", z.object({}), async () => {
        throw validation.error;
      });
      await expect(runSteps(true)).rejects.toThrow(
        `Critical section "optional-lock" failed for device optional-device: Invalid parameters for tool mockOptionalStep: required expected string, received undefined`,
      );
      expect(nextStep).not.toHaveBeenCalled();
    });

    test.each(["ordinary exception", "AbortError", "throwIfAborted", "returned failure"])(
      "propagates cancellation during an optional %s",
      async (failureKind) => {
        const controller = new AbortController();
        ToolRegistry.register("mockOptionalStep", "cancelled step", z.object({}), async () => {
          controller.abort();
          if (failureKind === "throwIfAborted") {
            throwIfAborted(controller.signal);
          }
          if (failureKind === "AbortError") {
            throw new DOMException("cancelled", "AbortError");
          }
          if (failureKind === "ordinary exception") {
            throw new Error("cancelled");
          }
          return { success: false, error: "cancelled" };
        });
        const message = failureKind === "throwIfAborted" ? "Operation cancelled" : "cancelled";
        await expect(runSteps(true, controller.signal)).rejects.toThrow(
          `Critical section "optional-lock" failed for device optional-device: ${message}`,
        );
        expect(nextStep).not.toHaveBeenCalled();
      },
    );
  });

  describe("warnings before a required sub-step failure", () => {
    let restoreTools: () => void;
    let restoreCoordinator: () => void;
    let coordinator: CriticalSectionCoordinator;
    const device: BootedDevice = {
      platform: "android",
      deviceId: "warning-failure-device",
      name: "Warning Failure Device",
    };

    beforeEach(() => {
      restoreTools = preserveToolRegistry();
      coordinator = CriticalSectionCoordinator.createForTesting(new FakeTimer());
      restoreCoordinator = CriticalSectionCoordinator.setInstanceForTesting(coordinator);
    });

    afterEach(() => {
      coordinator.reset();
      restoreCoordinator();
      restoreTools();
    });

    test.each([false, true])("keeps earlier warnings with optional skip=%s", async (optional) => {
      ToolRegistry.register("warningFirst", "warns", z.object({}), async () => ({
        success: true,
        warnings: ["keyboard dismissal failed"],
      }));
      ToolRegistry.register("warningSecond", "warns or skips", z.object({}), async () =>
        optional
          ? { success: false, error: "optional failure" }
          : { success: true, warnings: ["epilogue failed"] },
      );
      ToolRegistry.register("warningThird", "fails", z.object({}), async () => {
        throw new ActionableError("required failure");
      });
      const section = ToolRegistry.getToolForPlan("criticalSection")!;
      const error: unknown = await section.deviceAwareHandler!(
        device,
        section.schema.parse({
          lock: "warning-failure-lock",
          deviceCount: 1,
          steps: [
            { tool: "warningFirst", params: { device: "A" } },
            { tool: "warningSecond", params: { device: "A" }, optional },
            { tool: "warningThird", params: { device: "A" } },
          ],
        }),
      ).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(error).toBeInstanceOf(ActionableError);
      expect(error).toMatchObject({
        message:
          'Critical section "warning-failure-lock" failed for device warning-failure-device: Failed at step 3/3 (warningThird): required failure',
        warnings: [
          "step 1 (warningFirst): keyboard dismissal failed",
          optional
            ? "step 2 (warningSecond): optional step failed; skipped: optional failure"
            : "step 2 (warningSecond): epilogue failed",
        ],
      });
    });
  });

  describe("a sub-step that answers but fails keeps its diagnostics (#10024 parity)", () => {
    let restoreTools: () => void;
    let restoreCoordinator: () => void;
    let coordinator: CriticalSectionCoordinator;
    const device: BootedDevice = {
      platform: "android",
      deviceId: "answered-failure-device",
      name: "Answered Failure Device",
    };

    beforeEach(() => {
      restoreTools = preserveToolRegistry();
      coordinator = CriticalSectionCoordinator.createForTesting(new FakeTimer());
      restoreCoordinator = CriticalSectionCoordinator.setInstanceForTesting(coordinator);
    });

    afterEach(() => {
      coordinator.reset();
      restoreCoordinator();
      restoreTools();
    });

    async function runSection(answer: Record<string, unknown>, optional = false): Promise<unknown> {
      ToolRegistry.register("answeredFailure", "answers", z.object({}), async () => answer);
      const section = ToolRegistry.getToolForPlan("criticalSection")!;
      return section.deviceAwareHandler!(
        device,
        section.schema.parse({
          lock: "answered-failure-lock",
          deviceCount: 1,
          steps: [{ tool: "answeredFailure", params: { device: "A" }, optional }],
        }),
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
    }

    test("success:false with warnings promotes the sub-step's warnings", async () => {
      const error = await runSection({
        success: false,
        error: "tap failed",
        warnings: ["keyboard dismissal failed"],
      });
      expect(error).toMatchObject({
        message: expect.stringContaining("Failed at step 1/1 (answeredFailure): tap failed"),
        warnings: ["step 1 (answeredFailure): keyboard dismissal failed"],
      });
    });

    test("a waitFor timeout carries its bounded diagnostics and warnings", async () => {
      const error = await runSection({
        success: true,
        awaitTimeout: true,
        awaitDuration: 5000,
        timedOut: true,
        candidates: [{ text: "Almost", "resource-id": "a/b", extra: "dropped" }],
        warnings: ["screen was animating"],
      });
      expect(error).toMatchObject({
        message: expect.stringContaining("answeredFailure waitFor timed out after 5000ms"),
        warnings: [
          "step 1 (answeredFailure): screen was animating",
          `step 1 (answeredFailure): waitFor timeout: ${JSON.stringify({
            awaitDuration: 5000,
            timedOut: true,
            candidates: [{ text: "Almost", "resource-id": "a/b" }],
            candidateCount: 1,
          })}`,
        ],
      });
    });

    test("an optional sub-step's own warnings are kept next to the skip warning", async () => {
      ToolRegistry.register("answeredFailure", "answers", z.object({}), async () => ({
        success: false,
        error: "optional failure",
        warnings: ["note"],
      }));
      ToolRegistry.register("answeredOk", "ok", z.object({}), async () => ({ success: true }));
      const section = ToolRegistry.getToolForPlan("criticalSection")!;
      const result = await section.deviceAwareHandler!(
        device,
        section.schema.parse({
          lock: "answered-optional-lock",
          deviceCount: 1,
          steps: [
            { tool: "answeredFailure", params: { device: "A" }, optional: true },
            { tool: "answeredOk", params: { device: "A" } },
          ],
        }),
      );
      expect(getStructuredPayload<Record<string, unknown>>(result)?.warnings).toEqual([
        "step 1 (answeredFailure): note",
        "step 1 (answeredFailure): optional step failed; skipped: optional failure",
      ]);
    });
  });

  // A best-effort epilogue failure (issue #6868) keeps its step successful and
  // reports itself through `warnings`. The critical section retained only the
  // tool name and a success bit, so that outcome — previously the step's whole
  // `success:false` — vanished and the section reported an entirely clean
  // success while later steps ran against a screen the caller did not expect.
  test.each(["direct", "structured", "text", "structured and hoisted"] as const)(
    "surfaces a successful step's %s warnings exactly once",
    async (shape) => {
      const tool = ToolRegistry.getToolForPlan("criticalSection");
      expect(tool).toBeDefined();

      const fakeDevice: BootedDevice = {
        platform: "android",
        deviceId: "warn-device",
        name: "Warn Device",
      };

      const payload = {
        success: true,
        keyboardDismissed: false,
        warnings: ["keyboard dismissal failed: Keyboard state unavailable"],
      };
      const structured = createStructuredToolResponse(payload);
      const responses = {
        direct: payload,
        structured,
        text: { success: true, content: structured.content },
        "structured and hoisted": { ...structured, warnings: payload.warnings },
      };
      ToolRegistry.register("mockWarnStep", "warns", z.object({}), async () => responses[shape]);
      ToolRegistry.register("mockCleanStep", "clean", z.object({}), async () => ({
        success: true,
      }));

      CriticalSectionCoordinator.getInstance().registerExpectedDevices("warn-lock", 1);

      const params = {
        lock: "warn-lock",
        deviceCount: 1,
        steps: [
          { tool: "mockCleanStep", params: {} },
          { tool: "mockWarnStep", params: {} },
        ],
      };

      const response = await tool!.deviceAwareHandler!(fakeDevice, params, undefined, undefined);
      const result = JSON.parse(response.content[0].text);

      expect(result.success).toBe(true);
      expect(result.executedSteps).toBe(2);
      expect(result.warnings).toEqual([
        "step 2 (mockWarnStep): keyboard dismissal failed: Keyboard state unavailable",
      ]);
    },
  );

  test("omits warnings entirely when every step is clean", async () => {
    const tool = ToolRegistry.getToolForPlan("criticalSection");

    const fakeDevice: BootedDevice = {
      platform: "android",
      deviceId: "clean-device",
      name: "Clean Device",
    };

    ToolRegistry.register("mockCleanStep", "clean", z.object({}), async () => ({
      success: true,
    }));

    CriticalSectionCoordinator.getInstance().registerExpectedDevices("clean-lock", 1);

    const response = await tool!.deviceAwareHandler!(
      fakeDevice,
      { lock: "clean-lock", deviceCount: 1, steps: [{ tool: "mockCleanStep", params: {} }] },
      undefined,
      undefined,
    );
    const result = JSON.parse(response.content[0].text);

    expect(result.success).toBe(true);
    expect(result.warnings).toBeUndefined();
  });
});
