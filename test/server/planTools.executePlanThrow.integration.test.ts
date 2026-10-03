import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test";
import * as planUtils from "../../src/utils/planUtils";
import * as videoRecordingManager from "../../src/server/videoRecordingManager";
import { registerPlanTools } from "../../src/server/planTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { DeviceLostError } from "../../src/server/deviceLossOutcome";

const executePlanError = new Error("Simulated executePlan failure: device disconnected");

const VALID_PLAN_YAML = `
name: simple-test
steps:
  - tool: observe
    params: {}
`;

const mockDevice = {
  deviceId: "emulator-5554",
  name: "Pixel 6 API 33",
  platform: "android" as const,
  status: "booted" as const,
};

describe("executePlanTool — executePlan throws", () => {
  let videoSpy: ReturnType<typeof spyOn>;
  let mockExecutePlan: ReturnType<typeof spyOn<typeof planUtils, "executePlan">>;

  beforeEach(() => {
    mockExecutePlan = spyOn(planUtils, "executePlan").mockRejectedValue(executePlanError);
    // Exercise the plan failure without opening the real recording DB or device.
    videoSpy = spyOn(videoRecordingManager, "startVideoRecording").mockRejectedValue(
      new Error("Video recording disabled in this test"),
    );
    ToolRegistry.clearTools();
    registerPlanTools();
  });

  afterEach(() => {
    mockExecutePlan.mockRestore();
    videoSpy.mockRestore();
    ToolRegistry.clearTools();
  });

  test("returns failure response with original error when executePlan throws", async () => {
    const tool = ToolRegistry.getTool("executePlan");
    expect(tool).toBeDefined();
    expect(tool!.deviceAwareHandler).toBeDefined();

    const response = await tool!.deviceAwareHandler!(mockDevice, {
      planContent: VALID_PLAN_YAML,
      startStep: 0,
      platform: "android",
      deviceAllocationTimeoutMs: 5000,
    });

    const payload = JSON.parse(response.content?.[0]?.text ?? "{}");

    // The original error from executePlan should propagate to the catch block
    // NOT a TypeError from accessing result.debug?.steps when result is undefined
    expect(payload.success).toBe(false);
    expect(payload.executedSteps).toBe(0);
    expect(payload.totalSteps).toBe(0);
    expect(payload.error).toContain("Simulated executePlan failure");
    expect(payload.error).not.toContain("TypeError");
    expect(payload.error).not.toContain("Cannot read properties of undefined");
  });

  test("error message preserves the original error details", async () => {
    const tool = ToolRegistry.getTool("executePlan");
    expect(tool).toBeDefined();

    const response = await tool!.deviceAwareHandler!(mockDevice, {
      planContent: VALID_PLAN_YAML,
      startStep: 0,
      platform: "android",
      deviceAllocationTimeoutMs: 5000,
    });

    const payload = JSON.parse(response.content?.[0]?.text ?? "{}");

    // Verify the response contains the specific error message from executePlan
    expect(payload.error).toContain("device disconnected");
  });

  test("rethrows confirmed device loss for the MCP boundary", async () => {
    mockExecutePlan.mockImplementationOnce(() =>
      Promise.reject(new DeviceLostError("emulator-5554", "device-disconnected:emulator-5554")),
    );
    const tool = ToolRegistry.getTool("executePlan");
    expect(tool).toBeDefined();

    await expect(
      tool!.deviceAwareHandler!(mockDevice, {
        planContent: VALID_PLAN_YAML,
        startStep: 0,
        platform: "android",
        deviceAllocationTimeoutMs: 5000,
      }),
    ).rejects.toThrow("device-disconnected:emulator-5554");
  });
});
