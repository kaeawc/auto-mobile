import { describe, expect, mock, test } from "bun:test";
import { AndroidSegmentedPlanVideoSession } from "../../src/server/androidSegmentedPlanVideoSession";
import type { BootedDevice, VideoRecordingMetadata } from "../../src/models";
import type { ActiveVideoRecording } from "../../src/features/video";
import { drainUntil, drainUntilQuiescent } from "../helpers/fakeTimerStepping";
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
  const rollback = mock(
    async (_id: string, _options?: { deviceWide?: boolean; hostOnly?: boolean }) => {},
  );
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
  return { session, stop, rollback, timer };
}

describe("AndroidSegmentedPlanVideoSession.finalizeWithoutDevice", () => {
  for (const mode of [
    "late success",
    "aborted start",
    "late rollback failure",
    "start rollback failure",
  ]) {
    const lateSuccess = mode.startsWith("late");
    const rollbackFails = mode.includes("failure");
    test(`host-only finalize scopes an in-flight rotation rollback (${mode})`, async () => {
      const timer = new FakeTimer();
      const gate = Promise.withResolvers<void>();
      let replacementRequest:
        | Parameters<
            NonNullable<
              ConstructorParameters<
                typeof AndroidSegmentedPlanVideoSession
              >[0]["startVideoRecording"]
            >
          >[0]
        | undefined;
      const rollback = mock(
        async (_id: string, _options?: { hostOnly?: boolean; deviceWide?: boolean }) => {},
      );
      if (rollbackFails) {
        rollback.mockRejectedValue(new Error("host reap failed"));
      }
      try {
        const session = new AndroidSegmentedPlanVideoSession({
          device,
          outputNamePrefix: "rotation",
          timer,
          segmentRotateAfterMs: 1000,
          startVideoRecording: async (request) => {
            const active: ActiveVideoRecording = {
              recordingId: request.outputName!,
              outputPath: "/host/capture.mp4",
              fileName: "capture.mp4",
              startedAt: "",
              config,
            };
            if (request.outputName === "rotation-seg1") {
              replacementRequest = request;
              await gate.promise;
              if (!lateSuccess) {
                await rollback(active.recordingId, request.rollbackOptions?.());
                request.abortSignal?.throwIfAborted();
              }
            }
            return active;
          },
          stopVideoRecording: async (id) => ({ metadata: metadata(id!), evictedRecordingIds: [] }),
          rollbackVideoRecordingStart: rollback,
        });
        await session.startFirstSegment();
        timer.advanceTime(1000);
        const rotation = session.onBeforePlanStep();
        await drainUntil(() => replacementRequest !== undefined, {
          description: "replacement start",
        });
        expect(replacementRequest?.rollbackOptions?.()).toBeUndefined();
        await session.finalizeWithoutDevice({ hostOnly: true });
        expect(replacementRequest?.abortSignal?.aborted).toBe(true);
        gate.resolve();
        await rotation;
        expect(rollback.mock.calls).toEqual([
          ["rotation-seg1", { hostOnly: true, deviceWide: false }],
        ]);
        if (rollbackFails) {
          expect(
            session
              .completedResult()
              .metadata.flatMap((entry) => entry.warnings ?? [])
              .join(" "),
          ).toContain("host reap failed");
        }
        expect(session.liveCaptureIds).toEqual([]);
        expect(await session.finalizeWithoutDevice({ hostOnly: true })).toMatchObject({
          recordingIds: ["rotation"],
        });
      } finally {
        timer.reset();
      }
    });
  }

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

  test("replaced-device finalize keeps host segments and abandons the active segment host-only", async () => {
    const { session, stop, rollback } = await sessionWithTwoCompletedAndOneActive();
    const result = await session.finalizeWithoutDevice({ hostOnly: true });
    expect(result.recordingIds).toEqual(["id-plan", "id-plan-seg1"]);
    expect(rollback.mock.calls).toEqual([["id-plan-seg2", { deviceWide: false, hostOnly: true }]]);
    expect(stop).not.toHaveBeenCalled();
    const warnings = result.metadata.flatMap((entry) => entry.warnings ?? []).join(" ");
    expect(warnings).toContain("device identity was replaced");
    expect(warnings).not.toContain("own time limit");
  });

  test("host-only finalize bypasses a wedged stop and is idempotent after its late rejection", async () => {
    const { session, stop, rollback, timer } = await sessionWithTwoCompletedAndOneActive();
    const gate = Promise.withResolvers<never>();
    stop.mockImplementation(() => gate.promise);
    const stopped = session.stop().catch((error: unknown) => error);
    await drainUntil(() => stop.mock.calls.length === 1, { description: "wedged segment stop" });
    let result: Awaited<ReturnType<typeof session.finalizeWithoutDevice>> | undefined;
    const finalize = session.finalizeWithoutDevice({ hostOnly: true }).then((value) => {
      result = value;
    });
    await drainUntilQuiescent(timer);
    expect(result?.recordingIds).toEqual(["id-plan", "id-plan-seg1"]);
    await finalize;
    expect(rollback.mock.calls).toEqual([["id-plan-seg2", { deviceWide: false, hostOnly: true }]]);
    gate.reject(new Error("late device stop failure"));
    await stopped;
    expect(await session.finalizeWithoutDevice({ hostOnly: true })).toBe(result!);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(rollback).toHaveBeenCalledTimes(1);
  });

  test("non-host-only released-plan finalize still discards while a graceful stop is wedged", async () => {
    const { session, stop, rollback, timer } = await sessionWithTwoCompletedAndOneActive();
    const gate = Promise.withResolvers<never>();
    stop.mockImplementation(() => gate.promise);
    const stopped = session.stop().catch((error: unknown) => error);
    await drainUntil(() => stop.mock.calls.length === 1, { description: "plan stop" });
    let result: Awaited<ReturnType<typeof session.finalizeWithoutDevice>> | undefined;
    void session.finalizeWithoutDevice().then((value) => {
      result = value;
    });
    await drainUntilQuiescent(timer);
    expect(result?.recordingIds).toEqual(["id-plan", "id-plan-seg1"]);
    expect(rollback.mock.calls).toEqual([["id-plan-seg2", { deviceWide: false }]]);
    gate.reject(new Error("late stop"));
    await stopped;
  });

  test("a rejected host discard is retryable and retains the completed result on success", async () => {
    const { session, rollback } = await sessionWithTwoCompletedAndOneActive();
    rollback.mockRejectedValueOnce(new Error("host reap failed"));
    await expect(session.finalizeWithoutDevice({ hostOnly: true })).rejects.toThrow(
      "Failed to discard host segments",
    );
    const result = await session.finalizeWithoutDevice();
    expect(result.recordingIds).toEqual(["id-plan", "id-plan-seg1"]);
    expect(await session.finalizeWithoutDevice({ hostOnly: true })).toBe(result);
    expect(rollback.mock.calls).toEqual([
      ["id-plan-seg2", { deviceWide: false, hostOnly: true }],
      ["id-plan-seg2", { deviceWide: false, hostOnly: true }],
    ]);
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
