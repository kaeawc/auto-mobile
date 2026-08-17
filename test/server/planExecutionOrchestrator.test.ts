import { describe, expect, test, beforeEach, afterAll, mock } from "bun:test";
import os from "node:os";
import path from "node:path";
import { promises as fsPromises } from "node:fs";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import type { BootedDevice } from "../../src/models";
import type { TestExecutionRecord, TestExecutionRepository } from "../../src/db/testExecutionRepository";
import { ANDROID_PLAN_VIDEO_SEGMENT_ROTATE_MS } from "../../src/features/video/androidScreenrecord";
import { DaemonState } from "../../src/daemon/daemonState";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { runWithToolCapabilityContext } from "../../src/features/toolCapabilities/toolCapabilityContext";
import { resolveCapabilityBaseSessionUuid } from "../../src/features/toolCapabilities/capabilitySessionResolver";
import { ExecutionTracker } from "../../src/server/executionTracker";

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

const androidDevice: BootedDevice = {
  deviceId: "emulator-5554",
  name: "Android Emulator",
  platform: "android",
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
  // Temp dirs created by the android manifest test; removed after the suite.
  const manifestTempDirs: string[] = [];

  afterAll(async () => {
    for (const dir of manifestTempDirs) {
      await fsPromises.rm(dir, { recursive: true, force: true });
    }
  });

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

  test("keeps every labeled session assigned when allocation crosses idle expiry", async () => {
    const timer = new FakeTimer();
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    const secondAndroidDevice: BootedDevice = {
      ...androidDevice,
      deviceId: "emulator-5556",
      name: "Android Emulator 2",
    };
    const devicePool = new DevicePool(
      sessionManager,
      "daemon-session",
      timer,
    );
    DaemonState.getInstance().initialize(sessionManager, devicePool);
    const executionTracker = new ExecutionTracker(timer);
    executionTracker.startExecution("executePlan", undefined, "base");
    sessionManager.setActiveSessionExecutionChecker((sessionId, query) =>
      executionTracker.hasActiveSessionUuidExecutions(
        resolveCapabilityBaseSessionUuid(sessionId, sessionManager),
        query,
      ),
    );

    devicePool.assignMultipleDevices = async sessionIds => {
      const assignments = new Map<string, string>();
      for (const [index, sessionId] of sessionIds.entries()) {
        const device = index === 0 ? androidDevice : secondAndroidDevice;
        const session = await sessionManager.createSession(sessionId, device.deviceId, "android");
        session.expiresAt = timer.now();
        assignments.set(sessionId, device.deviceId);
      }
      timer.advanceTime(1);
      return assignments;
    };
    devicePool.assignDeviceToSession = async () => {
      throw new Error("expired labeled sessions must not be recreated");
    };
    const trackSessionSetup = sessionManager.trackSessionSetup.bind(sessionManager);
    sessionManager.trackSessionSetup = async (session, setup) => {
      await trackSessionSetup(session, setup);
      if (session.sessionId === "base") {
        sessionManager.cleanupExpiredSessions();
      }
    };

    const multiDevicePlan = `
name: multi-device-test
devices:
  - A
  - B
steps:
  - tool: observe
    device: A
    params: {}
`;

    try {
      const result = await runWithToolCapabilityContext(
        { execution: { executionId: "plan-execution", startTime: 0 } },
        () => new PlanExecutionOrchestrator(
          {
            device: androidDevice,
            request: {
              ...baseRequest,
              planContent: multiDevicePlan,
              platform: "android",
              sessionUuid: "base",
              device: "A",
              devices: ["A", "B"],
            },
          },
          { ...baseDeps(), timer },
        ).execute(),
      );

      expect(result).toMatchObject({ success: true });
      expect(sessionManager.getSession("base")).not.toBeNull();
      expect(sessionManager.getSession("base:B")).not.toBeNull();
    } finally {
      DaemonState.getInstance().reset();
      sessionManager.stopCleanupTimer();
    }
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

  test("android plan run writes a segments.json manifest with ordered segments (#3905 plan path)", async () => {
    // Real temp dir so writeSegmentManifest has a writable directory (all segments
    // share it, so the manifest lands next to the first segment).
    const segmentDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "auto-mobile-plan-video-"));
    manifestTempDirs.push(segmentDir);

    // The fake recorder maps recordingId === outputName, and filePath === <segmentDir>/<id>.mp4,
    // so each rotated segment gets a distinct, deterministic path.
    const startedNames: string[] = [];
    const androidRecorder: VideoRecorder = {
      startVideoRecording: mock((options: any) => {
        const id = options.outputName as string;
        startedNames.push(id);
        return Promise.resolve({
          recordingId: id,
          outputPath: path.join(segmentDir, `${id}.mp4`),
          fileName: `${id}.mp4`,
          startedAt: new Date(0).toISOString(),
          outputName: id,
        } as any);
      }),
      stopVideoRecording: mock((recordingId?: string) =>
        Promise.resolve({
          metadata: { recordingId, filePath: path.join(segmentDir, `${recordingId}.mp4`) },
          evictedRecordingIds: [],
        } as any)
      ),
    };

    const fakeTimer = new FakeTimer();
    // Drive step-based rotation: advance past the rotate window and invoke the
    // orchestrator-supplied onBeforePlanStep hook twice, so finalize returns 3 ordered segments.
    executePlanMock.mockImplementationOnce(async (...args: any[]) => {
      const options = args[7] as { onBeforePlanStep?: () => Promise<void> } | undefined;
      if (options?.onBeforePlanStep) {
        fakeTimer.advanceTime(ANDROID_PLAN_VIDEO_SEGMENT_ROTATE_MS + 1);
        await options.onBeforePlanStep();
        fakeTimer.advanceTime(ANDROID_PLAN_VIDEO_SEGMENT_ROTATE_MS + 1);
        await options.onBeforePlanStep();
      }
      return {
        success: true,
        executedSteps: 2,
        totalSteps: 2,
        debug: { executionTimeMs: 1, steps: [] },
      };
    });

    const orchestrator = new PlanExecutionOrchestrator(
      { device: androidDevice, request: { ...baseRequest, platform: "android" } },
      { timer: fakeTimer, videoRecorder: androidRecorder }
    );
    const result = await orchestrator.execute();

    expect(result.success).toBe(true);
    // Three segments: the first plus two rotations.
    expect(result.videoRecordingIds).toEqual(startedNames);
    expect(result.videoRecordingIds).toHaveLength(3);

    // The manifest lives next to the first segment and lists every segment in order.
    const manifestPath = path.join(segmentDir, "segments.json");
    const manifest = JSON.parse(await fsPromises.readFile(manifestPath, "utf8"));
    expect(manifest.sessionId).toBe(result.videoRecordingIds![0]);
    expect(manifest.segmentCount).toBe(3);
    expect(manifest.segments).toEqual(
      result.videoRecordingIds!.map((recordingId, index) => ({
        index,
        recordingId,
        filePath: path.join(segmentDir, `${recordingId}.mp4`),
      }))
    );
  });

  test("android plan run: a failing manifest write is best-effort and does not fail the run", async () => {
    // Segments land in a directory that does not exist, so writeSegmentManifest's
    // fs.writeFile rejects with ENOENT. The write is best-effort (log-and-continue),
    // so the plan run must still succeed and still surface the recording ids.
    const missingDir = path.join(os.tmpdir(), "auto-mobile-plan-video-missing", "nope");
    const androidRecorder: VideoRecorder = {
      startVideoRecording: mock((options: any) =>
        Promise.resolve({
          recordingId: options.outputName as string,
          outputPath: path.join(missingDir, `${options.outputName}.mp4`),
          fileName: `${options.outputName}.mp4`,
          startedAt: new Date(0).toISOString(),
          outputName: options.outputName,
        } as any)
      ),
      stopVideoRecording: mock((recordingId?: string) =>
        Promise.resolve({
          metadata: { recordingId, filePath: path.join(missingDir, `${recordingId}.mp4`) },
          evictedRecordingIds: [],
        } as any)
      ),
    };

    const orchestrator = new PlanExecutionOrchestrator(
      { device: androidDevice, request: { ...baseRequest, platform: "android" } },
      { timer: new FakeTimer(), videoRecorder: androidRecorder }
    );
    const result = await orchestrator.execute();

    expect(result.success).toBe(true);
    // Finalize still returns the segment even though the manifest could not be written.
    expect(result.videoRecordingIds).toHaveLength(1);
    // No manifest was written (the target directory does not exist).
    await expect(fsPromises.access(path.join(missingDir, "segments.json"))).rejects.toThrow();
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
