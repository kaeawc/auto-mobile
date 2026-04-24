import { describe, expect, mock, test } from "bun:test";
import { AndroidSegmentedPlanVideoSession } from "../../src/server/androidSegmentedPlanVideoSession";
import type { BootedDevice } from "../../src/models";
import type { Timer } from "../../src/utils/SystemTimer";
import { defaultTimer } from "../../src/utils/SystemTimer";

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
});
