import { beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { registerCriticalSectionTools } from "../../src/server/criticalSectionTools";
import { CriticalSectionCoordinator } from "../../src/server/CriticalSectionCoordinator";
import type { BootedDevice } from "../../src/models";
import { z } from "zod";
import { setDebugModeEnabled } from "../../src/utils/debug";
import { logger } from "../../src/utils/logger";
import { serverConfig } from "../../src/utils/ServerConfig";
import type { SessionToolProfileService } from "../../src/features/toolCapabilities/SessionToolProfileService";
import { runWithToolCapabilityContext } from "../../src/features/toolCapabilities/toolCapabilityContext";

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
        { tool: "inputText", params: { text: "hi" } }, // no device
      ],
    };

    expect(() => tool!.schema.parse(invalidParams)).toThrow(
      /Every step inside a criticalSection must declare a non-empty 'device' parameter/
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
      /Every step inside a criticalSection must declare a non-empty 'device' parameter/
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
			tool!.deviceAwareHandler!(fakeDevice, params, undefined, undefined)
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
			tool!.deviceAwareHandler!(fakeDevice, params, undefined, undefined)
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
      }
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

    const response = await tool!.deviceAwareHandler!(
      fakeDevice,
      params,
      undefined,
      undefined
    );

    // Parse the JSON tool response
    expect(response.content).toBeDefined();
    expect(response.content[0].type).toBe("text");
    const result = JSON.parse(response.content[0].text);

    expect(result.success).toBe(true);
    expect(result.executedSteps).toBe(3);
    expect(executionLog).toEqual(["step1", "step2", "step3"]);
  });

  test("rejects a capability-disabled nested step before invoking its handler", async () => {
    const tool = ToolRegistry.getToolForPlan("criticalSection");
    expect(tool).toBeDefined();
    const nestedHandler = mock(async () => ({ success: true }));
    ToolRegistry.register("clipboard", "clipboard", z.object({ device: z.string() }), nestedHandler);
    const profileService: Pick<SessionToolProfileService, "isEnabled"> = {
      isEnabled: async (_sessionUuid, capability) => capability === "test-authoring",
    };
    const fakeDevice: BootedDevice = {
      platform: "android",
      deviceId: "test-device-capability",
      name: "Test Device Capability",
    };

    await expect(ToolRegistry.callInternal(
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
        sessionToolProfileService: profileService,
      },
    )).rejects.toThrow("requires the 'clipboard' capability");

    expect(nestedHandler).not.toHaveBeenCalled();
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
    ToolRegistry.register("clipboard", "clipboard", z.object({ device: z.string(), sessionUuid: z.string().optional() }), nestedHandler);
    const profileService: Pick<SessionToolProfileService, "isEnabled"> = {
      isEnabled: async (sessionUuid, capability) => sessionUuid !== "base-session" || capability === "test-authoring",
    };
    const fakeDevice: BootedDevice = {
      platform: "android",
      deviceId: "test-device-base-profile",
      name: "Test Device Base Profile",
    };
    const restorePipelineOverrides = ToolRegistry.setPipelineOverridesForTesting({
      executionTargetResolver: {
        resolveExecutionTarget: async input => ({
          args: input.args,
          baseSessionUuid: "base-session",
          device: fakeDevice,
          internalCall: false,
          sessionUuid: "base-session:B",
          shouldResolveDevice: true,
        }),
      },
      auditRunner: {
        run: async input => input.handler(input.device, input.args, input.progress, input.signal),
      },
      afterToolCall: {
        handle: async input => ({ durationMs: 0, finalizedResponse: input.response }),
      },
      planLifecycleManager: {
        afterExecution: async () => {},
      },
    });

    try {
      await runWithToolCapabilityContext(
        { routingSessionUuid: "base-session", sessionToolProfileService: profileService },
        () => tool!.handler({
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

  test("denies a labeled critical-section nested step when base and derived both narrow it away", async () => {
    // Union semantics remain restrictive when NEITHER session grants the
    // capability (issue #4611 Gap B, the "both narrow" direction).
    const tool = ToolRegistry.getToolForPlan("criticalSection");
    expect(tool).toBeDefined();
    const nestedHandler = mock(async () => ({ success: true }));
    ToolRegistry.register("clipboard", "clipboard", z.object({ device: z.string(), sessionUuid: z.string().optional() }), nestedHandler);
    const profileService: Pick<SessionToolProfileService, "isEnabled"> = {
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
        resolveExecutionTarget: async input => ({
          args: input.args,
          baseSessionUuid: "base-session",
          device: fakeDevice,
          internalCall: false,
          sessionUuid: "base-session:B",
          shouldResolveDevice: true,
        }),
      },
      auditRunner: {
        run: async input => input.handler(input.device, input.args, input.progress, input.signal),
      },
      afterToolCall: {
        handle: async input => ({ durationMs: 0, finalizedResponse: input.response }),
      },
      planLifecycleManager: {
        afterExecution: async () => {},
      },
    });

    try {
      await expect(runWithToolCapabilityContext(
        { routingSessionUuid: "base-session", sessionToolProfileService: profileService },
        () => tool!.handler({
          lock: "both-narrow-lock",
          device: "B",
          deviceCount: 1,
          steps: [{ tool: "clipboard", params: { device: "B" } }],
        }),
      )).rejects.toThrow("requires the 'clipboard' capability");

      expect(nestedHandler).not.toHaveBeenCalled();
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
    ToolRegistry.registerDeviceAware("mockPlanExecutableHiddenStep", "Mock hidden plan-executable step", z.object({
      device: z.string(),
      value: z.string(),
    }), async (_device, params: { device: string; value: string }) => {
      executionLog.push(`${params.device}:${params.value}`);
      return { success: true };
    }, { debugOnly: true, planExecutable: true });

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

    const response = await tool!.deviceAwareHandler!(
      fakeDevice,
      params,
      undefined,
      undefined
    );

    expect(response.content).toBeDefined();
    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(true);
    expect(result.executedSteps).toBe(1);
    expect(executionLog).toEqual(["A:filled"]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Plan execution is using gated tool \"mockPlanExecutableHiddenStep\"")
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("--debug is disabled")
    );

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

    ToolRegistry.registerDeviceAware("mockDebugOnlyHiddenStep", "Mock debug-only hidden step", z.object({ device: z.string() }), async () => ({ success: true }), { debugOnly: true });

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
      tool!.deviceAwareHandler!(fakeDevice, params, undefined, undefined)
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
    ToolRegistry.registerDeviceAware("mockEmbeddedPlanExecutableStep", "Mock embedded plan-executable step", z.object({
      device: z.string(),
      value: z.string(),
    }), async (_device, params: { device: string; value: string }) => {
      executionLog.push(`${params.device}:${params.value}`);
      return { success: true };
    }, { embeddedSdkOnly: true, planExecutable: true });

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

    const response = await tool!.deviceAwareHandler!(
      fakeDevice,
      params,
      undefined,
      undefined
    );

    const result = JSON.parse(response.content[0].text);
    expect(result.success).toBe(true);
    expect(result.executedSteps).toBe(1);
    expect(executionLog).toEqual(["A:synced"]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Plan execution is using gated tool \"mockEmbeddedPlanExecutableStep\"")
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("embedded SDK mode is disabled")
    );

    warnSpy.mockRestore();
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
      }
    );

    ToolRegistry.register(
      "mockFailure",
      "Mock failure step",
      z.object({}),
      async () => {
        executionLog.push("failure");
        throw new Error("Simulated failure");
      }
    );

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
			tool!.deviceAwareHandler!(fakeDevice, params, undefined, undefined)
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

    ToolRegistry.register("mockStructuredFailure", "structured failure", z.object({}), async () => ({
      isError: true,
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          success: false,
          message: "Failed to kill android device: Emulator is not running",
          error: {
            code: "device_already_stopped",
            message: "Failed to kill android device: Emulator is not running",
          },
        }),
      }],
    }));

    CriticalSectionCoordinator.getInstance().registerExpectedDevices("structured-failure-lock", 1);

    await expect(
      tool!.deviceAwareHandler!(fakeDevice, {
        lock: "structured-failure-lock",
        deviceCount: 1,
        steps: [{ tool: "mockStructuredFailure", params: {} }],
      }, undefined, undefined)
    ).rejects.toThrow(
      /device_already_stopped: Failed to kill android device: Emulator is not running/
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
			tool!.deviceAwareHandler!(fakeDevice, params, undefined, undefined)
    ).rejects.toThrow(
      /Critical section "wrap-lock" failed for device dev-wrap: Failed at step 2\/2 \(mockWrapBoom\): kaboom/
    );
  });
});
