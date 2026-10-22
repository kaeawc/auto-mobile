import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { toolIsError, toolJson, toolStructured } from "../helpers/toolResponse";
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { registerPlanTools } from "../../src/server/planTools";
import * as realDeviceGestureRecordingManager from "../../src/daemon/deviceGestureRecordingManager";
import { ToolRegistry } from "../../src/server/toolRegistry";

isolateToolRegistry();

const realStartDeviceGestureRecording =
  realDeviceGestureRecordingManager.startDeviceGestureRecording;
const realStopDeviceGestureRecording = realDeviceGestureRecordingManager.stopDeviceGestureRecording;
const realGetDeviceGestureRecordingStatus =
  realDeviceGestureRecordingManager.getDeviceGestureRecordingStatus;

describe("exportPlan tool", () => {
  const mockStopDeviceGestureRecording = mock(() =>
    Promise.resolve({
      recordingId: "rec-123",
      startedAt: "2024-01-01T00:00:00.000Z",
      stoppedAt: "2024-01-01T00:01:00.000Z",
      durationMs: 60000,
      planName: "test-plan",
      planContent: "name: test-plan\nsteps:\n  - tool: tapOn\n    params:\n      text: Button\n",
      stepCount: 1,
      deviceId: "emulator-5554",
      platform: "android",
    }),
  );

  const mockGetDeviceGestureRecordingStatus = mock(() => ({
    recordingId: "rec-123",
    deviceId: "emulator-5554",
    platform: "android",
    startedAt: "2024-01-01T00:00:00.000Z",
    eventCount: 5,
    durationMs: 30000,
  }));

  beforeAll(() => {
    if (!ToolRegistry.getTool("exportPlan")) {
      registerPlanTools();
    }
  });

  afterEach(() => {
    mockStopDeviceGestureRecording.mockClear();
    mockGetDeviceGestureRecordingStatus.mockClear();
  });

  afterAll(() => {
    void mock.module("../../src/daemon/deviceGestureRecordingManager", () => ({
      startDeviceGestureRecording: realStartDeviceGestureRecording,
      stopDeviceGestureRecording: realStopDeviceGestureRecording,
      getDeviceGestureRecordingStatus: realGetDeviceGestureRecordingStatus,
    }));
  });

  test("successfully exports plan from active recording", async () => {
    void mock.module("../../src/daemon/deviceGestureRecordingManager", () => ({
      stopDeviceGestureRecording: mockStopDeviceGestureRecording,
      getDeviceGestureRecordingStatus: mockGetDeviceGestureRecordingStatus,
    }));

    const tool = ToolRegistry.getTool("exportPlan");
    expect(tool).toBeDefined();
    expect(tool!.handler).toBeDefined();

    const response = await tool!.handler({});
    const payload = toolJson(response);

    expect(payload.success).toBe(true);
    expect(toolIsError(response)).toBe(false);
    expect(toolStructured(response)).toEqual(payload);
    expect(payload.recordingId).toBe("rec-123");
    expect(payload.planName).toBe("test-plan");
    expect(payload.planContent).toContain("name: test-plan");
    expect(payload.stepCount).toBe(1);
    expect(payload.durationMs).toBe(60000);
  });

  test("partial-plan warning survives the existing export output schema", async () => {
    const error =
      "Warning: Touch track (getevent) stopped 1250 ms after recording start: code 1. Later taps may be missing.";
    const partialResult = { ...(await mockStopDeviceGestureRecording()), error };
    void mock.module("../../src/daemon/deviceGestureRecordingManager", () => ({
      stopDeviceGestureRecording: mock(() => Promise.resolve(partialResult)),
      getDeviceGestureRecordingStatus: mockGetDeviceGestureRecordingStatus,
    }));
    const tool = ToolRegistry.getTool("exportPlan")!;
    const outputSchema = tool.outputSchema!;
    const response = await tool.handler({});
    const payload = toolJson(response);
    expect(payload.success).toBe(true);
    expect(toolIsError(response)).toBe(false);
    expect(toolStructured(response)).toEqual(payload);
    expect(payload.error).toBe(error);
    expect(payload.planContent).toBe(partialResult.planContent);
    expect(outputSchema.parse(payload)).toEqual(payload);
    expect(outputSchema.parse({ ...payload, warnings: ["x"] })).not.toHaveProperty("warnings");
  });

  test("getevent failure uses the existing export error field", async () => {
    void mock.module("../../src/daemon/deviceGestureRecordingManager", () => ({
      stopDeviceGestureRecording: mock(() =>
        Promise.reject(
          new Error("Failed to stop device gesture recording: Touch track (getevent) spawn failed"),
        ),
      ),
      getDeviceGestureRecordingStatus: mockGetDeviceGestureRecordingStatus,
    }));
    const tool = ToolRegistry.getTool("exportPlan")!;
    const response = await tool.handler({});
    const payload = toolJson(response);
    expect(payload.success).toBe(false);
    expect(toolIsError(response)).toBe(true);
    expect(toolStructured(response)).toEqual(payload);
    expect(payload.error).toContain("Touch track (getevent) spawn failed");
    expect(tool.outputSchema?.parse(payload)).toEqual(payload);
  });

  test("nothing captured is a typed user-input failure", async () => {
    const error = new realDeviceGestureRecordingManager.NoUserInputCapturedError();
    void mock.module("../../src/daemon/deviceGestureRecordingManager", () => ({
      stopDeviceGestureRecording: mock(() => Promise.reject(error)),
      getDeviceGestureRecordingStatus: mockGetDeviceGestureRecordingStatus,
    }));
    const response = await ToolRegistry.getTool("exportPlan")!.handler({});
    const payload = { success: false, error: error.message, reason: "no_user_input_captured" };
    expect(toolIsError(response)).toBe(true);
    expect(toolStructured(response)).toEqual(payload);
    expect(toolJson(response)).toEqual(payload);
    expect(ToolRegistry.getTool("exportPlan")!.outputSchema?.parse(payload)).toEqual(payload);
  });

  test("returns error when no active recording", async () => {
    void mock.module("../../src/daemon/deviceGestureRecordingManager", () => ({
      stopDeviceGestureRecording: mockStopDeviceGestureRecording,
      getDeviceGestureRecordingStatus: mock(() => null),
    }));

    const tool = ToolRegistry.getTool("exportPlan");
    expect(tool).toBeDefined();

    const response = await tool!.handler({});
    const payload = toolJson(response);

    expect(payload.success).toBe(false);
    expect(toolIsError(response)).toBe(true);
    expect(toolStructured(response)).toEqual(payload);
    expect(payload.error).toContain("No active recording");
  });

  test("returns error when recording ID does not match", async () => {
    void mock.module("../../src/daemon/deviceGestureRecordingManager", () => ({
      stopDeviceGestureRecording: mockStopDeviceGestureRecording,
      getDeviceGestureRecordingStatus: mockGetDeviceGestureRecordingStatus,
    }));

    const tool = ToolRegistry.getTool("exportPlan");
    expect(tool).toBeDefined();

    const response = await tool!.handler({ recordingId: "wrong-id" });
    const payload = toolJson(response);

    expect(payload.success).toBe(false);
    expect(toolIsError(response)).toBe(true);
    expect(toolStructured(response)).toEqual(payload);
    expect(payload.error).toContain("does not match active recording");
  });

  test("respects optional planName parameter", async () => {
    const customPlanName = "my-custom-plan";
    const mockStopWithName = mock(() =>
      Promise.resolve({
        recordingId: "rec-123",
        startedAt: "2024-01-01T00:00:00.000Z",
        stoppedAt: "2024-01-01T00:01:00.000Z",
        durationMs: 60000,
        planName: customPlanName,
        planContent: `name: ${customPlanName}\nsteps:\n  - tool: tapOn\n    params:\n      text: Button\n`,
        stepCount: 1,
        deviceId: "emulator-5554",
        platform: "android",
      }),
    );

    void mock.module("../../src/daemon/deviceGestureRecordingManager", () => ({
      stopDeviceGestureRecording: mockStopWithName,
      getDeviceGestureRecordingStatus: mockGetDeviceGestureRecordingStatus,
    }));

    const tool = ToolRegistry.getTool("exportPlan");
    expect(tool).toBeDefined();

    const response = await tool!.handler({ planName: customPlanName });
    const payload = toolJson(response);

    expect(payload.success).toBe(true);
    expect(toolIsError(response)).toBe(false);
    expect(toolStructured(response)).toEqual(payload);
    expect(payload.planName).toBe(customPlanName);
  });

  test("respects optional recordingId parameter", async () => {
    void mock.module("../../src/daemon/deviceGestureRecordingManager", () => ({
      stopDeviceGestureRecording: mockStopDeviceGestureRecording,
      getDeviceGestureRecordingStatus: mockGetDeviceGestureRecordingStatus,
    }));

    const tool = ToolRegistry.getTool("exportPlan");
    expect(tool).toBeDefined();

    const response = await tool!.handler({ recordingId: "rec-123" });
    const payload = toolJson(response);

    expect(payload.success).toBe(true);
    expect(toolIsError(response)).toBe(false);
    expect(toolStructured(response)).toEqual(payload);
    expect(payload.recordingId).toBe("rec-123");
  });
});
