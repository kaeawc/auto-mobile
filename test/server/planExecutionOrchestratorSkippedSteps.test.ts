import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import type { PlanExecutionResult } from "../../src/models";
import * as planUtils from "../../src/utils/planUtils";
import { AndroidSegmentedPlanVideoSession } from "../../src/server/androidSegmentedPlanVideoSession";
import {
  PlanExecutionOrchestrator,
  type VideoRecorder,
} from "../../src/server/planExecutionOrchestrator";
import { FakeTimer } from "../fakes/FakeTimer";

const base: PlanExecutionResult = { success: true, executedSteps: 1, totalSteps: 2 };
let execute: ReturnType<typeof spyOn<typeof planUtils, "executePlan">>;
let start: ReturnType<
  typeof spyOn<typeof AndroidSegmentedPlanVideoSession.prototype, "startFirstSegment">
>;
let finalize: ReturnType<
  typeof spyOn<typeof AndroidSegmentedPlanVideoSession.prototype, "finalize">
>;

beforeEach(() => {
  execute = spyOn(planUtils, "executePlan").mockResolvedValue(base);
  // Inject the video boundary, like the video warnings harness, without resolving the real DB.
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

function run() {
  const videoRecorder: VideoRecorder = {
    startVideoRecording: async () => {
      throw new Error("unexpected video start");
    },
    stopVideoRecording: async () => {
      throw new Error("unexpected video stop");
    },
  };
  return new PlanExecutionOrchestrator(
    {
      device: { platform: "android", deviceId: "fake-device", name: "Fake" },
      request: {
        platform: "android",
        planContent: "name: skipped-test\nsteps:\n  - tool: observe\n    params: {}\n",
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
}

test.each([true, false])(
  "skippedSteps reaches response without captureObserveSteps on success=%s",
  async (success) => {
    const skippedSteps = [{ stepIndex: 0, tool: "tapOn", error: "element not found" }];
    const failedStep = { stepIndex: 1, tool: "observe", error: "required step failed" };
    execute.mockResolvedValue({
      ...base,
      success,
      skippedSteps,
      ...(success ? {} : { failedStep }),
    });
    const result = await run();
    expect(result).toMatchObject({ success, executedSteps: 1, totalSteps: 2, skippedSteps });
    expect(result).not.toHaveProperty("debug");
  },
);

test.each([{ skippedSteps: undefined }, { skippedSteps: [] }])(
  "no skips omits the skippedSteps key (%j)",
  async ({ skippedSteps }) => {
    execute.mockResolvedValue({ ...base, skippedSteps });
    expect(await run()).not.toHaveProperty("skippedSteps");
  },
);

test("failed criticalSection warnings reach the response without captureObserveSteps", async () => {
  const warnings = [
    { stepIndex: 0, tool: "sendKeys", warnings: ["keyboard dismissal failed"] },
    {
      stepIndex: 1,
      tool: "criticalSection",
      device: "A",
      warnings: [
        "step 1 (sendKeys): keyboard dismissal failed",
        "step 2 (tapOn): optional step failed; skipped: element not found",
      ],
    },
  ];
  const failedStep = {
    stepIndex: 1,
    tool: "criticalSection",
    error: "required sub-step failed",
    failureObservation: { capturedAtMs: 0, activeWindow: { appId: "fake.app" } },
  };
  execute.mockResolvedValue({ ...base, success: false, warnings, failedStep });
  const result = await run();
  expect(result).toMatchObject({ success: false, warnings, failedStep, error: failedStep.error });
  expect(result).not.toHaveProperty("debug");
});

test.each([{ warnings: undefined }, { warnings: [] }])(
  "failure with no warnings omits the warnings key (%j)",
  async ({ warnings }) => {
    execute.mockResolvedValue({
      ...base,
      success: false,
      warnings,
      failedStep: { stepIndex: 1, tool: "criticalSection", error: "required failure" },
    });
    expect(await run()).not.toHaveProperty("warnings");
  },
);
