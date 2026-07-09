import { describe, expect, test, beforeEach, mock } from "bun:test";
import { FakeTimer } from "../fakes/FakeTimer";
import type { BootedDevice } from "../../src/models";
import type { TestExecutionRecord, TestExecutionRepository } from "../../src/db/testExecutionRepository";

// Mock planUtils so the orchestrator's runPlan() phase is observable without
// spinning up a real PlanExecutor. The companion test
// planTools.executePlanThrow.test.ts mocks the same module — keep them compatible.
const executePlanMock = mock(() =>
  Promise.resolve({
    success: true,
    executedSteps: 2,
    totalSteps: 2,
    debug: { executionTimeMs: 100, steps: [] },
  })
);

mock.module("../../src/utils/planUtils", () => {
  const { YamlPlanSerializer } = require("../../src/utils/plan/PlanSerializer");
  const serializer = new YamlPlanSerializer();
  return {
    importPlanFromYaml: serializer.importPlanFromYaml.bind(serializer),
    exportPlanFromLogs: serializer.exportPlanFromLogs.bind(serializer),
    executePlan: executePlanMock,
  };
});

import { PlanExecutionOrchestrator, convertDebugStepsToRecords, VideoRecorder } from "../../src/server/planExecutionOrchestrator";
import { serverConfig } from "../../src/utils/ServerConfig";

const buildVideoRecorder = (
  filePath: string = "/tmp/fake-recording.mp4",
  recordingId: string = "rec-1"
): VideoRecorder => ({
  startVideoRecording: mock(() =>
    Promise.resolve({ recordingId } as any)
  ),
  stopVideoRecording: mock(() =>
    Promise.resolve({ metadata: { filePath } } as any)
  ),
});

const iosDevice: BootedDevice = {
  deviceId: "AAAA1111-BBBB-2222-CCCC-3333DDDD4444",
  name: "iPhone 15 Sim",
  platform: "ios",
  status: "booted",
};

const SIMPLE_PLAN = `
name: simple-test
steps:
  - tool: observe
    params: {}
`;

class FakeTestExecutionRepository {
  recorded: TestExecutionRecord[] = [];
  async recordExecution(record: TestExecutionRecord): Promise<number> {
    this.recorded.push(record);
    return this.recorded.length;
  }
}

const baseRequest = {
  planContent: SIMPLE_PLAN,
  startStep: 0,
  platform: "ios" as const,
  deviceAllocationTimeoutMs: 5000,
};

const baseDeps = () => ({
  timer: new FakeTimer(),
  videoRecorder: buildVideoRecorder(),
});

describe("PlanExecutionOrchestrator", () => {
  beforeEach(() => {
    executePlanMock.mockClear();
    // The plan-execution guard is a process-wide singleton; reset between tests
    // so one run never leaks state into another.
    serverConfig.setPlanExecutionActive(false);
  });

  test("keeps the plan-execution guard active during the run and clears it afterward", async () => {
    let activeDuringRun: boolean | undefined;
    executePlanMock.mockImplementationOnce(() => {
      activeDuringRun = serverConfig.isPlanExecutionActive();
      return Promise.resolve({
        success: true,
        executedSteps: 2,
        totalSteps: 2,
        debug: { executionTimeMs: 1, steps: [] },
      });
    });

    const orchestrator = new PlanExecutionOrchestrator(
      { device: iosDevice, request: baseRequest },
      baseDeps()
    );
    await orchestrator.execute();

    // The guard suppresses the device-disconnect monitor across allocation + run.
    expect(activeDuringRun).toBe(true);
    // It MUST be cleared in finally, or the monitor stays suppressed forever.
    expect(serverConfig.isPlanExecutionActive()).toBe(false);
  });

  test("clears the plan-execution guard even when the plan fails", async () => {
    executePlanMock.mockImplementationOnce(() =>
      Promise.resolve({
        success: false,
        executedSteps: 0,
        totalSteps: 2,
        failedStep: { stepIndex: 0, tool: "observe", error: "boom" },
      })
    );

    const orchestrator = new PlanExecutionOrchestrator(
      { device: iosDevice, request: baseRequest },
      baseDeps()
    );
    await orchestrator.execute();

    expect(serverConfig.isPlanExecutionActive()).toBe(false);
  });

  test("execute() returns a structured success result for a simple plan", async () => {
    const orchestrator = new PlanExecutionOrchestrator(
      { device: iosDevice, request: baseRequest },
      baseDeps()
    );
    const result = await orchestrator.execute();

    expect(result.success).toBe(true);
    expect(result.executedSteps).toBe(2);
    expect(result.totalSteps).toBe(2);
    expect(result.platform).toBe("ios");
    expect(result.deviceId).toBe(iosDevice.deviceId);
    // captureObserveSteps is omitted so debug should NOT appear
    expect(result.debug).toBeUndefined();
    // Video paths are populated because the iOS recording stub succeeds
    expect(result.videoFilePaths).toEqual(["/tmp/fake-recording.mp4"]);
    expect(result.videoRecordingIds).toEqual(["rec-1"]);
  });

  test("execute() includes debug payload when captureObserveSteps is requested", async () => {
    const orchestrator = new PlanExecutionOrchestrator(
      { device: iosDevice, request: { ...baseRequest, captureObserveSteps: "summary" } },
      baseDeps()
    );
    const result = await orchestrator.execute();

    expect(result.success).toBe(true);
    expect(result.debug).toEqual({ executionTimeMs: 100, steps: [] });
  });

  test("execute() rejects invalid YAML with a schema validation error", async () => {
    const orchestrator = new PlanExecutionOrchestrator(
      {
        device: iosDevice,
        request: { ...baseRequest, planContent: "not: a: valid: plan:\n  - missing" },
      },
      baseDeps()
    );
    const result = await orchestrator.execute();

    expect(result.success).toBe(false);
    expect(result.error).toContain("Plan YAML validation failed");
    // Should never bubble TS errors
    expect(result.error ?? "").not.toContain("TypeError");
  });

  test("execute() decodes base64-prefixed plan content", async () => {
    const encoded = "base64:" + Buffer.from(SIMPLE_PLAN, "utf-8").toString("base64");
    const orchestrator = new PlanExecutionOrchestrator(
      { device: iosDevice, request: { ...baseRequest, planContent: encoded } },
      baseDeps()
    );
    const result = await orchestrator.execute();
    expect(result.success).toBe(true);
  });

  test("execute() rejects mismatched devices arg vs plan device declarations", async () => {
    // Plan declares devices [A, B], caller passes [A] — fail-fast.
    const planWithDevices = `
name: multi-device-test
devices:
  - A
  - B
steps:
  - tool: observe
    device: A
    params: {}
`;
    const orchestrator = new PlanExecutionOrchestrator(
      {
        device: iosDevice,
        request: { ...baseRequest, planContent: planWithDevices, devices: ["A"], sessionUuid: "s-1" },
      },
      baseDeps()
    );
    const result = await orchestrator.execute();
    expect(result.success).toBe(false);
    expect(result.error).toContain("Devices list does not match plan devices");
  });

  test("execute() rejects device label without devices list", async () => {
    const orchestrator = new PlanExecutionOrchestrator(
      { device: iosDevice, request: { ...baseRequest, device: "A" } },
      baseDeps()
    );
    const result = await orchestrator.execute();
    expect(result.success).toBe(false);
    expect(result.error).toContain("Device label requires a devices list");
  });

  test("execute() records test execution to the repository when metadata is provided", async () => {
    const fakeRepo = new FakeTestExecutionRepository();
    const fakeTimer = new FakeTimer();

    const orchestrator = new PlanExecutionOrchestrator(
      {
        device: iosDevice,
        request: {
          ...baseRequest,
          testMetadata: { testClass: "FooTest", testMethod: "shouldPass" },
        },
      },
      { ...baseDeps(), timer: fakeTimer, testExecutionRepository: fakeRepo as unknown as TestExecutionRepository }
    );

    const result = await orchestrator.execute();
    expect(result.success).toBe(true);
    expect(fakeRepo.recorded).toHaveLength(1);
    expect(fakeRepo.recorded[0].testClass).toBe("FooTest");
    expect(fakeRepo.recorded[0].testMethod).toBe("shouldPass");
    expect(fakeRepo.recorded[0].status).toBe("passed");
    expect(fakeRepo.recorded[0].deviceId).toBe(iosDevice.deviceId);
    expect(fakeRepo.recorded[0].videoPath).toBe("/tmp/fake-recording.mp4");
  });

  test("execute() skips recording when no testMetadata is provided", async () => {
    const fakeRepo = new FakeTestExecutionRepository();
    const orchestrator = new PlanExecutionOrchestrator(
      { device: iosDevice, request: baseRequest },
      { ...baseDeps(), testExecutionRepository: fakeRepo as unknown as TestExecutionRepository }
    );
    await orchestrator.execute();
    expect(fakeRepo.recorded).toHaveLength(0);
  });

  test("execute() records 'failed' status when executePlan fails", async () => {
    const failingExecutePlan = executePlanMock;
    failingExecutePlan.mockImplementationOnce(() =>
      Promise.resolve({
        success: false,
        executedSteps: 1,
        totalSteps: 2,
        failedStep: { stepIndex: 1, tool: "tapOn", error: "element not found" },
      })
    );
    const fakeRepo = new FakeTestExecutionRepository();
    const orchestrator = new PlanExecutionOrchestrator(
      {
        device: iosDevice,
        request: {
          ...baseRequest,
          testMetadata: { testClass: "FooTest", testMethod: "shouldFail" },
        },
      },
      { ...baseDeps(), testExecutionRepository: fakeRepo as unknown as TestExecutionRepository }
    );
    const result = await orchestrator.execute();
    expect(result.success).toBe(false);
    expect(result.error).toBe("element not found");
    expect(fakeRepo.recorded[0].status).toBe("failed");
    expect(fakeRepo.recorded[0].errorMessage).toBe("element not found");
  });

  test("execute() records skipped optional steps from multi-device per-device results", async () => {
    executePlanMock.mockImplementationOnce(() =>
      Promise.resolve({
        success: true,
        executedSteps: 1,
        totalSteps: 2,
        perDeviceResults: new Map([
          ["device-a", {
            device: "device-a",
            success: true,
            executedSteps: 1,
            totalSteps: 2,
            skippedSteps: [
              {
                stepIndex: 0,
                trackIndex: 0,
                tool: "tapOn",
                error: "element not found",
                durationMs: 250,
                details: {
                  params: { text: "Not Now", device: "device-a" },
                  error: "element not found",
                  optional: true,
                },
              },
            ],
          }],
        ]),
      })
    );
    const fakeRepo = new FakeTestExecutionRepository();
    const orchestrator = new PlanExecutionOrchestrator(
      {
        device: iosDevice,
        request: {
          ...baseRequest,
          testMetadata: { testClass: "FooTest", testMethod: "parallelOptional" },
        },
      },
      { ...baseDeps(), testExecutionRepository: fakeRepo as unknown as TestExecutionRepository }
    );

    const result = await orchestrator.execute();

    expect(result.success).toBe(true);
    expect(fakeRepo.recorded[0].steps).toEqual([
      {
        stepIndex: 0,
        action: "tapOn",
        target: 'text="Not Now"',
        status: "skipped",
        durationMs: 250,
        screenName: null,
        screenshotPath: null,
        errorMessage: "element not found",
        details: {
          device: "device-a",
          trackIndex: 0,
          params: { text: "Not Now", device: "device-a" },
          error: "element not found",
          optional: true,
        },
      },
    ]);
  });

  test("repository write errors are logged and do not crash the run", async () => {
    const exploding = {
      recordExecution: () => Promise.reject(new Error("db down")),
    };
    const orchestrator = new PlanExecutionOrchestrator(
      {
        device: iosDevice,
        request: {
          ...baseRequest,
          testMetadata: { testClass: "FooTest", testMethod: "shouldNotCrash" },
        },
      },
      { timer: new FakeTimer(), testExecutionRepository: exploding as unknown as TestExecutionRepository }
    );
    const result = await orchestrator.execute();
    // Even though recording failed, the plan itself succeeded.
    expect(result.success).toBe(true);
  });
});

describe("convertDebugStepsToRecords", () => {
  test("returns empty array for undefined / empty input", () => {
    expect(convertDebugStepsToRecords(undefined)).toEqual([]);
    expect(convertDebugStepsToRecords([])).toEqual([]);
  });

  test("extracts the tool name from 'Execute step N: toolName' style descriptions", () => {
    const records = convertDebugStepsToRecords([
      { step: "Execute step 0: tapOn", status: "completed", durationMs: 12 },
      { step: "Execute step 1: observe", status: "completed", durationMs: 50 },
    ]);
    expect(records[0].action).toBe("tapOn");
    expect(records[1].action).toBe("observe");
    expect(records[0].stepIndex).toBe(0);
    expect(records[1].stepIndex).toBe(1);
  });

  test("builds a target string from common params", () => {
    const records = convertDebugStepsToRecords([
      {
        step: "Execute step 0: tapOn",
        status: "completed",
        durationMs: 12,
        details: { params: { text: "Submit" } },
      },
      {
        step: "Execute step 1: tapOn",
        status: "completed",
        durationMs: 9,
        details: { params: { elementId: "submit-btn" } },
      },
      {
        step: "Execute step 2: swipeOn",
        status: "completed",
        durationMs: 100,
        details: { params: { direction: "up" } },
      },
    ]);
    expect(records[0].target).toBe('text="Submit"');
    expect(records[1].target).toBe('id="submit-btn"');
    expect(records[2].target).toBe("direction=up");
  });

  test("falls back to the raw step string when no ':' suffix is present", () => {
    const records = convertDebugStepsToRecords([
      { step: "custom-step-name", status: "skipped", durationMs: 0 },
    ]);
    expect(records[0].action).toBe("custom-step-name");
    expect(records[0].target).toBeNull();
  });

  test("propagates error messages from details", () => {
    const records = convertDebugStepsToRecords([
      {
        step: "Execute step 0: tapOn",
        status: "failed",
        durationMs: 12,
        details: { error: "element not found" },
      },
    ]);
    expect(records[0].errorMessage).toBe("element not found");
  });
});
