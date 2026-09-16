import { describe, expect, test } from "bun:test";
import { FakeTimer } from "../fakes/FakeTimer";
import type { SessionOwnershipHeartbeat } from "./sessionOwnershipHeartbeat";
import { cleanupIosVideoRecordingSession } from "./iosVideoRecordingSessionCleanup";

function heartbeat(stop: SessionOwnershipHeartbeat["stop"]): SessionOwnershipHeartbeat {
  return {
    assertHealthy(): void {},
    stop,
  };
}

describe("cleanupIosVideoRecordingSession", () => {
  test("stops recording and heartbeat before releasing the session", async () => {
    const calls: string[] = [];
    const timer = new FakeTimer();
    let stopSignal: AbortSignal | undefined;

    const failures = await cleanupIosVideoRecordingSession({
      sessionUuid: "session-1",
      recordingId: "recording-1",
      recordingStopped: false,
      timer,
      sessionHeartbeat: heartbeat(async () => {
        calls.push("stop heartbeat");
        return null;
      }),
      stopRecording: async (sessionUuid, recordingId, signal) => {
        stopSignal = signal;
        calls.push(`stop recording ${sessionUuid} ${recordingId}`);
      },
      releaseSession: async (sessionUuid) => {
        calls.push(`release ${sessionUuid}`);
      },
    });

    expect(failures).toEqual([]);
    expect(calls).toEqual([
      "stop recording session-1 recording-1",
      "stop heartbeat",
      "release session-1",
    ]);
    expect(stopSignal?.aborted).toBe(false);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("does not stop an already finalized recording", async () => {
    const calls: string[] = [];

    const failures = await cleanupIosVideoRecordingSession({
      sessionUuid: "session-1",
      recordingId: "recording-1",
      recordingStopped: true,
      sessionHeartbeat: heartbeat(async () => {
        calls.push("stop heartbeat");
        return null;
      }),
      stopRecording: async () => {
        calls.push("stop recording");
      },
      releaseSession: async () => {
        calls.push("release session");
      },
    });

    expect(failures).toEqual([]);
    expect(calls).toEqual(["stop heartbeat", "release session"]);
  });

  test("attempts every cleanup step and returns failures to the caller", async () => {
    const calls: string[] = [];
    const timer = new FakeTimer();

    const failures = await cleanupIosVideoRecordingSession({
      sessionUuid: "session-1",
      recordingId: "recording-1",
      recordingStopped: false,
      timer,
      sessionHeartbeat: heartbeat(async () => {
        calls.push("stop heartbeat");
        return new Error("heartbeat failed");
      }),
      stopRecording: async () => {
        calls.push("stop recording");
        throw new Error("recording failed");
      },
      releaseSession: async () => {
        calls.push("release session");
        throw new Error("release failed");
      },
    });

    expect(calls).toEqual(["stop recording", "stop heartbeat", "release session"]);
    expect(failures.map(({ step, error }) => [step, error.message])).toEqual([
      ["stop recording", "recording failed"],
      ["stop session heartbeat", "heartbeat failed"],
      ["release session", "release failed"],
    ]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("times out a never-settling recording stop before later cleanup", async () => {
    const timer = new FakeTimer();
    const calls: string[] = [];
    const stopStarted = Promise.withResolvers<void>();
    const neverSettles = Promise.withResolvers<void>();
    let stopSignal: AbortSignal | undefined;

    const cleanup = cleanupIosVideoRecordingSession({
      sessionUuid: "session-1",
      recordingId: "recording-1",
      recordingStopped: false,
      recordingStopTimeoutMs: 100,
      timer,
      sessionHeartbeat: heartbeat(async () => {
        calls.push("stop heartbeat");
        return null;
      }),
      stopRecording: async (_sessionUuid, _recordingId, signal) => {
        calls.push("stop recording");
        stopSignal = signal;
        stopStarted.resolve();
        await neverSettles.promise;
      },
      releaseSession: async () => {
        calls.push("release session");
      },
    });

    await stopStarted.promise;
    await timer.advanceTimeAsync(99);
    expect(calls).toEqual(["stop recording"]);

    await timer.advanceTimeAsync(1);
    const failures = await cleanup;

    expect(stopSignal?.aborted).toBe(true);
    expect(calls).toEqual(["stop recording", "stop heartbeat", "release session"]);
    expect(failures.map(({ step, error }) => [step, error.message])).toEqual([
      ["stop recording", "recording stop did not settle before cleanup timeout (100ms)"],
    ]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });
});
