import { describe, expect, mock, test } from "bun:test";
import { AndroidSegmentedPlanVideoSession } from "../../src/server/androidSegmentedPlanVideoSession";
import type { BootedDevice } from "../../src/models";
import type { Timer } from "../../src/utils/SystemTimer";
import { defaultTimer } from "../../src/utils/SystemTimer";
import { FakeTimer } from "../fakes/FakeTimer";

/** Drain all pending microtasks (setImmediate runs after the microtask queue). */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

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

  test("matches a booted device by its runtime ID when its name changes", () => {
    const session = new AndroidSegmentedPlanVideoSession({
      device: androidDevice,
      outputNamePrefix: "plan-runtime-id",
    });

    expect(
      session.matchesDevice({
        platform: "android",
        name: "Unknown (emulator-5554)",
        deviceId: "emulator-5554",
      }),
    ).toBe(true);
    expect(
      session.matchesDevice({
        platform: "android",
        name: androidDevice.name,
        deviceId: "emulator-5556",
      }),
    ).toBe(false);
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
      makeActiveRecording(`id-${req.outputName}`, `/tmp/${req.outputName}.mp4`),
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

describe("AndroidSegmentedPlanVideoSession (timer-driven)", () => {
  function makeSession(timer: FakeTimer) {
    const outputNames: Array<string | undefined> = [];
    const start = mock(async (req: { outputName?: string }) => {
      outputNames.push(req.outputName);
      return makeActiveRecording(`id-${req.outputName}`, `/tmp/${req.outputName}.mp4`);
    });
    const stop = mock(async (id: string | undefined) => {
      const rid = id ?? "x";
      return {
        metadata: makeStopMetadata(rid, `/tmp/${rid}.mp4`),
        evictedRecordingIds: [] as string[],
      };
    });

    const session = new AndroidSegmentedPlanVideoSession({
      device: androidDevice,
      outputNamePrefix: "vid",
      timer,
      segmentRotateAfterMs: 1000,
      startVideoRecording: start,
      stopVideoRecording: stop,
    });

    return { session, start, stop, outputNames };
  }

  test("start rotates segments on the timer; stop returns all in order", async () => {
    const timer = new FakeTimer();
    const { session, start, stop, outputNames } = makeSession(timer);

    const first = await session.start();
    expect(first.recordingId).toBe("id-vid");
    expect(start).toHaveBeenCalledTimes(1);
    expect(outputNames).toEqual(["vid"]);

    timer.advanceTime(1000);
    await flush();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(2);
    expect(outputNames[1]).toBe("vid-seg1");

    timer.advanceTime(1000);
    await flush();
    expect(start).toHaveBeenCalledTimes(3);
    expect(outputNames[2]).toBe("vid-seg2");

    const out = await session.stop();
    expect(out.recordingIds).toEqual(["id-vid", "id-vid-seg1", "id-vid-seg2"]);
    expect(out.filePaths).toEqual([
      "/tmp/id-vid.mp4",
      "/tmp/id-vid-seg1.mp4",
      "/tmp/id-vid-seg2.mp4",
    ]);
  });

  test("stop clears the rotation timer so no further segments start", async () => {
    const timer = new FakeTimer();
    const { session, start } = makeSession(timer);

    await session.start();
    await session.stop();
    expect(start).toHaveBeenCalledTimes(1);
    expect(timer.getPendingTimeoutCount()).toBe(0);

    // Advancing well past the rotation interval must not start a new segment.
    timer.advanceTime(5000);
    await flush();
    expect(start).toHaveBeenCalledTimes(1);
  });

  test("abort rolls back active and completed segments without publishing them", async () => {
    const timer = new FakeTimer();
    const { stop } = makeSession(timer);
    const rolledBack: string[] = [];
    const abortableSession = new AndroidSegmentedPlanVideoSession({
      device: androidDevice,
      outputNamePrefix: "vid",
      timer,
      segmentRotateAfterMs: 1000,
      startVideoRecording: async (request) =>
        makeActiveRecording(`id-${request.outputName}`, `/tmp/id-${request.outputName}.mp4`),
      stopVideoRecording: stop,
      rollbackVideoRecordingStart: async (recordingId) => {
        rolledBack.push(recordingId);
      },
    });

    await abortableSession.start();
    timer.advanceTime(1000);
    await flush();
    await abortableSession.abort();

    expect(stop).toHaveBeenCalledTimes(1);
    expect(rolledBack).toEqual(["id-vid-seg1", "id-vid"]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("rolls back a segment whose rotation stop failed", async () => {
    const timer = new FakeTimer();
    const rolledBack: string[] = [];
    let startCalls = 0;
    const session = new AndroidSegmentedPlanVideoSession({
      device: androidDevice,
      outputNamePrefix: "vid",
      timer,
      segmentRotateAfterMs: 1000,
      startVideoRecording: async (request) => {
        startCalls += 1;
        if (startCalls === 1) {
          return makeActiveRecording("id-vid", "/tmp/id-vid.mp4");
        }
        throw new Error(`replacement ${request.outputName} rejected`);
      },
      stopVideoRecording: async () => {
        throw new Error("segment stop failed");
      },
      rollbackVideoRecordingStart: async (recordingId) => {
        rolledBack.push(recordingId);
      },
    });

    await session.start();
    timer.advanceTime(1000);
    await flush();
    await session.abort();

    expect(rolledBack).toEqual(["id-vid"]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("rolls back a segment whose auto-finalization stop failed", async () => {
    const timer = new FakeTimer();
    const rolledBack: string[] = [];
    const session = new AndroidSegmentedPlanVideoSession({
      device: androidDevice,
      outputNamePrefix: "vid",
      timer,
      segmentRotateAfterMs: 1000,
      maxDurationSeconds: 0.5,
      startVideoRecording: async () => makeActiveRecording("id-vid", "/tmp/id-vid.mp4"),
      stopVideoRecording: async () => {
        throw new Error("final stop failed");
      },
      rollbackVideoRecordingStart: async (recordingId) => {
        rolledBack.push(recordingId);
      },
    });

    await session.start();
    timer.advanceTime(500);
    await flush();
    await session.abort();

    expect(rolledBack).toEqual(["id-vid"]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("retains ownership until a failed final stop is retried or aborted", async () => {
    const timer = new FakeTimer();
    const rolledBack: string[] = [];
    let finalized = 0;
    let stopAttempts = 0;
    const session = new AndroidSegmentedPlanVideoSession({
      device: androidDevice,
      outputNamePrefix: "vid",
      timer,
      startVideoRecording: async () => makeActiveRecording("id-vid", "/tmp/id-vid.mp4"),
      stopVideoRecording: async () => {
        stopAttempts += 1;
        if (stopAttempts === 1) {
          throw new Error("final stop failed");
        }
        return {
          metadata: makeStopMetadata("id-vid", "/tmp/id-vid.mp4"),
          evictedRecordingIds: [],
        };
      },
      rollbackVideoRecordingStart: async (recordingId) => {
        rolledBack.push(recordingId);
      },
      onFinalized: () => {
        finalized += 1;
      },
    });

    await session.start();

    await expect(session.stop()).rejects.toThrow("final stop failed");
    expect(finalized).toBe(0);

    await session.abort();

    expect(rolledBack).toEqual(["id-vid"]);
    expect(finalized).toBe(1);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("waits for a plan-step rotation to observe cancellation before rollback", async () => {
    let now = 0;
    let resolveReplacement!: () => void;
    let replacementSignal: AbortSignal | undefined;
    let markReplacementStarted!: () => void;
    const replacementStarted = new Promise<void>((resolve) => {
      markReplacementStarted = resolve;
    });
    const rolledBack: string[] = [];
    let startCalls = 0;
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
      outputNamePrefix: "vid",
      timer,
      segmentRotateAfterMs: 1000,
      startVideoRecording: async (request) => {
        startCalls += 1;
        if (startCalls === 1) {
          return makeActiveRecording("id-vid", "/tmp/id-vid.mp4");
        }
        replacementSignal = request.abortSignal;
        markReplacementStarted();
        await new Promise<void>((resolve) => {
          resolveReplacement = resolve;
        });
        request.abortSignal?.throwIfAborted();
        throw new Error("replacement continued after cancellation");
      },
      stopVideoRecording: async () => ({
        metadata: makeStopMetadata("id-vid", "/tmp/id-vid.mp4"),
        evictedRecordingIds: [],
      }),
      rollbackVideoRecordingStart: async (recordingId) => {
        rolledBack.push(recordingId);
      },
    });

    await session.startFirstSegment();
    now = 1000;
    const rotating = session.onBeforePlanStep();
    await replacementStarted;

    let abortFinished = false;
    const aborting = session.abort().then(() => {
      abortFinished = true;
    });
    expect(replacementSignal?.aborted).toBe(true);
    await flush();
    expect(abortFinished).toBe(false);

    resolveReplacement();
    await rotating;
    await aborting;

    expect(rolledBack).toEqual(["id-vid"]);
  });

  test("aborts a replacement segment start before waiting for rotation", async () => {
    const timer = new FakeTimer();
    const rolledBack: string[] = [];
    let startCalls = 0;
    let rotationSignal: AbortSignal | undefined;
    const session = new AndroidSegmentedPlanVideoSession({
      device: androidDevice,
      outputNamePrefix: "vid",
      timer,
      segmentRotateAfterMs: 1000,
      startVideoRecording: async (request) => {
        startCalls += 1;
        if (startCalls === 1) {
          return makeActiveRecording("id-vid", "/tmp/id-vid.mp4");
        }
        rotationSignal = request.abortSignal;
        await new Promise<void>((resolve) => {
          request.abortSignal?.addEventListener("abort", resolve, { once: true });
        });
        request.abortSignal?.throwIfAborted();
        throw new Error("replacement start unexpectedly continued");
      },
      stopVideoRecording: async (recordingId) => ({
        metadata: makeStopMetadata(recordingId ?? "unknown", "/tmp/id-vid.mp4"),
        evictedRecordingIds: [],
      }),
      rollbackVideoRecordingStart: async (recordingId) => {
        rolledBack.push(recordingId);
      },
    });

    await session.start();
    timer.advanceTime(1000);
    await flush();
    expect(rotationSignal).toBeDefined();

    await session.abort();

    expect(rotationSignal?.aborted).toBe(true);
    expect(rolledBack).toEqual(["id-vid"]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("auto-stops at maxDurationSeconds, finalizing every segment recorded so far (review: PR #3847)", async () => {
    // maxDurationSeconds=2.5 does not align with the 1000ms rotation cadence, matching
    // the reported bug: without a session-level bound, rotation reschedules indefinitely
    // and maxDuration is never enforced as an overall cap.
    const timer = new FakeTimer();
    const outputNames: Array<string | undefined> = [];
    const start = mock(async (req: { outputName?: string }) => {
      outputNames.push(req.outputName);
      return makeActiveRecording(`id-${req.outputName}`, `/tmp/${req.outputName}.mp4`);
    });
    const stop = mock(async (id: string | undefined) => {
      const rid = id ?? "x";
      return {
        metadata: makeStopMetadata(rid, `/tmp/${rid}.mp4`),
        evictedRecordingIds: [] as string[],
      };
    });

    const session = new AndroidSegmentedPlanVideoSession({
      device: androidDevice,
      outputNamePrefix: "vid",
      timer,
      segmentRotateAfterMs: 1000,
      maxDurationSeconds: 2.5,
      startVideoRecording: start,
      stopVideoRecording: stop,
    });

    await session.start();
    timer.advanceTime(1000); // rotation -> seg1
    await flush();
    timer.advanceTime(1000); // rotation -> seg2 (2000ms elapsed)
    await flush();
    expect(start).toHaveBeenCalledTimes(3);

    timer.advanceTime(500); // 2500ms elapsed -> maxDurationSeconds auto-stop fires
    await flush();

    expect(stop).toHaveBeenCalledTimes(3);
    expect(outputNames).toEqual(["vid", "vid-seg1", "vid-seg2"]);
    // Auto-stop must not leave the rotation timer armed.
    expect(timer.getPendingTimeoutCount()).toBe(0);

    // A caller-issued stop() after auto-stop already ran must be a safe no-op, not
    // double-finalize or throw.
    const out = await session.stop();
    expect(out.recordingIds).toEqual(["id-vid", "id-vid-seg1", "id-vid-seg2"]);
    expect(stop).toHaveBeenCalledTimes(3);
  });
});
