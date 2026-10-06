import { describe, expect, mock, test } from "bun:test";
import { AndroidSegmentedPlanVideoSession } from "../../src/server/androidSegmentedPlanVideoSession";
import type { BootedDevice, VideoRecordingMetadata } from "../../src/models";
import { FakeTimer } from "../fakes/FakeTimer";

// #9885 review: a plan whose session handed the device back must not delete the
// segments it already pulled to the host, and must not touch the device.

const device: BootedDevice = { deviceId: "emulator-5554", platform: "android", name: "Emu" };
const config = {
  qualityPreset: "low" as const,
  targetBitrateKbps: 1000,
  maxThroughputMbps: 5,
  fps: 15,
  maxArchiveSizeMb: 100,
  format: "mp4" as const,
};

function metadata(recordingId: string): VideoRecordingMetadata {
  return {
    recordingId,
    fileName: `${recordingId}.mp4`,
    filePath: `/host/${recordingId}.mp4`,
    format: "mp4",
    sizeBytes: 1,
    codec: "h264",
    createdAt: "",
    startedAt: "",
    lastAccessedAt: "",
    config,
  };
}

/** A session with two rotated, already-stopped segments and a third still recording. */
async function sessionWithTwoCompletedAndOneActive() {
  const timer = new FakeTimer();
  const stop = mock(async (id?: string) => ({
    metadata: metadata(id ?? "missing"),
    evictedRecordingIds: [],
  }));
  const rollback = mock(async (_id: string, _options?: { deviceWide?: boolean }) => {});
  const session = new AndroidSegmentedPlanVideoSession({
    device,
    outputNamePrefix: "plan",
    timer,
    segmentRotateAfterMs: 1000,
    startVideoRecording: mock(async (request: { outputName?: string }) => ({
      recordingId: `id-${request.outputName}`,
      outputPath: `/host/${request.outputName}.mp4`,
      fileName: `${request.outputName}.mp4`,
      startedAt: "",
      config,
    })),
    stopVideoRecording: stop,
    rollbackVideoRecordingStart: rollback,
    getVideoRecordingStatus: async () => undefined,
    getVideoRecordingMetadata: async () => null,
  });
  await session.startFirstSegment();
  timer.advanceTime(1000);
  await session.onBeforePlanStep();
  timer.advanceTime(1000);
  await session.onBeforePlanStep();
  stop.mockClear();
  return { session, stop, rollback };
}

describe("AndroidSegmentedPlanVideoSession.finalizeWithoutDevice", () => {
  test("keeps completed segments and discards only the active one, scoped to our recorder", async () => {
    const { session, stop, rollback } = await sessionWithTwoCompletedAndOneActive();

    const result = await session.finalizeWithoutDevice();

    expect(result.recordingIds).toEqual(["id-plan", "id-plan-seg1"]);
    expect(result.filePaths).toEqual(["/host/id-plan.mp4", "/host/id-plan-seg1.mp4"]);
    expect(rollback.mock.calls).toEqual([["id-plan-seg2", { deviceWide: false }]]);
    // Nothing is pulled from the released device.
    expect(stop).not.toHaveBeenCalled();
    const warnings = result.metadata.flatMap((entry) => entry.warnings ?? []).join(" ");
    expect(warnings).toContain("id-plan-seg2");
    expect(warnings).toContain("own time limit");
  });

  test("abort() still rolls back every segment, completed ones included", async () => {
    const { session, rollback } = await sessionWithTwoCompletedAndOneActive();

    await session.abort();

    expect(rollback.mock.calls.map(([id]) => id).toSorted()).toEqual([
      "id-plan",
      "id-plan-seg1",
      "id-plan-seg2",
    ]);
  });

  test("a failed discard is reported as a warning and does not drop completed segments", async () => {
    const { session, rollback } = await sessionWithTwoCompletedAndOneActive();
    rollback.mockRejectedValue(new Error("db locked"));

    const result = await session.finalizeWithoutDevice();

    expect(result.recordingIds).toEqual(["id-plan", "id-plan-seg1"]);
    expect(result.metadata.flatMap((entry) => entry.warnings ?? []).join(" ")).toContain(
      "db locked",
    );
  });

  test("completedResult returns the archived segments without any device or rollback call", async () => {
    const { session, stop, rollback } = await sessionWithTwoCompletedAndOneActive();

    expect(session.completedResult().recordingIds).toEqual(["id-plan", "id-plan-seg1"]);
    expect(stop).not.toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();
  });
});
