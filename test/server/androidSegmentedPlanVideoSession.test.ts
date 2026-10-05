import { describe, expect, mock, spyOn, test } from "bun:test";
import { AndroidSegmentedPlanVideoSession } from "../../src/server/androidSegmentedPlanVideoSession";
import type { BootedDevice } from "../../src/models";
import type { Timer } from "../../src/utils/SystemTimer";
import { defaultTimer } from "../../src/utils/SystemTimer";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  ANDROID_PLAN_VIDEO_SEGMENT_ROTATE_MS,
  ANDROID_SCREENRECORD_MAX_SECONDS,
} from "../../src/features/video/androidScreenrecord";
import { logger } from "../../src/utils/logger";

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

const rotationStopBudgetMs =
  ANDROID_SCREENRECORD_MAX_SECONDS * 1000 - ANDROID_PLAN_VIDEO_SEGMENT_ROTATE_MS;

function makePendingStopSession() {
  const timer = new FakeTimer();
  const pendingStop = Promise.withResolvers<{
    metadata: ReturnType<typeof makeStopMetadata>;
    evictedRecordingIds: string[];
  }>();
  const start = mock(async (request: { outputName?: string }) =>
    makeActiveRecording(`id-${request.outputName}`, `/tmp/${request.outputName}.mp4`),
  );
  const stop = mock(async (id?: string) =>
    id === "id-bounded"
      ? pendingStop.promise
      : { metadata: makeStopMetadata(id ?? "missing", `/tmp/${id}.mp4`), evictedRecordingIds: [] },
  );
  const rollback = mock(async (_id: string) => {});
  const session = new AndroidSegmentedPlanVideoSession({
    ...{ rollbackVideoRecordingStart: async (_id: string) => {} },
    getVideoRecordingStatus: async () => undefined,
    getVideoRecordingMetadata: async () => null,
    device: androidDevice,
    outputNamePrefix: "bounded",
    timer,
    segmentRotateAfterMs: 1000,
    startVideoRecording: start,
    stopVideoRecording: stop,
    rollbackVideoRecordingStart: rollback,
  });
  return { timer, pendingStop, start, stop, rollback, session };
}

describe("AndroidSegmentedPlanVideoSession rotation stop deadline", () => {
  test("a stop completing within the budget preserves both segments and clears its deadline", async () => {
    const { session, timer, pendingStop, start, stop } = makePendingStopSession();
    await session.startFirstSegment();
    timer.advanceTime(1000);
    const rotation = session.onBeforePlanStep();
    timer.advanceTime(rotationStopBudgetMs - 1);
    pendingStop.resolve({
      metadata: makeStopMetadata("id-bounded", "/tmp/id-bounded.mp4"),
      evictedRecordingIds: [],
    });
    await rotation;
    const result = await session.finalize();
    expect(start.mock.calls.map(([request]) => request.outputName)).toEqual([
      "bounded",
      "bounded-seg1",
    ]);
    expect(stop.mock.calls.map(([id]) => id)).toEqual(["id-bounded", "id-bounded-seg1"]);
    expect(result.recordingIds).toEqual(["id-bounded", "id-bounded-seg1"]);
    expect(result.filePaths).toEqual(["/tmp/id-bounded.mp4", "/tmp/id-bounded-seg1.mp4"]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("an ordinary stop failure still halts timer rotation without starting a replacement", async () => {
    const { session, timer, pendingStop, start, rollback } = makePendingStopSession();
    await session.start();
    timer.advanceTime(1000);
    pendingStop.reject(new Error("adb stop failed"));
    await flush();
    expect(start).toHaveBeenCalledTimes(1);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    const degraded = await session.stop();
    expect(
      (degraded.warnings ?? degraded.metadata.flatMap((metadata) => metadata.warnings ?? [])).join(
        " ",
      ),
    ).toContain("id-bounded");
    expect(
      (degraded.warnings ?? degraded.metadata.flatMap((metadata) => metadata.warnings ?? [])).join(
        " ",
      ),
    ).toContain("adb stop failed");
    await session.abort();
    expect(rollback.mock.calls.map(([id]) => id)).toEqual(["id-bounded"]);
  });

  test("a hung stop expires and starts the next segment before finalization", async () => {
    const { session, timer, start, stop, rollback } = makePendingStopSession();
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await session.startFirstSegment();
      timer.advanceTime(1000);
      let finished = false;
      const rotation = session.onBeforePlanStep().then(() => {
        finished = true;
      });
      timer.advanceTime(rotationStopBudgetMs - 1);
      await flush();
      expect(finished).toBe(false);
      timer.advanceTime(1);
      await flush();
      expect(finished).toBe(true);
      await rotation;
      expect(start.mock.calls.map(([request]) => request.outputName)).toEqual([
        "bounded",
        "bounded-seg1",
      ]);
      expect(
        warn.mock.calls.some(
          ([message]) =>
            message.includes(androidDevice.deviceId) &&
            message.includes("id-bounded") &&
            message.includes("timed out"),
        ),
      ).toBe(true);
      const degraded = await session.finalize();
      expect(degraded.recordingIds).toEqual(["id-bounded-seg1"]);
      expect(degraded.metadata[0]?.warnings?.join(" ")).toContain("timed out");
      expect(stop.mock.calls.map(([id]) => id)).toEqual(["id-bounded", "id-bounded-seg1"]);
      expect(Reflect.get(session, "completedRecordingIds")).toEqual(["id-bounded-seg1"]);
      expect(Reflect.get(session, "completedFilePaths")).toEqual(["/tmp/id-bounded-seg1.mp4"]);
      await session.abort();
      expect(rollback.mock.calls.map(([id]) => id)).toEqual(["id-bounded", "id-bounded-seg1"]);
    } finally {
      warn.mockRestore();
    }
  });

  test("a late stop completion cannot mutate replacement segment state", async () => {
    const { session, timer, pendingStop, start } = makePendingStopSession();
    await session.startFirstSegment();
    timer.advanceTime(1000);
    let finished = false;
    const rotation = session.onBeforePlanStep().then(() => {
      finished = true;
    });
    timer.advanceTime(rotationStopBudgetMs);
    await flush();
    expect(finished).toBe(true);
    await rotation;
    const fields = [
      "activeRecordingId",
      "completedRecordingIds",
      "completedFilePaths",
      "completedMetadata",
      "completedHighlights",
      "segmentIndex",
      "segmentStartedAtMs",
      "lastActivePanel",
    ];
    const snapshot = fields.map((field) => structuredClone(Reflect.get(session, field)));
    pendingStop.resolve({
      metadata: makeStopMetadata("id-bounded", "/tmp/late.mp4"),
      evictedRecordingIds: [],
    });
    await flush();
    expect(fields.map((field) => Reflect.get(session, field))).toEqual(snapshot);
    expect(start).toHaveBeenCalledTimes(2);
    const degraded = await session.finalize();
    expect(degraded.recordingIds).toEqual(["id-bounded-seg1"]);
    expect(degraded.metadata[0]?.warnings?.join(" ")).toContain("timed out");
    expect(Reflect.get(session, "completedRecordingIds")).toEqual(["id-bounded-seg1"]);
    expect(Reflect.get(session, "completedFilePaths")).toEqual(["/tmp/id-bounded-seg1.mp4"]);
    await session.abort();
  });

  test("a late stop rejection is handled after the deadline", async () => {
    const { session, timer, pendingStop } = makePendingStopSession();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      await session.startFirstSegment();
      timer.advanceTime(1000);
      let finished = false;
      const rotation = session.onBeforePlanStep().then(() => {
        finished = true;
      });
      timer.advanceTime(rotationStopBudgetMs);
      await flush();
      expect(finished).toBe(true);
      await rotation;
      pendingStop.reject(new Error("late adb stop rejection"));
      await flush();
      expect(unhandled).toEqual([]);
      expect(Reflect.get(session, "activeRecordingId")).toBe("id-bounded-seg1");
      await session.abort();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("plan cancellation abandons a pending stop without advancing the timer", async () => {
    const { session, timer, pendingStop, start, rollback } = makePendingStopSession();
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    await session.startFirstSegment();
    timer.advanceTime(1000);
    let rejection: unknown;
    const rotation = session
      .onBeforePlanStep({ stepIndex: 1, totalSteps: 2, signal: controller.signal })
      .catch((error: unknown) => {
        rejection = error;
      });
    controller.abort(reason);
    await flush();
    expect(rejection).toBe(reason);
    await rotation;
    expect(start).toHaveBeenCalledTimes(1);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    await session.abort();
    expect(rollback.mock.calls.map(([id]) => id)).toEqual(["id-bounded"]);
    pendingStop.resolve({
      metadata: makeStopMetadata("id-bounded", "/tmp/late.mp4"),
      evictedRecordingIds: [],
    });
    await flush();
    expect((await session.finalize()).recordingIds).toEqual([]);
  });

  test("session abort drains a timer-driven pending stop without its deadline", async () => {
    const { session, timer, start, rollback } = makePendingStopSession();
    await session.start();
    timer.advanceTime(1000);
    let finished = false;
    const aborting = session.abort().then(() => {
      finished = true;
    });
    await flush();
    expect(finished).toBe(true);
    await aborting;
    expect(start).toHaveBeenCalledTimes(1);
    expect(rollback.mock.calls.map(([id]) => id)).toEqual(["id-bounded"]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("timer-driven rotation also expires a hung stop and reschedules", async () => {
    const { session, timer, start } = makePendingStopSession();
    await session.start();
    timer.advanceTime(1000);
    timer.advanceTime(rotationStopBudgetMs);
    await flush();
    expect(start).toHaveBeenCalledTimes(2);
    expect(timer.getPendingTimeouts()).toEqual([1000]);
    const degraded = await session.stop();
    expect(
      (degraded.warnings ?? degraded.metadata.flatMap((metadata) => metadata.warnings ?? [])).join(
        " ",
      ),
    ).toContain("id-bounded");
    expect(degraded.metadata.flatMap((metadata) => metadata.warnings ?? []).join(" ")).toContain(
      "timed out",
    );
    await session.abort();
  });
});

describe("AndroidSegmentedPlanVideoSession", () => {
  test("forwards session ownership to every segment", async () => {
    const requests: Array<{ ownerSessionUuid?: string }> = [];
    const session = new AndroidSegmentedPlanVideoSession({
      ...{ rollbackVideoRecordingStart: async (_id: string) => {} },
      getVideoRecordingStatus: async () => undefined,
      getVideoRecordingMetadata: async () => null,
      device: androidDevice,
      outputNamePrefix: "owned",
      ownerSessionUuid: "owner-a",
      startVideoRecording: async (request) => {
        requests.push(request);
        return makeActiveRecording(`r${requests.length}`, `/tmp/r${requests.length}.mp4`);
      },
    });

    await session.startFirstSegment();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.ownerSessionUuid).toBe("owner-a");
  });

  test("finalize stops the active segment and returns its path", async () => {
    const start = mock(async () => makeActiveRecording("r1", "/tmp/r1.mp4"));
    const stop = mock(async () => ({
      metadata: makeStopMetadata("r1", "/tmp/r1.mp4"),
      evictedRecordingIds: [] as string[],
    }));

    const session = new AndroidSegmentedPlanVideoSession({
      ...{ rollbackVideoRecordingStart: async (_id: string) => {} },
      getVideoRecordingStatus: async () => undefined,
      getVideoRecordingMetadata: async () => null,
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
      ...{ rollbackVideoRecordingStart: async (_id: string) => {} },
      getVideoRecordingStatus: async () => undefined,
      getVideoRecordingMetadata: async () => null,
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
      ...{ rollbackVideoRecordingStart: async (_id: string) => {} },
      getVideoRecordingStatus: async () => undefined,
      getVideoRecordingMetadata: async () => null,
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
  test("reuses the physical ID and offsets a boundary and later transition", async () => {
    const timer = new FakeTimer();
    const requests: Array<
      Parameters<
        NonNullable<
          ConstructorParameters<typeof AndroidSegmentedPlanVideoSession>[0]["startVideoRecording"]
        >
      >[0]
    > = [];
    const recordedPanel = { key: "11", role: "inner" as const };
    const cover = { key: "22", role: "cover" as const };
    const session = new AndroidSegmentedPlanVideoSession({
      ...{ rollbackVideoRecordingStart: async (_id: string) => {} },
      getVideoRecordingStatus: async () => undefined,
      getVideoRecordingMetadata: async () => null,
      device: androidDevice,
      outputNamePrefix: "panels",
      timer,
      segmentRotateAfterMs: 1000,
      startVideoRecording: async (request) => {
        requests.push(request);
        return {
          ...makeActiveRecording(`r${requests.length}`, `/tmp/r${requests.length}.mp4`),
          recordedPanel,
          physicalDisplayId: "11",
        };
      },
      stopVideoRecording: async (recordingId) => ({
        metadata: {
          ...makeStopMetadata(recordingId ?? "unknown", "/tmp/panels.mp4"),
          recordedPanel,
          transitions:
            recordingId === "r1"
              ? [{ atMs: 400, from: recordedPanel, to: cover }]
              : [
                  { atMs: 0, from: recordedPanel, to: cover },
                  { atMs: 250, from: cover, to: recordedPanel },
                ],
        },
        evictedRecordingIds: [],
      }),
    });
    await session.start();
    timer.advanceTime(1000);
    await flush();
    expect(requests[1]?.physicalDisplayId).toBe("11");
    expect(requests[1]?.display).toBeUndefined();
    expect(requests[1]?.activePanel).toEqual(cover);
    const result = await session.stop();
    expect(result.metadata[1]?.transitions?.map((transition) => transition.atMs)).toEqual([
      1000, 1250,
    ]);
  });
  test("routes highlights to segment windows and returns session-timeline entries", async () => {
    const timer = new FakeTimer();
    const firstHighlight = {
      description: "first",
      shape: { type: "circle" as const, bounds: { x: 1, y: 2, width: 3, height: 4 } },
      timing: { startTimeMs: 250 },
    };
    const secondHighlight = {
      description: "second",
      shape: { type: "circle" as const, bounds: { x: 5, y: 6, width: 7, height: 8 } },
      timing: { startTimeMs: 1250 },
    };
    const start = mock(
      async (request: { outputName?: string; highlights?: (typeof firstHighlight)[] }) =>
        makeActiveRecording(`id-${request.outputName}`, `/tmp/${request.outputName}.mp4`),
    );
    const stop = mock(async (recordingId: string | undefined) => {
      const id = recordingId ?? "missing";
      const highlight = id === "id-vid" ? firstHighlight : secondHighlight;
      return {
        metadata: {
          ...makeStopMetadata(id, `/tmp/${id}.mp4`),
          highlights: [
            {
              description: highlight.description,
              shape: highlight.shape,
              timeline: { appearedAtSeconds: 0.25, disappearedAtSeconds: 0.5 },
            },
          ],
        },
        evictedRecordingIds: [] as string[],
      };
    });
    const session = new AndroidSegmentedPlanVideoSession({
      ...{ rollbackVideoRecordingStart: async (_id: string) => {} },
      getVideoRecordingStatus: async () => undefined,
      getVideoRecordingMetadata: async () => null,
      device: androidDevice,
      outputNamePrefix: "vid",
      timer,
      segmentRotateAfterMs: 1000,
      highlights: [
        firstHighlight,
        secondHighlight,
        { ...secondHighlight, description: "never started", timing: { startTimeMs: 2250 } },
      ],
      startVideoRecording: start,
      stopVideoRecording: stop,
    });

    await session.start();
    expect(start.mock.calls[0]?.[0].highlights).toEqual([firstHighlight]);

    timer.advanceTime(1000);
    await flush();
    expect(start.mock.calls[1]?.[0].highlights).toEqual([
      { ...secondHighlight, timing: { startTimeMs: 250 } },
    ]);

    const result = await session.stop();
    expect(result.highlights).toEqual([
      {
        description: "first",
        shape: firstHighlight.shape,
        timeline: { appearedAtSeconds: 0.25, disappearedAtSeconds: 0.5 },
      },
      {
        description: "second",
        shape: secondHighlight.shape,
        timeline: { appearedAtSeconds: 1.25, disappearedAtSeconds: 1.5 },
      },
    ]);
  });

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
      ...{ rollbackVideoRecordingStart: async (_id: string) => {} },
      getVideoRecordingStatus: async () => undefined,
      getVideoRecordingMetadata: async () => null,
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
    const stop = mock(async (recordingId: string | undefined) => {
      const id = recordingId ?? "missing";
      return {
        metadata: {
          ...makeStopMetadata(id, `/tmp/${id}.mp4`),
          highlights: [
            {
              shape: { type: "circle" as const, bounds: { x: 1, y: 2, width: 3, height: 4 } },
              timeline: { appearedAtSeconds: 0.1 },
            },
          ],
        },
        evictedRecordingIds: [] as string[],
      };
    });
    const rolledBack: string[] = [];
    const abortableSession = new AndroidSegmentedPlanVideoSession({
      ...{ rollbackVideoRecordingStart: async (_id: string) => {} },
      getVideoRecordingStatus: async () => undefined,
      getVideoRecordingMetadata: async () => null,
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
    expect((await abortableSession.finalize()).highlights).toBeUndefined();
  });

  test("rolls back a segment whose rotation stop failed", async () => {
    const timer = new FakeTimer();
    const rolledBack: string[] = [];
    let startCalls = 0;
    const session = new AndroidSegmentedPlanVideoSession({
      ...{ rollbackVideoRecordingStart: async (_id: string) => {} },
      getVideoRecordingStatus: async () => undefined,
      getVideoRecordingMetadata: async () => null,
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

  test("auto-finalization exposes retained capture without requiring an unreachable abort", async () => {
    const timer = new FakeTimer();
    const rollback = mock(async (_id: string) => {});
    const stop = mock(async () => {
      throw new Error("final stop failed");
    });
    const session = new AndroidSegmentedPlanVideoSession({
      device: androidDevice,
      outputNamePrefix: "vid",
      timer,
      segmentRotateAfterMs: 1000,
      maxDurationSeconds: 0.5,
      startVideoRecording: async () => makeActiveRecording("id-vid", "/tmp/id-vid.mp4"),
      getVideoRecordingStatus: async () => "recording",
      getVideoRecordingMetadata: async () => null,
      stopVideoRecording: stop,
      rollbackVideoRecordingStart: rollback,
    });
    await session.start();
    timer.advanceTime(500);
    await flush();
    const result = await session.stop();
    expect(result.warnings?.join(" ")).toContain("id-vid");
    expect(result.warnings?.join(" ")).toContain("final stop failed");
    expect(result.warnings?.join(" ")).toContain("stop by recordingId");
    expect(stop).toHaveBeenCalledTimes(2);
    expect(rollback).not.toHaveBeenCalled();
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("notifies finalization once and returns a successful graceful retry", async () => {
    const timer = new FakeTimer();
    const rollback = mock(async (_id: string) => {});
    const finalized = mock(() => {});
    let stopAttempts = 0;
    const session = new AndroidSegmentedPlanVideoSession({
      device: androidDevice,
      outputNamePrefix: "vid",
      timer,
      startVideoRecording: async () => makeActiveRecording("id-vid", "/tmp/id-vid.mp4"),
      getVideoRecordingStatus: async () => "recording",
      getVideoRecordingMetadata: async () => null,
      stopVideoRecording: async () => {
        if (++stopAttempts === 1) {
          throw new Error("final stop failed");
        }
        return { metadata: makeStopMetadata("id-vid", "/tmp/id-vid.mp4"), evictedRecordingIds: [] };
      },
      rollbackVideoRecordingStart: rollback,
      onFinalized: finalized,
    });
    await session.start();
    const result = await session.stop();
    expect(result.recordingIds).toEqual(["id-vid"]);
    expect(result.metadata[0]?.warnings?.join(" ")).toContain("final stop failed");
    expect(finalized).toHaveBeenCalledTimes(1);
    expect(await session.stop()).toEqual(result);
    expect(stopAttempts).toBe(2);
    expect(rollback).not.toHaveBeenCalled();
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("preserves startup and rollback failures when initial cleanup fails", async () => {
    const controller = new AbortController();
    const startupError = new Error("startup cancelled");
    controller.abort(startupError);
    const rollbackError = new Error("rollback failed");
    const session = new AndroidSegmentedPlanVideoSession({
      ...{ rollbackVideoRecordingStart: async (_id: string) => {} },
      getVideoRecordingStatus: async () => undefined,
      getVideoRecordingMetadata: async () => null,
      device: androidDevice,
      outputNamePrefix: "vid",
      startupAbortSignal: controller.signal,
      startVideoRecording: async () => makeActiveRecording("id-vid", "/tmp/id-vid.mp4"),
      stopVideoRecording: async () => ({
        metadata: makeStopMetadata("id-vid", "/tmp/id-vid.mp4"),
        evictedRecordingIds: [],
      }),
      rollbackVideoRecordingStart: async () => {
        throw rollbackError;
      },
    });

    const failure = await session.start().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(aggregate.errors[0]).toBe(startupError);
    expect(aggregate.errors[1]).toBeInstanceOf(AggregateError);
    expect((aggregate.errors[1] as AggregateError).errors).toEqual([rollbackError]);
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
      ...{ rollbackVideoRecordingStart: async (_id: string) => {} },
      getVideoRecordingStatus: async () => undefined,
      getVideoRecordingMetadata: async () => null,
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
      ...{ rollbackVideoRecordingStart: async (_id: string) => {} },
      getVideoRecordingStatus: async () => undefined,
      getVideoRecordingMetadata: async () => null,
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
      ...{ rollbackVideoRecordingStart: async (_id: string) => {} },
      getVideoRecordingStatus: async () => undefined,
      getVideoRecordingMetadata: async () => null,
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

describe("segmented recording recovery", () => {
  function harness(
    overrides: Partial<ConstructorParameters<typeof AndroidSegmentedPlanVideoSession>[0]> = {},
  ) {
    const timer = new FakeTimer();
    let starts = 0;
    const start = mock(async () => makeActiveRecording(`r${++starts}`, `/tmp/r${starts}.mp4`));
    const stop = mock(async (id?: string) => ({
      metadata: makeStopMetadata(id!, `/tmp/${id}.mp4`),
      evictedRecordingIds: [],
    }));
    const finalized = mock(() => {});
    const lookup = mock(async (_id: string) => null);
    const session = new AndroidSegmentedPlanVideoSession({
      device: androidDevice,
      outputNamePrefix: "recovery",
      timer,
      startVideoRecording: start,
      stopVideoRecording: stop,
      rollbackVideoRecordingStart: async () => {},
      getVideoRecordingStatus: async () => undefined,
      getVideoRecordingMetadata: lookup,
      onFinalized: finalized,
      ...overrides,
    });
    return { session, timer, start, stop, finalized, lookup };
  }

  test("a long step recovers an auto-stopped segment and reports the gap before resuming", async () => {
    const lookup = mock(async (id: string) => ({
      ...makeStopMetadata(id, `/tmp/${id}.mp4`),
      durationMs: 180000,
    }));
    const { session, timer } = harness({
      getVideoRecordingStatus: async () => "completed",
      stopVideoRecording: async (id) => {
        if (id === "r1") {
          throw new Error("No active recording found for id r1");
        }
        return { metadata: makeStopMetadata(id!, `/tmp/${id}.mp4`), evictedRecordingIds: [] };
      },
      getVideoRecordingMetadata: lookup,
    });
    await session.startFirstSegment();
    timer.advanceTime(190000);
    await session.onBeforePlanStep();
    timer.advanceTime(170000);
    await session.onBeforePlanStep();
    const result = await session.finalize();
    expect(result.recordingIds).toEqual(["r1", "r2", "r3"]);
    expect(result.metadata[0]?.warnings?.join(" ")).toContain("10000ms");
    expect(lookup).toHaveBeenCalledWith("r1", { touch: false, ownerSessionUuid: undefined });
  });

  test("an auto-stopped final segment is returned without rotation", async () => {
    const { session, timer } = harness({
      getVideoRecordingStatus: async () => "completed",
      stopVideoRecording: async () => {
        throw new Error("No active recording found for id r1");
      },
      getVideoRecordingMetadata: async (id) => ({
        ...makeStopMetadata(id, `/tmp/${id}.mp4`),
        durationMs: 180000,
      }),
    });
    await session.startFirstSegment();
    timer.advanceTime(185000);
    expect((await session.finalize()).recordingIds).toEqual(["r1"]);
  });

  test("a failed rotation returns earlier segments with a warning and keeps the duration bound", async () => {
    let stops = 0;
    const { session, timer, finalized, start } = harness({
      segmentRotateAfterMs: 1000,
      maxDurationSeconds: 3,
      stopVideoRecording: async (id) => {
        if (++stops > 1) {
          throw new Error("adb pull failed");
        }
        return { metadata: makeStopMetadata(id!, `/tmp/${id}.mp4`), evictedRecordingIds: [] };
      },
    });
    await session.start();
    timer.advanceTime(1000);
    await flush();
    timer.advanceTime(1000);
    await flush();
    expect(timer.getPendingTimeoutCount()).toBe(1);
    timer.advanceTime(1000);
    await flush();
    const result = await session.stop();
    expect(result.recordingIds).toEqual(["r1"]);
    expect(result.metadata[0]?.warnings?.join(" ")).toContain("adb pull failed");
    expect(finalized).toHaveBeenCalledTimes(1);
    expect(await session.stop()).toEqual(result);
    await session.onBeforePlanStep();
    expect(start).toHaveBeenCalledTimes(2);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    const fresh = harness();
    await fresh.session.start();
    await fresh.session.stop();
    expect(fresh.finalized).toHaveBeenCalledTimes(1);
  });

  test("zero completed segments still notify finalization and expose the failure", async () => {
    const { session, finalized } = harness({
      stopVideoRecording: async () => {
        throw new Error("disconnected");
      },
    });
    await session.start();
    const result = await session.stop();
    expect(result.recordingIds).toEqual([]);
    expect(result.warnings?.join(" ")).toContain("disconnected");
    expect(finalized).toHaveBeenCalledTimes(1);
    expect(await session.stop()).toEqual(result);
  });

  test.each([false, true])(
    "replacement start retries at the next cadence (timer=%p) and retains its warning",
    async (timerDriven) => {
      let starts = 0;
      const { session, timer } = harness({
        segmentRotateAfterMs: 1000,
        startVideoRecording: async () => {
          if (++starts === 2) {
            throw new Error("replacement rejected");
          }
          return makeActiveRecording(`r${starts}`, `/tmp/r${starts}.mp4`);
        },
      });
      if (timerDriven) {
        await session.start();
      } else {
        await session.startFirstSegment();
      }
      timer.advanceTime(1000);
      if (timerDriven) {
        await flush();
      } else {
        await session.onBeforePlanStep();
      }
      timer.advanceTime(1000);
      if (timerDriven) {
        await flush();
      } else {
        await session.onBeforePlanStep();
      }
      const result = await session.stop();
      expect(result.recordingIds).toEqual(["r1", "r3"]);
      expect(result.metadata[0]?.warnings?.join(" ")).toContain("replacement rejected");
      expect(result.metadata[0]?.warnings?.join(" ")).toContain("1000ms");
    },
  );

  test("stopping after a replacement failure reports truncation and prevents retries", async () => {
    let starts = 0;
    const { session, timer } = harness({
      segmentRotateAfterMs: 1000,
      startVideoRecording: async () => {
        if (++starts > 1) {
          throw new Error("replacement rejected");
        }
        return makeActiveRecording("r1", "/tmp/r1.mp4");
      },
    });
    await session.startFirstSegment();
    timer.advanceTime(1000);
    await session.onBeforePlanStep();
    const result = await session.stop();
    expect(result.metadata[0]?.warnings?.join(" ")).toContain("replacement rejected");
    await session.onBeforePlanStep();
    timer.advanceTime(1000);
    await flush();
    expect(starts).toBe(2);
  });
});

describe("review regressions", () => {
  function setup(status: "recording" | "completed" | "interrupted" | undefined, sizeBytes = 1) {
    const timer = new FakeTimer();
    let starts = 0;
    const start = mock(async () => makeActiveRecording(`r${++starts}`, `/tmp/r${starts}.mp4`));
    const stop = mock(async (_id?: string) => {
      throw new Error("device pull failed");
    });
    const rollback = mock(async (_id: string) => {});
    const lookup = mock(async (id: string) => ({
      ...makeStopMetadata(id, `/tmp/${id}.mp4`),
      sizeBytes,
    }));
    const statusLookup = mock(async (_id: string) => status);
    const session = new AndroidSegmentedPlanVideoSession({
      device: androidDevice,
      outputNamePrefix: "regression",
      timer,
      segmentRotateAfterMs: 1000,
      startVideoRecording: start,
      stopVideoRecording: stop,
      getVideoRecordingMetadata: lookup,
      getVideoRecordingStatus: statusLookup,
      rollbackVideoRecordingStart: rollback,
    });
    return { session, timer, start, stop, rollback, lookup, statusLookup };
  }

  test.each([
    ["rotation", 0],
    ["final", 0],
    ["rotation", 1],
    ["final", 1],
  ] as const)(
    "interrupted %s stop with %p host bytes is not recovered",
    async (path, sizeBytes) => {
      const { session, timer, rollback } = setup("interrupted", sizeBytes);
      await session.startFirstSegment();
      if (path === "rotation") {
        timer.advanceTime(1000);
        await session.onBeforePlanStep();
      }
      const result = await session.stop();
      expect(result.recordingIds).toEqual([]);
      expect(result.filePaths).toEqual([]);
      expect(result.warnings?.join(" ")).toContain("r1");
      expect(result.warnings?.join(" ")).toContain("device pull failed");
      expect(rollback).not.toHaveBeenCalled();
    },
  );

  test("a completed row without host bytes is not recovered", async () => {
    const { session } = setup("completed", 0);
    await session.startFirstSegment();
    const result = await session.stop();
    expect(result.filePaths).toEqual([]);
    expect(result.warnings?.join(" ")).toContain("device pull failed");
  });

  test.each(["rotation", "final"])(
    "retained %s stop retries once without deleting",
    async (path) => {
      const { session, timer, stop, rollback } = setup("recording");
      await session.startFirstSegment();
      if (path === "rotation") {
        timer.advanceTime(1000);
        await session.onBeforePlanStep();
      }
      const result = await session.stop();
      expect(stop).toHaveBeenCalledTimes(2);
      expect(rollback).not.toHaveBeenCalled();
      expect(result.recordingIds).toEqual([]);
      expect(result.warnings?.join(" ")).toContain("r1");
      expect(result.warnings?.join(" ")).toContain("device pull failed");
      expect(result.warnings?.join(" ")).toContain("stop by recordingId");
    },
  );

  test("a hung graceful retry stays bounded and preserves the manager-owned capture", async () => {
    const { session, timer, stop, rollback } = setup("recording");
    let attempts = 0;
    const hung = Promise.withResolvers<{
      metadata: ReturnType<typeof makeStopMetadata>;
      evictedRecordingIds: string[];
    }>();
    stop.mockImplementation(async () => {
      if (++attempts === 1) {
        throw new Error("device file did not finish writing");
      }
      return hung.promise;
    });
    await session.startFirstSegment();
    const stopping = session.stop();
    await flush();
    expect(stop).toHaveBeenCalledTimes(2);
    timer.advanceTime(rotationStopBudgetMs);
    const result = await stopping;
    expect(result.recordingIds).toEqual([]);
    expect(result.warnings?.join(" ")).toContain("r1");
    expect(result.warnings?.join(" ")).toContain("device file did not finish writing");
    expect(result.warnings?.join(" ")).toContain("timed out");
    expect(result.warnings?.join(" ")).toContain("stop by recordingId");
    expect(rollback).not.toHaveBeenCalled();
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test.each(["status", "metadata"])("throwing %s lookup preserves the recording", async (which) => {
    const { session, lookup, statusLookup, rollback } = setup("completed");
    const fail = async () => {
      throw new Error("database unavailable");
    };
    if (which === "status") {
      statusLookup.mockImplementation(fail);
    } else {
      lookup.mockImplementation(fail);
    }
    await session.startFirstSegment();
    const result = await session.stop();
    expect(rollback).not.toHaveBeenCalled();
    expect(result.warnings?.join(" ")).toContain("r1");
    expect(result.warnings?.join(" ")).toContain("database unavailable");
  });

  test("300 step boundaries bound failing starts and aggregate warnings", async () => {
    const { session, timer, start, stop } = setup(undefined);
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      stop.mockImplementation(async (id) => ({
        metadata: makeStopMetadata(id!, `/tmp/${id}.mp4`),
        evictedRecordingIds: [],
      }));
      await session.startFirstSegment();
      start.mockImplementation(async () => {
        throw new Error("capture unavailable");
      });
      timer.advanceTime(1000);
      for (let step = 0; step < 300; step++) {
        await session.onBeforePlanStep();
      }
      expect(start).toHaveBeenCalledTimes(4); // initial success + N=3 failures
      const result = await session.stop();
      const warnings = result.metadata.flatMap((metadata) => metadata.warnings ?? []);
      expect(warnings).toEqual([expect.stringContaining("capture unavailable (x3)")]);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  test("failed starts after the cap retry only at rotation cadence and success resets the cap", async () => {
    const { session, timer, start, stop } = setup(undefined);
    stop.mockImplementation(async (id) => ({
      metadata: makeStopMetadata(id!, `/tmp/${id}.mp4`),
      evictedRecordingIds: [],
    }));
    await session.startFirstSegment();
    start.mockImplementation(async () => {
      throw new Error("capture unavailable");
    });
    timer.advanceTime(1000);
    for (let step = 0; step < 3; step++) {
      await session.onBeforePlanStep();
    }
    timer.advanceTime(999);
    await session.onBeforePlanStep();
    expect(start).toHaveBeenCalledTimes(4);
    timer.advanceTime(1);
    await session.onBeforePlanStep();
    expect(start).toHaveBeenCalledTimes(5);
    start.mockImplementation(async () => makeActiveRecording("resumed", "/tmp/resumed.mp4"));
    timer.advanceTime(1000);
    await session.onBeforePlanStep();
    start.mockImplementation(async () => {
      throw new Error("capture unavailable");
    });
    timer.advanceTime(1000);
    for (let step = 0; step < 3; step++) {
      await session.onBeforePlanStep();
    }
    expect(start).toHaveBeenCalledTimes(9);
    await session.stop();
  });

  test("every late timed-out rotation segment is recovered in capture order", async () => {
    const { session, timer, stop, statusLookup, lookup, rollback } = setup("recording");
    const late1 = Promise.withResolvers<{
      metadata: ReturnType<typeof makeStopMetadata>;
      evictedRecordingIds: string[];
    }>();
    const late2 = Promise.withResolvers<{
      metadata: ReturnType<typeof makeStopMetadata>;
      evictedRecordingIds: string[];
    }>();
    stop.mockImplementation((id) =>
      id === "r1"
        ? late1.promise
        : id === "r2"
          ? late2.promise
          : Promise.resolve({
              metadata: makeStopMetadata(id!, `/tmp/${id}.mp4`),
              evictedRecordingIds: [],
            }),
    );
    await session.startFirstSegment();
    for (let segment = 0; segment < 2; segment++) {
      timer.advanceTime(1000);
      const rotation = session.onBeforePlanStep();
      timer.advanceTime(rotationStopBudgetMs);
      await rotation;
    }
    late1.resolve({ metadata: makeStopMetadata("r1", "/tmp/r1.mp4"), evictedRecordingIds: [] });
    late2.resolve({ metadata: makeStopMetadata("r2", "/tmp/r2.mp4"), evictedRecordingIds: [] });
    await flush();
    statusLookup.mockImplementation(async () => "completed");
    lookup.mockImplementation(async (id) => ({
      ...makeStopMetadata(id, `/tmp/${id}.mp4`),
      durationMs: 1000,
    }));
    const result = await session.stop();
    expect(result.recordingIds).toEqual(["r1", "r2", "r3"]);
    expect(result.filePaths).toEqual(["/tmp/r1.mp4", "/tmp/r2.mp4", "/tmp/r3.mp4"]);
    expect(rollback).not.toHaveBeenCalled();
  });
});

describe("segmented session stop fences", () => {
  test("stop during a pending rotation prevents a replacement from starting", async () => {
    const { session, timer, pendingStop, start } = makePendingStopSession();
    await session.startFirstSegment();
    timer.advanceTime(1000);
    const rotation = session.onBeforePlanStep();
    const stopping = session.stop();
    pendingStop.resolve({
      metadata: makeStopMetadata("id-bounded", "/tmp/id-bounded.mp4"),
      evictedRecordingIds: [],
    });
    await rotation;
    expect((await stopping).recordingIds).toEqual(["id-bounded"]);
    await session.onBeforePlanStep();
    expect(start).toHaveBeenCalledTimes(1);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("abort cancellation neither reports a failed start nor retries it", async () => {
    const timer = new FakeTimer();
    let starts = 0;
    const session = new AndroidSegmentedPlanVideoSession({
      device: androidDevice,
      outputNamePrefix: "cancel",
      timer,
      segmentRotateAfterMs: 1000,
      ...{ rollbackVideoRecordingStart: async (_id: string) => {} },
      getVideoRecordingStatus: async () => undefined,
      getVideoRecordingMetadata: async () => null,
      startVideoRecording: async (request) => {
        if (++starts === 1) {
          return makeActiveRecording("r1", "/tmp/r1.mp4");
        }
        await new Promise<void>((resolve) =>
          request.abortSignal?.addEventListener("abort", () => resolve(), { once: true }),
        );
        request.abortSignal?.throwIfAborted();
        throw new Error("unexpected continuation");
      },
      stopVideoRecording: async () => ({
        metadata: makeStopMetadata("r1", "/tmp/r1.mp4"),
        evictedRecordingIds: [],
      }),
      rollbackVideoRecordingStart: async () => {},
    });
    await session.start();
    timer.advanceTime(1000);
    await flush();
    await session.abort();
    await session.onBeforePlanStep();
    timer.advanceTime(1000);
    await flush();
    const result = await session.stop();
    expect(starts).toBe(2);
    expect(result.warnings).toBeUndefined();
    expect(result.recordingIds).toEqual([]);
  });
});

describe("degraded segmented session cleanup", () => {
  test("recovers the halted segment when manager auto-stop completes it before finalization", async () => {
    const timer = new FakeTimer();
    let archived = false;
    let starts = 0;
    const rollback = mock(async (_id: string) => {});
    const session = new AndroidSegmentedPlanVideoSession({
      device: androidDevice,
      outputNamePrefix: "late",
      timer,
      segmentRotateAfterMs: 1000,
      startVideoRecording: async () => makeActiveRecording(`r${++starts}`, `/tmp/r${starts}.mp4`),
      stopVideoRecording: async (id) => {
        if (id === "r2") {
          throw new Error("stop failed before capture exited");
        }
        return { metadata: makeStopMetadata(id!, `/tmp/${id}.mp4`), evictedRecordingIds: [] };
      },
      getVideoRecordingStatus: async () => (archived ? "completed" : "recording"),
      getVideoRecordingMetadata: async (id) =>
        archived ? { ...makeStopMetadata(id, `/tmp/${id}.mp4`), durationMs: 180000 } : null,
      rollbackVideoRecordingStart: rollback,
    });
    await session.startFirstSegment();
    timer.advanceTime(1000);
    await session.onBeforePlanStep();
    timer.advanceTime(1000);
    await session.onBeforePlanStep();
    archived = true;
    timer.advanceTime(190000);
    const result = await session.stop();
    expect(result.recordingIds).toEqual(["r1", "r2"]);
    expect(result.metadata.flatMap((metadata) => metadata.warnings ?? []).join(" ")).toContain(
      "stop failed",
    );
    expect(result.metadata[1]?.warnings?.join(" ")).toContain("11000ms");
    expect(rollback).not.toHaveBeenCalled();
  });

  test("retained cleanup is observable by recording ID after registry finalization", async () => {
    const rollback = mock(async (_id: string) => {});
    const finalized = mock(() => {});
    const stop = mock(async () => {
      throw new Error("force-stop unconfirmed");
    });
    const session = new AndroidSegmentedPlanVideoSession({
      device: androidDevice,
      outputNamePrefix: "cleanup",
      timer: new FakeTimer(),
      startVideoRecording: async () => makeActiveRecording("r1", "/tmp/r1.mp4"),
      stopVideoRecording: stop,
      getVideoRecordingStatus: async () => "recording",
      getVideoRecordingMetadata: async () => null,
      rollbackVideoRecordingStart: rollback,
      onFinalized: finalized,
    });
    await session.start();
    const result = await session.stop();
    expect(result.warnings?.join(" ")).toContain("r1");
    expect(result.warnings?.join(" ")).toContain("force-stop unconfirmed");
    expect(result.warnings?.join(" ")).toContain("stop by recordingId");
    expect(stop).toHaveBeenCalledTimes(2);
    expect(rollback).not.toHaveBeenCalled();
    expect(finalized).toHaveBeenCalledTimes(1);
  });
});
