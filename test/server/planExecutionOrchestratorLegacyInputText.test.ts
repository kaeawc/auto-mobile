import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { PlanExecutionResult } from "../../src/models";
import * as planUtils from "../../src/utils/planUtils";
import { AndroidSegmentedPlanVideoSession } from "../../src/server/androidSegmentedPlanVideoSession";
import {
  PlanExecutionOrchestrator,
  type VideoRecorder,
} from "../../src/server/planExecutionOrchestrator";
import { FakeTimer } from "../fakes/FakeTimer";

// #10130: the executePlan call's platform is the only platform signal a plan without a
// `platform:` line has, and the orchestrator must hand it to the legacy-step migration.
const legacyPlan = [
  "name: add-note",
  "steps:",
  "  - tool: tapOn",
  '    text: "Notes"',
  "  - tool: inputText",
  '    text: " — follow up"',
  "",
].join("\n");

let execute: ReturnType<typeof spyOn<typeof planUtils, "executePlan">>;
let start: ReturnType<
  typeof spyOn<typeof AndroidSegmentedPlanVideoSession.prototype, "startFirstSegment">
>;
let finalize: ReturnType<
  typeof spyOn<typeof AndroidSegmentedPlanVideoSession.prototype, "finalize">
>;

beforeEach(() => {
  const result: PlanExecutionResult = { success: true, executedSteps: 2, totalSteps: 2 };
  execute = spyOn(planUtils, "executePlan").mockResolvedValue(result);
  start = spyOn(AndroidSegmentedPlanVideoSession.prototype, "startFirstSegment").mockResolvedValue(
    undefined,
  );
  finalize = spyOn(AndroidSegmentedPlanVideoSession.prototype, "finalize").mockResolvedValue({
    filePaths: [],
    recordingIds: [],
    metadata: [],
  });
});
afterEach(() => {
  execute.mockRestore();
  start.mockRestore();
  finalize.mockRestore();
});

async function typeOperationRunningOn(platform: "android" | "ios"): Promise<unknown> {
  const videoRecorder: VideoRecorder = {
    startVideoRecording: async () => {
      throw new Error("unexpected video start");
    },
    stopVideoRecording: async () => {
      throw new Error("unexpected video stop");
    },
  };
  await new PlanExecutionOrchestrator(
    {
      device: { platform, deviceId: "fake-device", name: "Fake" },
      request: {
        platform,
        planContent: legacyPlan,
        startStep: 0,
        deviceAllocationTimeoutMs: 5000,
      },
    },
    {
      timer: new FakeTimer(),
      videoRecorder,
      createSchemaValidator: () => ({
        loadSchema: async () => undefined,
        validateYaml: () => ({ valid: true }),
      }),
    },
  ).execute();
  const executedPlan = execute.mock.calls[0][0];
  expect(executedPlan.steps[1].tool).toBe("sendKeys");
  return executedPlan.steps[1].params.commands[0].operation;
}

test("a legacy inputText step runs as an insert when executePlan is called for iOS", async () => {
  expect(await typeOperationRunningOn("ios")).toBe("insert");
});

test("a legacy inputText step keeps the clearing replace when executePlan is called for Android", async () => {
  expect(await typeOperationRunningOn("android")).toBe("replace");
});
