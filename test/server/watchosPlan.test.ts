import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { z } from "zod/v4";
import { dump, load } from "js-yaml";
import type { BootedDevice, Plan } from "../../src/models";
import { assertToolSupportsDevicePlatform } from "../../src/server/applePlatformToolSupport";
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

const watch: BootedDevice = {
  platform: "watchos",
  deviceId: "AEC5C81F-B29B-4A0C-976A-6081F3617E1C",
  name: "l16836-watch",
};

// The plan recordToolCalls returned for a watch session in the #16836 acceptance run (#18051).
const recordedPlanContent = `name: factory-watch-flow
steps:
  - tool: swipeOn
    params: {direction: up, lookFor: {text: Item 12}}
  - tool: tapOn
    params: {selector: {text: Item 12}}
  - tool: tapOn
    params: {selector: {text: Crown control}}
  - tool: rotateCrown
    params: {delta: 3}
  - tool: observe
    params: {}
  - tool: tapOn
    params: {selector: {elementId: BackButton}}
  - tool: sendKeys
    params: {selector: {text: Note}, commands: [{action: type, text: hello}]}
  - tool: tapOn
    params: {selector: {text: Done}}
`;
const plan = load(recordedPlanContent) as Plan;

describe("executePlan accepts a watch (#18051)", () => {
  test("the request schema accepts platform watchos", () => {
    registerPlanTools();
    const schema = ToolRegistry.getTool("executePlan")!.schema;
    expect(
      schema.safeParse({ planContent: recordedPlanContent, platform: "watchos" }).success,
    ).toBe(true);
  });

  test("the platform gate no longer refuses executePlan on a watch", () => {
    expect(() => assertToolSupportsDevicePlatform("executePlan", watch)).not.toThrow();
  });
});

describe("watchOS plan orchestration", () => {
  let execute: ReturnType<typeof spyOn<typeof planUtils, "executePlan">>;
  beforeEach(() => {
    execute = spyOn(planUtils, "executePlan").mockResolvedValue({
      success: true,
      executedSteps: plan.steps.length,
      totalSteps: plan.steps.length,
    });
  });
  afterEach(() => execute.mockRestore());

  test("replays on watchOS without attempting automatic video and records the platform", async () => {
    const videoRecorder: VideoRecorder = {
      startVideoRecording: mock(async () => {
        throw new Error("watchOS has no plan video recorder");
      }),
      stopVideoRecording: mock(async () => {
        throw new Error("nothing started");
      }),
    };
    const recordExecution = mock(async () => 1);
    const result = await new PlanExecutionOrchestrator(
      {
        device: watch,
        request: {
          platform: "watchos",
          planContent: dump({ ...plan, platform: "watchos" }),
          startStep: 0,
          deviceAllocationTimeoutMs: 5000,
          testMetadata: { testClass: "Watch", testMethod: "factory" },
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
    expect(result).toMatchObject({ success: true, platform: "watchos", deviceId: watch.deviceId });
    expect(result.videoFilePaths ?? []).toEqual([]);
    expect(result.videoWarnings).toBeUndefined();
    expect(videoRecorder.startVideoRecording).not.toHaveBeenCalled();
    expect(execute.mock.calls[0]?.[0]).toMatchObject(plan);
    expect(execute.mock.calls[0]?.slice(2, 4)).toEqual(["watchos", watch.deviceId]);
    expect(recordExecution).toHaveBeenCalledWith(
      expect.objectContaining({ devicePlatform: "watchos", status: "passed" }),
    );
    registerPlanTools();
    expect(ToolRegistry.getTool("executePlan")!.outputSchema!.safeParse(result).success).toBe(true);
  });
});

describe("watchOS replay uses the per-tool platform gate", () => {
  const session = "watch-plan-session";
  let handled: Array<{ tool: string; device: BootedDevice; params: Record<string, unknown> }>;
  let restore: () => void;
  let restorePipeline: () => void;
  beforeEach(() => {
    handled = [];
    for (const tool of ["swipeOn", "tapOn", "rotateCrown", "observe", "sendKeys", "pinchOn"]) {
      ToolRegistry.registerDeviceAware(
        tool,
        "Fake watch tool",
        z.looseObject({}),
        async (device, params) => {
          handled.push({ tool, device, params });
          return createStructuredToolResponse({ success: true });
        },
      );
    }
    const previous = ToolRegistry.getCollaboratorsForTesting();
    const readiness = new FakeDeviceReadiness();
    readiness.setConnectedDevices([watch]);
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
    registerDirectSessionDevice(session, watch);
  });
  afterEach(() => {
    unregisterDirectSession(session);
    restorePipeline();
    restore();
  });

  test("replays the recorded watch plan step by step on the watch session", async () => {
    const result = await planUtils
      .createDefaultPlanExecutor(new FakeTimer())
      .executePlan(plan, 0, "watchos", watch.deviceId, session);
    expect(result).toMatchObject({ success: true, executedSteps: 8, totalSteps: 8 });
    expect(handled.map(({ tool }) => tool)).toEqual(plan.steps.map(({ tool }) => tool));
    expect(
      handled.every(
        ({ device }) => device.deviceId === watch.deviceId && device.platform === "watchos",
      ),
    ).toBe(true);
    expect(handled.map(({ params }) => params.selector)).toEqual(
      plan.steps.map(({ params }) => params.selector),
    );
  });

  test("refuses a step whose tool is not watch-supported before its handler runs", async () => {
    const result = await planUtils
      .createDefaultPlanExecutor(new FakeTimer())
      .executePlan(
        { name: "unsupported-gesture", steps: [{ tool: "pinchOn", params: {} }, ...plan.steps] },
        0,
        "watchos",
        watch.deviceId,
        session,
      );
    expect(result.success).toBe(false);
    expect(result.failedStep).toMatchObject({
      stepIndex: 0,
      tool: "pinchOn",
      error: expect.stringContaining(
        "pinchOn does not support watchOS yet. Target an Android or iOS device instead.",
      ),
    });
    // Only the failure observation runs; no plan step's handler does.
    expect(handled.map(({ tool }) => tool)).toEqual(["observe"]);
    expect(handled[0]?.params.selector).toBeUndefined();
  });
});
