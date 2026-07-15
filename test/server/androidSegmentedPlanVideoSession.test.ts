import { describe, expect, mock, test } from "bun:test";
import { AndroidSegmentedPlanVideoSession } from "../../src/server/androidSegmentedPlanVideoSession";
import type { BootedDevice } from "../../src/models";
import type { Timer } from "../../src/utils/SystemTimer";
import { defaultTimer } from "../../src/utils/SystemTimer";
import type { VideoRecordingHighlightInput } from "../../src/models";

const androidDevice: BootedDevice = {
  deviceId: "emulator-5554",
  platform: "android",
  name: "TestEmu",
};

const lowConfig = {
  qualityPreset: "low" as const,
  targetBitrateKbps: 1000,
  maxThroughputMbps: 5,
  fps: 15,
  maxArchiveSizeMb: 100,
  format: "mp4" as const,
};

const boxHighlightShape = {
  type: "box" as const,
  bounds: {
    x: 1,
    y: 2,
    width: 3,
    height: 4,
  },
};

function makeStopMetadata(recordingId: string, filePath: string) {
  return {
    recordingId,
    fileName: `${recordingId}.mp4`,
    filePath,
    format: "mp4" as const,
    sizeBytes: 1,
    codec: "h264",
    createdAt: "",
    startedAt: "",
    lastAccessedAt: "",
    config: lowConfig,
  };
}

function makeActiveRecording(id: string, outputPath: string) {
  return {
    recordingId: id,
    outputPath,
    fileName: `${id}.mp4`,
    startedAt: new Date().toISOString(),
    config: lowConfig,
    outputName: undefined,
  };
}

describe("AndroidSegmentedPlanVideoSession", () => {
  test("finalize stops the active segment and returns its path", async () => {
    const start = mock(async () => makeActiveRecording("r1", "/tmp/r1.mp4"));
    const stop = mock(async () => ({
      metadata: makeStopMetadata("r1", "/tmp/r1.mp4"),
      evictedRecordingIds: [] as string[],
    }));

    const session = new AndroidSegmentedPlanVideoSession({
      device: androidDevice,
      outputNamePrefix: "plan-a",
      startVideoRecording: start,
      stopVideoRecording: stop,
    });

    await session.startFirstSegment();
    const out = await session.finalize();

    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(out.filePaths).toEqual(["/tmp/r1.mp4"]);
    expect(out.recordingIds).toEqual(["r1"]);
  });

  test("onBeforePlanStep rotates after segmentRotateAfterMs", async () => {
    let now = 0;
    const timer: Timer = {
      now: () => now,
      sleep: defaultTimer.sleep.bind(defaultTimer),
      setTimeout: defaultTimer.setTimeout.bind(defaultTimer),
      clearTimeout: defaultTimer.clearTimeout.bind(defaultTimer),
      setInterval: defaultTimer.setInterval.bind(defaultTimer),
      clearInterval: defaultTimer.clearInterval.bind(defaultTimer),
    };

    const start = mock(async (req: { outputName?: string }) =>
      makeActiveRecording(`id-${req.outputName}`, `/tmp/${req.outputName}.mp4`)
    );
    const stop = mock(async (id: string | undefined) => {
      const rid = id ?? "x";
      return {
        metadata: makeStopMetadata(rid, `/tmp/${rid}.mp4`),
        evictedRecordingIds: [] as string[],
      };
    });

    const session = new AndroidSegmentedPlanVideoSession({
      device: androidDevice,
      outputNamePrefix: "plan-b",
      timer,
      segmentRotateAfterMs: 1000,
      startVideoRecording: start,
      stopVideoRecording: stop,
    });

    await session.startFirstSegment();
    expect(start).toHaveBeenCalledTimes(1);

    await session.onBeforePlanStep();
    expect(stop).toHaveBeenCalledTimes(0);
    expect(start).toHaveBeenCalledTimes(1);

    now = 1000;
    await session.onBeforePlanStep();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(2);

    const finalized = await session.finalize();
    expect(stop).toHaveBeenCalledTimes(2);
    expect(finalized.filePaths.length).toBe(2);
    expect(finalized.recordingIds.length).toBe(2);
  });

  test("finalize waits for in-flight rotation and prevents a replacement segment", async () => {
    let now = 0;
    let releaseStop: (() => void) | undefined;
    let resolveStopEntered: (() => void) | undefined;
    const stopEntered = new Promise<void>(resolve => {
      resolveStopEntered = resolve;
    });
    const start = mock(async (req: { outputName?: string }) =>
      makeActiveRecording(`id-${req.outputName}`, `/tmp/${req.outputName}.mp4`)
    );
    const stop = mock(async (id: string | undefined) => {
      resolveStopEntered?.();
      await new Promise<void>(stopResolve => {
        releaseStop = stopResolve;
      });
      const rid = id ?? "x";
      return {
        metadata: makeStopMetadata(rid, `/tmp/${rid}.mp4`),
        evictedRecordingIds: [] as string[],
      };
    });

    const timer: Timer = {
      now: () => now,
      sleep: defaultTimer.sleep.bind(defaultTimer),
      setTimeout: defaultTimer.setTimeout.bind(defaultTimer),
      clearTimeout: defaultTimer.clearTimeout.bind(defaultTimer),
      setInterval: defaultTimer.setInterval.bind(defaultTimer),
      clearInterval: defaultTimer.clearInterval.bind(defaultTimer),
    };

    const session = new AndroidSegmentedPlanVideoSession({
      device: androidDevice,
      outputNamePrefix: "plan-c",
      timer,
      segmentRotateAfterMs: 1000,
      startVideoRecording: start,
      stopVideoRecording: stop,
    });

    await session.startFirstSegment();
    now = 1000;
    const rotation = session.onBeforePlanStep();

    await stopEntered;
    const finalizedPromise = session.finalize({ strict: true });
    releaseStop?.();
    const finalized = await finalizedPromise;
    await rotation;

    expect(stop).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(finalized.recordingIds).toEqual(["id-plan-c"]);
  });

  test("concurrent rotation checks wait for the tracked in-flight rotation", async () => {
    let now = 0;
    let releaseStop: (() => void) | undefined;
    let resolveStopEntered: (() => void) | undefined;
    const stopEntered = new Promise<void>(resolve => {
      resolveStopEntered = resolve;
    });
    const start = mock(async (req: { outputName?: string }) =>
      makeActiveRecording(`id-${req.outputName}`, `/tmp/${req.outputName}.mp4`)
    );
    const stop = mock(async (id: string | undefined) => {
      resolveStopEntered?.();
      await new Promise<void>(stopResolve => {
        releaseStop = stopResolve;
      });
      const rid = id ?? "x";
      return {
        metadata: makeStopMetadata(rid, `/tmp/${rid}.mp4`),
        evictedRecordingIds: [] as string[],
      };
    });

    const timer: Timer = {
      now: () => now,
      sleep: defaultTimer.sleep.bind(defaultTimer),
      setTimeout: defaultTimer.setTimeout.bind(defaultTimer),
      clearTimeout: defaultTimer.clearTimeout.bind(defaultTimer),
      setInterval: defaultTimer.setInterval.bind(defaultTimer),
      clearInterval: defaultTimer.clearInterval.bind(defaultTimer),
    };

    const session = new AndroidSegmentedPlanVideoSession({
      device: androidDevice,
      outputNamePrefix: "plan-d",
      timer,
      segmentRotateAfterMs: 1000,
      startVideoRecording: start,
      stopVideoRecording: stop,
    });

    await session.startFirstSegment();
    now = 1000;
    const firstRotation = session.onBeforePlanStep();

    await stopEntered;
    let secondRotationSettled = false;
    const secondRotation = session.onBeforePlanStep().then(() => {
      secondRotationSettled = true;
    });
    await Promise.resolve();

    expect(secondRotationSettled).toBe(false);

    releaseStop?.();
    await Promise.all([firstRotation, secondRotation]);

    expect(stop).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(2);
  });

  test("strict finalize rejects when an earlier rotated segment failed to stop", async () => {
    let now = 0;
    const start = mock(async (req: { outputName?: string }) =>
      makeActiveRecording(`id-${req.outputName}`, `/tmp/${req.outputName}.mp4`)
    );
    const stop = mock(async (id: string | undefined) => {
      if (id === "id-plan-e") {
        throw new Error("rotation stop failed");
      }
      const rid = id ?? "x";
      return {
        metadata: makeStopMetadata(rid, `/tmp/${rid}.mp4`),
        evictedRecordingIds: [] as string[],
      };
    });

    const timer: Timer = {
      now: () => now,
      sleep: defaultTimer.sleep.bind(defaultTimer),
      setTimeout: defaultTimer.setTimeout.bind(defaultTimer),
      clearTimeout: defaultTimer.clearTimeout.bind(defaultTimer),
      setInterval: defaultTimer.setInterval.bind(defaultTimer),
      clearInterval: defaultTimer.clearInterval.bind(defaultTimer),
    };

    const session = new AndroidSegmentedPlanVideoSession({
      device: androidDevice,
      outputNamePrefix: "plan-e",
      timer,
      segmentRotateAfterMs: 1000,
      startVideoRecording: start,
      stopVideoRecording: stop,
    });

    await session.startFirstSegment();
    now = 1000;
    await session.onBeforePlanStep();

    await expect(session.finalize({ strict: true })).rejects.toThrow(
      "Failed to stop one or more video recording segments: rotation stop failed"
    );

    expect(stop).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenCalledTimes(2);
  });

  test("rebases delayed highlights onto the segment that contains them", async () => {
    let now = 0;
    const startCalls: Array<{ outputName?: string; highlights?: VideoRecordingHighlightInput[] }> = [];
    const start = mock(async (req: {
      outputName?: string;
      highlights?: VideoRecordingHighlightInput[];
    }) => {
      startCalls.push({
        outputName: req.outputName,
        highlights: req.highlights,
      });
      return makeActiveRecording(`id-${req.outputName}`, `/tmp/${req.outputName}.mp4`);
    });
    const stop = mock(async (id: string | undefined) => {
      const rid = id ?? "x";
      return {
        metadata: makeStopMetadata(rid, `/tmp/${rid}.mp4`),
        evictedRecordingIds: [] as string[],
      };
    });

    const timer: Timer = {
      now: () => now,
      sleep: defaultTimer.sleep.bind(defaultTimer),
      setTimeout: defaultTimer.setTimeout.bind(defaultTimer),
      clearTimeout: defaultTimer.clearTimeout.bind(defaultTimer),
      setInterval: defaultTimer.setInterval.bind(defaultTimer),
      clearInterval: defaultTimer.clearInterval.bind(defaultTimer),
    };

    const session = new AndroidSegmentedPlanVideoSession({
      device: androidDevice,
      outputNamePrefix: "plan-f",
      timer,
      segmentRotateAfterMs: 1000,
      highlights: [
        { description: "first", shape: boxHighlightShape, timing: { startTimeMs: 0 } },
        { description: "second", shape: boxHighlightShape, timing: { startTimeMs: 1200 } },
        { description: "third", shape: boxHighlightShape, timing: { startTimeMs: 2500 } },
      ],
      startVideoRecording: start,
      stopVideoRecording: stop,
    });

    await session.startFirstSegment();
    now = 1000;
    await session.onBeforePlanStep();
    now = 2000;
    await session.onBeforePlanStep();

    expect(startCalls[0]?.highlights?.map(highlight => highlight.description)).toEqual(["first"]);
    expect(startCalls[0]?.highlights?.[0]?.timing?.startTimeMs).toBe(0);
    expect(startCalls[1]?.highlights?.map(highlight => highlight.description)).toEqual(["second"]);
    expect(startCalls[1]?.highlights?.[0]?.timing?.startTimeMs).toBe(200);
    expect(startCalls[2]?.highlights?.map(highlight => highlight.description)).toEqual(["third"]);
    expect(startCalls[2]?.highlights?.[0]?.timing?.startTimeMs).toBe(500);
  });

  test("strict finalize keeps the active segment retryable after a stop failure", async () => {
    let failedOnce = false;
    const start = mock(async (req: { outputName?: string }) =>
      makeActiveRecording(`id-${req.outputName}`, `/tmp/${req.outputName}.mp4`)
    );
    const stop = mock(async (id: string | undefined) => {
      if (!failedOnce) {
        failedOnce = true;
        throw new Error("temporary stop failure");
      }
      const rid = id ?? "x";
      return {
        metadata: makeStopMetadata(rid, `/tmp/${rid}.mp4`),
        evictedRecordingIds: [] as string[],
      };
    });

    const session = new AndroidSegmentedPlanVideoSession({
      device: androidDevice,
      outputNamePrefix: "plan-g",
      startVideoRecording: start,
      stopVideoRecording: stop,
    });

    await session.startFirstSegment();
    await expect(session.finalize({ strict: true })).rejects.toThrow("temporary stop failure");

    const finalized = await session.finalize({ strict: true });

    expect(stop).toHaveBeenCalledTimes(2);
    expect(stop.mock.calls).toEqual([["id-plan-g"], ["id-plan-g"]]);
    expect(finalized.recordingIds).toEqual(["id-plan-g"]);
  });
});
