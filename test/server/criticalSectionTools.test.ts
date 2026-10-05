import { getStructuredPayload } from "../../src/utils/toolUtils";
import { DefaultPlanExecutor } from "../../src/utils/plan/PlanExecutor";
import { FakeTimer } from "../fakes/FakeTimer";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { registerCriticalSectionTools } from "../../src/server/criticalSectionTools";
import { CriticalSectionCoordinator } from "../../src/server/CriticalSectionCoordinator";
import type { BootedDevice } from "../../src/models";
import { DeviceLostError, isDeviceLostError } from "../../src/models/DeviceLostError";
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

  const envelopeCases: Array<{
    name: string;
    response: unknown;
    success: boolean;
    error?: string;
  }> = [
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
        `Critical section "optional-lock" failed for device optional-device: ${validation.error.message}`,
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

  // A best-effort epilogue failure (issue #6868) keeps its step successful and
  // reports itself through `warnings`. The critical section retained only the
  // tool name and a success bit, so that outcome — previously the step's whole
  // `success:false` — vanished and the section reported an entirely clean
  // success while later steps ran against a screen the caller did not expect.
  test("surfaces a successful step's warnings on the critical-section result", async () => {
    const tool = ToolRegistry.getToolForPlan("criticalSection");
    expect(tool).toBeDefined();

    const fakeDevice: BootedDevice = {
      platform: "android",
      deviceId: "warn-device",
      name: "Warn Device",
    };

    ToolRegistry.register("mockWarnStep", "warns", z.object({}), async () => ({
      success: true,
      keyboardDismissed: false,
      warnings: ["keyboard dismissal failed: Keyboard state unavailable"],
    }));
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
  });

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
