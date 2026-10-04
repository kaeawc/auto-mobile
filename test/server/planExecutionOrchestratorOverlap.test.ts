import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as planUtils from "../../src/utils/planUtils";
import type { BootedDevice, ExecutePlanResult, PlanExecutionResult } from "../../src/models";
import { DeviceLostError } from "../../src/models/DeviceLostError";
import type { VideoRecordingConfig } from "../../src/models/VideoRecording";
import {
  PlanExecutionOrchestrator,
  type PlanExecutionRequest,
  type VideoRecorder,
} from "../../src/server/planExecutionOrchestrator";
import { serverConfig } from "../../src/utils/ServerConfig";
import { FakeTimer } from "../fakes/FakeTimer";

const iosDevice: BootedDevice = {
  deviceId: "AAAA1111-BBBB-2222-CCCC-3333DDDD4444",
  name: "iPhone 15 Sim",
  platform: "ios",
  status: "booted",
};

const baseRequest: PlanExecutionRequest = {
  planContent: "name: simple-test\nsteps:\n  - tool: observe\n    params: {}\n",
  startStep: 0,
  platform: "ios",
  deviceAllocationTimeoutMs: 5000,
};

const config: VideoRecordingConfig = {
  qualityPreset: "medium",
  targetBitrateKbps: 1000,
  maxThroughputMbps: 1,
  fps: 30,
  maxArchiveSizeMb: 100,
  format: "mp4",
};
const startedAt = new Date(0).toISOString();
const buildVideoRecorder = (): VideoRecorder => ({
  startVideoRecording: async () => ({
    recordingId: "rec-1",
    outputPath: "/tmp/fake-recording.mp4",
    fileName: "fake-recording.mp4",
    startedAt,
    config,
  }),
  stopVideoRecording: async () => ({
    metadata: {
      recordingId: "rec-1",
      filePath: "/tmp/fake-recording.mp4",
      fileName: "fake-recording.mp4",
      format: "mp4",
      sizeBytes: 0,
      createdAt: startedAt,
      startedAt,
      lastAccessedAt: startedAt,
      config,
    },
    evictedRecordingIds: [],
  }),
});
const baseDeps = () => ({
  timer: new FakeTimer(),
  videoRecorder: buildVideoRecorder(),
  createSchemaValidator: () => ({
    loadSchema: async () => undefined,
    validateYaml: () => ({ valid: true }),
  }),
});
const success: PlanExecutionResult = { success: true, executedSteps: 1, totalSteps: 1 };

describe("PlanExecutionOrchestrator overlapping leases", () => {
  let executePlanSpy: ReturnType<typeof spyOn<typeof planUtils, "executePlan">>;
  const runs: Promise<ExecutePlanResult>[] = [];
  const settle: (() => void)[] = [];

  beforeEach(() => {
    serverConfig.setPlanExecutionActive(false);
    executePlanSpy = spyOn(planUtils, "executePlan");
  });

  afterEach(async () => {
    // Finish every deferred run even if an assertion fails, so no lease leaks.
    for (const finish of settle.splice(0)) {
      finish();
    }
    await Promise.allSettled(runs.splice(0));
    executePlanSpy.mockRestore();
    serverConfig.setPlanExecutionActive(false);
  });

  const deferExecution = (signal?: AbortSignal) => {
    const started = Promise.withResolvers<void>();
    const result = Promise.withResolvers<PlanExecutionResult>();
    settle.push(() => result.resolve(success));
    executePlanSpy.mockImplementationOnce((_plan, _step, _platform, _device, _session, actual) => {
      expect(actual).toBe(signal);
      started.resolve();
      return result.promise;
    });
    return { started: started.promise, ...result };
  };

  const startRun = (sessionUuid: string, signal?: AbortSignal) => {
    const run = new PlanExecutionOrchestrator(
      { device: iosDevice, request: { ...baseRequest, sessionUuid }, signal },
      baseDeps(),
    ).execute();
    runs.push(run);
    return run;
  };

  test("single plan is active during execution and inactive afterward", async () => {
    const pending = deferExecution();
    const run = startRun("single");
    await pending.started;
    expect(serverConfig.isPlanExecutionActive()).toBe(true);
    pending.resolve(success);
    expect((await run).success).toBe(true);
    expect(serverConfig.isPlanExecutionActive()).toBe(false);
  });

  test.each(["success", "failed", "reject", "abort", "device-loss"] as const)(
    "%s releases only the finishing plan's lease",
    async (outcome) => {
      const controller = new AbortController();
      const signal =
        outcome === "abort" || outcome === "device-loss" ? controller.signal : undefined;
      const first = deferExecution(signal);
      const firstRun = startRun("first", signal);
      // Observe rejection immediately for the device-loss rethrow path.
      const firstOutcome = firstRun.then(
        (value) => value,
        (error: unknown) => error,
      );
      await first.started;
      const second = deferExecution();
      const secondRun = startRun("second");
      await second.started;
      expect(serverConfig.isPlanExecutionActive()).toBe(true);

      const error =
        outcome === "device-loss"
          ? new DeviceLostError(iosDevice.deviceId, "device disconnected")
          : new Error(outcome === "abort" ? "plan aborted" : "plan rejected");
      if (outcome === "reject") {
        first.reject(error);
      } else if (signal) {
        controller.abort(error);
        first.reject(error);
      } else {
        first.resolve(
          outcome === "failed"
            ? {
                success: false,
                executedSteps: 0,
                totalSteps: 1,
                failedStep: { stepIndex: 0, tool: "observe", error: "plan failed" },
              }
            : success,
        );
      }

      const result = await firstOutcome;
      if (outcome === "device-loss") {
        expect(result).toBe(error);
      } else {
        expect(result).toMatchObject({ success: outcome === "success" });
      }
      expect(serverConfig.isPlanExecutionActive()).toBe(true);
      second.resolve(success);
      expect((await secondRun).success).toBe(true);
      expect(serverConfig.isPlanExecutionActive()).toBe(false);
    },
  );

  test("synchronous executePlan throw releases its share while another plan runs", async () => {
    const pending = deferExecution();
    const run = startRun("running");
    await pending.started;
    executePlanSpy.mockImplementationOnce(() => {
      throw new Error("synchronous failure");
    });
    expect(await startRun("throwing")).toMatchObject({
      success: false,
      error: "Error: synchronous failure",
    });
    expect(serverConfig.isPlanExecutionActive()).toBe(true);
    pending.resolve(success);
    await run;
    expect(serverConfig.isPlanExecutionActive()).toBe(false);
  });

  test("allocation failure releases its share before executePlan is called", async () => {
    const pending = deferExecution();
    const run = startRun("running");
    await pending.started;
    const invalid = new PlanExecutionOrchestrator(
      { device: iosDevice, request: { ...baseRequest, device: "undeclared" } },
      baseDeps(),
    ).execute();
    runs.push(invalid);
    expect(await invalid).toMatchObject({ success: false });
    expect(executePlanSpy).toHaveBeenCalledTimes(1);
    expect(serverConfig.isPlanExecutionActive()).toBe(true);
    pending.resolve(success);
    await run;
    expect(serverConfig.isPlanExecutionActive()).toBe(false);
  });
});
