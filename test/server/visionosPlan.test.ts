import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { z } from "zod/v4";
import { dump } from "js-yaml";
import type { BootedDevice, Plan } from "../../src/models";
import {
  PlanExecutionOrchestrator,
  type VideoRecorder,
} from "../../src/server/planExecutionOrchestrator";
import * as planUtils from "../../src/server/planExecutorFactory";
import { registerPlanTools } from "../../src/server/planTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import {
  registerDirectSessionDevice,
  unregisterDirectSession,
} from "../../src/utils/directSessionDeviceRegistry";
import { createStructuredToolResponse } from "../../src/utils/toolUtils";
import { FakeDeviceReadiness } from "../fakes/FakeDeviceReadiness";
import { FakeDisplayInventoryProvider } from "../fakes/FakeDisplayInventoryProvider";
import { FakeTimer } from "../fakes/FakeTimer";
import { isolateEmptyToolRegistry } from "../helpers/withTemporaryTool";

isolateEmptyToolRegistry();

const headset: BootedDevice = {
  platform: "visionos",
  deviceId: "VISION-UDID",
  name: "Apple Vision Pro",
};
const plan: Plan = {
  name: "vision-window",
  steps: [
    { tool: "launchApp", params: { appId: "com.example.window" } },
    { tool: "tapOn", params: { action: "tap", selector: { text: "Details" } } },
    { tool: "tapOn", params: { action: "tap", selector: { elementId: "DetailsButton" } } },
    { tool: "observe", params: {} },
    { tool: "tapOn", params: { action: "tap", selector: { elementId: "BackButton" } } },
  ],
};

describe("visionOS plan orchestration", () => {
  let execute: ReturnType<typeof spyOn<typeof planUtils, "executePlan">>;
  beforeEach(() => {
    execute = spyOn(planUtils, "executePlan").mockResolvedValue({
      success: true,
      executedSteps: 5,
      totalSteps: 5,
    });
  });
  afterEach(() => execute.mockRestore());

  test("replays on visionOS without attempting automatic video and records the platform", async () => {
    const videoRecorder: VideoRecorder = {
      startVideoRecording: mock(async () => {
        throw new Error("visionOS has no video recorder");
      }),
      stopVideoRecording: mock(async () => {
        throw new Error("nothing started");
      }),
    };
    const recordExecution = mock(async () => 1);
    const result = await new PlanExecutionOrchestrator(
      {
        device: headset,
        request: {
          platform: "visionos",
          planContent: dump({ ...plan, platform: "visionos" }),
          startStep: 0,
          deviceAllocationTimeoutMs: 5000,
          testMetadata: { testClass: "Vision", testMethod: "window" },
        },
      },
      {
        timer: new FakeTimer(),
        videoRecorder,
        testExecutionRepository: { recordExecution },
        createSchemaValidator: () => ({
          loadSchema: async () => undefined,
          validateYaml: () => ({ valid: true }),
        }),
      },
    ).execute();
    expect(result).toMatchObject({
      success: true,
      platform: "visionos",
      deviceId: headset.deviceId,
    });
    expect(result.videoFilePaths ?? []).toEqual([]);
    expect(result.videoRecordingIds ?? []).toEqual([]);
    expect(result.videoWarnings).toBeUndefined();
    expect(videoRecorder.startVideoRecording).not.toHaveBeenCalled();
    expect(videoRecorder.stopVideoRecording).not.toHaveBeenCalled();
    expect(execute.mock.calls[0]?.[0]).toMatchObject(plan);
    expect(execute.mock.calls[0]?.slice(2, 4)).toEqual(["visionos", headset.deviceId]);
    expect(recordExecution).toHaveBeenCalledWith(
      expect.objectContaining({ devicePlatform: "visionos", status: "passed" }),
    );
    registerPlanTools();
    expect(ToolRegistry.getTool("executePlan")!.outputSchema!.safeParse(result).success).toBe(true);
  });
});

describe("visionOS replay uses the per-tool platform gate", () => {
  const session = "vision-plan-session";
  let handled: Array<{ tool: string; device: BootedDevice; params: Record<string, unknown> }>;
  let restore: () => void;
  let restorePipeline: () => void;
  beforeEach(() => {
    handled = [];
    for (const tool of ["launchApp", "tapOn", "observe", "swipeOn"]) {
      ToolRegistry.registerDeviceAware(
        tool,
        "Fake window-app tool",
        z.looseObject({}),
        async (device, params) => {
          handled.push({ tool, device, params });
          return createStructuredToolResponse({ success: true });
        },
      );
    }
    const previous = ToolRegistry.getCollaboratorsForTesting();
    const readiness = new FakeDeviceReadiness();
    readiness.setConnectedDevices([headset]);
    ToolRegistry.setCollaboratorsForTesting({
      deviceReadiness: readiness,
      toolCallRepository: { async recordToolCall() {} },
    });
    restore = () =>
      ToolRegistry.setCollaboratorsForTesting({
        deviceReadiness: previous.deviceReadiness,
        toolCallRepository: previous.toolCallRepository,
      });
    restorePipeline = ToolRegistry.setPipelineOverridesForTesting({
      displayInventory: new FakeDisplayInventoryProvider(),
    });
    registerDirectSessionDevice(session, headset);
  });
  afterEach(() => {
    unregisterDirectSession(session);
    restorePipeline();
    restore();
  });

  test("replays launch, text and identifier taps, observe and BackButton on the visionOS session", async () => {
    const result = await planUtils
      .createDefaultPlanExecutor(new FakeTimer())
      .executePlan(plan, 0, "visionos", headset.deviceId, session);
    expect(result).toMatchObject({ success: true, executedSteps: 5, totalSteps: 5 });
    expect(handled.map(({ tool }) => tool)).toEqual(plan.steps.map(({ tool }) => tool));
    expect(
      handled.every(
        ({ device }) => device.deviceId === headset.deviceId && device.platform === "visionos",
      ),
    ).toBe(true);
    expect(handled.map(({ params }) => params.selector)).toEqual(
      plan.steps.map(({ params }) => params.selector),
    );
  });

  test("refuses a non-allowlisted swipeOn step before its handler runs", async () => {
    const result = await planUtils.createDefaultPlanExecutor(new FakeTimer()).executePlan(
      {
        name: "unsupported-gesture",
        steps: [{ tool: "swipeOn", params: { direction: "up" } }, ...plan.steps],
      },
      0,
      "visionos",
      headset.deviceId,
      session,
    );
    expect(result.success).toBe(false);
    expect(result.failedStep).toMatchObject({
      stepIndex: 0,
      tool: "swipeOn",
      error: expect.stringContaining(
        "swipeOn does not support visionOS yet. Target an Android or iOS device instead.",
      ),
    });
    expect(handled.some(({ tool }) => tool === "swipeOn" || tool === "launchApp")).toBe(false);
  });
});
