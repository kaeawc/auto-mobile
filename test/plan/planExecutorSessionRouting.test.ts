import { describe, expect, test, mock, beforeEach } from "bun:test";
import { DefaultPlanExecutor } from "../../src/utils/plan/PlanExecutor";
import { Plan } from "../../src/models/Plan";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { z } from "zod";

describe("PlanExecutor - Session-based Device Routing", () => {
  let planExecutor: DefaultPlanExecutor;

  beforeEach(() => {
    planExecutor = new DefaultPlanExecutor();
  });

  test("should NOT inject deviceId when sessionUuid is provided (single-device plan)", async () => {
    // Register a mock tool to capture the params it receives
    const capturedParams: any[] = [];
    const mockHandler = mock(async (params: any) => {
      capturedParams.push({ ...params });
      return { success: true };
    });

    const testToolSchema = z.object({
      platform: z.string().optional(),
      deviceId: z.string().optional(),
      sessionUuid: z.string().optional(),
      testParam: z.string().optional(),
    });

    ToolRegistry.register(
      "testSessionRoutingTool",
      "Test tool for session routing",
      testToolSchema,
      mockHandler
    );

    // Mark it as requiring a device so params get injected
    const tool = ToolRegistry.getTool("testSessionRoutingTool")!;
    (tool as any).requiresDevice = true;

    const plan: Plan = {
      name: "Test Session Routing",
      mcpVersion: "1.0",
      steps: [
        {
          tool: "testSessionRoutingTool",
          params: {
            testParam: "value1",
          },
        },
        {
          tool: "testSessionRoutingTool",
          params: {
            testParam: "value2",
          },
        },
      ],
    };

    // Execute plan with BOTH deviceId and sessionUuid
    // In this scenario, sessionUuid should take precedence and deviceId should NOT be injected into steps
    const deviceId = "emulator-5554";
    const sessionUuid = "test-session-uuid-123";

    await planExecutor.executePlan(
      plan,
      0, // startStep
      "android", // platform
      deviceId, // deviceId - should NOT be injected into steps when sessionUuid is present
      sessionUuid // sessionUuid - should be injected
    );

    // Verify the tool was called twice (once per step)
    expect(mockHandler).toHaveBeenCalledTimes(2);

    // Verify that sessionUuid was injected but deviceId was NOT
    expect(capturedParams.length).toBe(2);

    // First step
    expect(capturedParams[0]).toHaveProperty("sessionUuid", sessionUuid);
    expect(capturedParams[0]).not.toHaveProperty("deviceId");
    expect(capturedParams[0]).toHaveProperty("platform", "android");
    expect(capturedParams[0]).toHaveProperty("testParam", "value1");

    // Second step
    expect(capturedParams[1]).toHaveProperty("sessionUuid", sessionUuid);
    expect(capturedParams[1]).not.toHaveProperty("deviceId");
    expect(capturedParams[1]).toHaveProperty("platform", "android");
    expect(capturedParams[1]).toHaveProperty("testParam", "value2");
  });

  test("should inject deviceId when sessionUuid is NOT provided", async () => {
    // Register a mock tool to capture the params it receives
    const capturedParams: any[] = [];
    const mockHandler = mock(async (params: any) => {
      capturedParams.push({ ...params });
      return { success: true };
    });

    const testToolSchema = z.object({
      platform: z.string().optional(),
      deviceId: z.string().optional(),
      testParam: z.string().optional(),
    });

    ToolRegistry.register(
      "testDeviceIdInjectionTool",
      "Test tool for deviceId injection",
      testToolSchema,
      mockHandler
    );

    // Mark it as requiring a device so params get injected
    const tool = ToolRegistry.getTool("testDeviceIdInjectionTool")!;
    (tool as any).requiresDevice = true;

    const plan: Plan = {
      name: "Test DeviceId Injection",
      mcpVersion: "1.0",
      steps: [
        {
          tool: "testDeviceIdInjectionTool",
          params: {
            testParam: "value1",
          },
        },
      ],
    };

    // Execute plan with ONLY deviceId (no sessionUuid)
    // In this scenario, deviceId SHOULD be injected into steps
    const deviceId = "emulator-5554";

    await planExecutor.executePlan(
      plan,
      0, // startStep
      "android", // platform
      deviceId, // deviceId - should be injected
      undefined // no sessionUuid
    );

    // Verify the tool was called
    expect(mockHandler).toHaveBeenCalledTimes(1);

    // Verify that deviceId was injected
    expect(capturedParams.length).toBe(1);
    expect(capturedParams[0]).toHaveProperty("deviceId", deviceId);
    expect(capturedParams[0]).toHaveProperty("platform", "android");
    expect(capturedParams[0]).toHaveProperty("testParam", "value1");
  });

  test("should NOT override deviceId if already present in step params", async () => {
    // Register a mock tool
    const capturedParams: any[] = [];
    const mockHandler = mock(async (params: any) => {
      capturedParams.push({ ...params });
      return { success: true };
    });

    const testToolSchema = z.object({
      platform: z.string().optional(),
      deviceId: z.string().optional(),
      testParam: z.string().optional(),
    });

    ToolRegistry.register(
      "testNoOverrideTool",
      "Test tool for no override",
      testToolSchema,
      mockHandler
    );

    // Mark it as requiring a device
    const tool = ToolRegistry.getTool("testNoOverrideTool")!;
    (tool as any).requiresDevice = true;

    const plan: Plan = {
      name: "Test No Override",
      mcpVersion: "1.0",
      steps: [
        {
          tool: "testNoOverrideTool",
          params: {
            deviceId: "explicitly-set-device", // Step already has deviceId
            testParam: "value1",
          },
        },
      ],
    };

    // Execute plan with different deviceId
    await planExecutor.executePlan(
      plan,
      0,
      "android",
      "emulator-5554", // Different deviceId - should NOT override the step's explicit deviceId
      undefined
    );

    // Verify the step's explicit deviceId was preserved
    expect(capturedParams.length).toBe(1);
    expect(capturedParams[0]).toHaveProperty("deviceId", "explicitly-set-device");
    expect(capturedParams[0]).not.toHaveProperty("deviceId", "emulator-5554");
  });
});
