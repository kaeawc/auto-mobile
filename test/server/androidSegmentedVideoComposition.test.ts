import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { promises as fsPromises } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PlatformVideoCaptureBackend } from "../../src/features/video/PlatformVideoCaptureBackend";
import type {
  RecordingHandle,
  VideoCaptureConfig,
} from "../../src/features/video/VideoRecorderService";
import { VideoCaptureFinalizationError } from "../../src/features/video/VideoRecorderService";
import { DEFAULT_VIDEO_RECORDING_CONFIG, VideoRecorderService } from "../../src/features/video";
import type { ActiveVideoRecording } from "../../src/features/video";
import {
  AndroidSegmentedPlanVideoSession,
  ROTATION_STOP_TIMEOUT_MS,
  type SegmentedSessionResult,
} from "../../src/server/androidSegmentedPlanVideoSession";
import {
  resetVideoRecordingManagerDependencies,
  setVideoRecordingManagerDependencies,
  startVideoRecording,
  stopVideoRecording,
} from "../../src/server/videoRecordingManager";
import type { BootedDevice, VideoRecordingMetadata } from "../../src/models";
import { logger } from "../../src/utils/logger";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeHighlightClient } from "../fakes/FakeHighlightClient";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeVideoCaptureBackend } from "../fakes/FakeVideoCaptureBackend";
import { FakeVideoRecordingConfigRepository } from "../fakes/FakeVideoRecordingConfigRepository";
import { FakeVideoRecordingRepository } from "../fakes/FakeVideoRecordingRepository";
import { drainMicrotasks, drainUntil } from "../helpers/fakeTimerStepping";

// Composition of the four video-recording changes that landed independently: the recorder
// exit is confirmed by its own pid (#10019), the size monitor stats the live capture path
// (#10017), the maxDuration auto-stop persists segments.json (#10018), and multi-device plans
// rotate from the session's own timer (#10026). Each test below crosses at least two of them
// with fakes only (no adb, no real clock, no real database).

const ROTATE_MS = 1_000;
const device: BootedDevice = { platform: "android", deviceId: "fake-device", name: "Fake" };

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  const { promise, resolve } = Promise.withResolvers<T>();
  return { promise, resolve };
}

/**
 * The real manager touches the filesystem, which a microtask drain cannot wait out. Yield real
 * event-loop turns (no wall-clock sleep) until the condition holds.
 */
async function settleUntil(condition: () => boolean, description: string): Promise<void> {
  for (let turn = 0; turn < 500 && !condition(); turn++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (!condition()) {
    throw new Error(`Timed out waiting for ${description}`);
  }
}

function metadataFor(recordingId: string, dir: string): VideoRecordingMetadata {
  const iso = "1970-01-01T00:00:00.000Z";
  return {
    recordingId,
    filePath: path.join(dir, `${recordingId}.mp4`),
    fileName: `${recordingId}.mp4`,
    format: "mp4",
    sizeBytes: 1,
    createdAt: iso,
    startedAt: iso,
    lastAccessedAt: iso,
    config: DEFAULT_VIDEO_RECORDING_CONFIG,
  };
}

/** Scripted capture seam for the session: ids rec-0, rec-1, ...; stops can be held open. */
class ScriptedCapture {
  readonly started: string[] = [];
  readonly stopRequests: string[] = [];
  readonly holds = new Map<string, Deferred<void>>();
  startHold: Deferred<void> | undefined;
  startRequests = 0;

  constructor(private readonly dir: string) {}

  /** Make the next stop of this recording wait until the returned deferred resolves. */
  holdStop(recordingId: string): Deferred<void> {
    const hold = deferred<void>();
    this.holds.set(recordingId, hold);
    return hold;
  }

  startVideoRecording = async (): Promise<ActiveVideoRecording> => {
    const recordingId = `rec-${this.started.length}`;
    this.startRequests += 1;
    const hold = this.startHold;
    this.startHold = undefined;
    await hold?.promise;
    this.started.push(recordingId);
    return {
      recordingId,
      outputPath: path.join(this.dir, `${recordingId}.mp4`),
      fileName: `${recordingId}.mp4`,
      startedAt: "1970-01-01T00:00:00.000Z",
      config: DEFAULT_VIDEO_RECORDING_CONFIG,
    };
  };

  stopVideoRecording = async (recordingId?: string) => {
    const id = recordingId ?? "missing";
    this.stopRequests.push(id);
    await this.holds.get(id)?.promise;
    return { metadata: metadataFor(id, this.dir), evictedRecordingIds: [] };
  };

  count(recordingId: string): number {
    return this.stopRequests.filter((id) => id === recordingId).length;
  }
}

describe("timer-rotated Android session racing its stop paths (#10026 x #10018)", () => {
  let timer: FakeTimer;
  let capture: ScriptedCapture;
  let autoStopped: SegmentedSessionResult[];
  let finalizedNotifications: number;

  beforeEach(() => {
    timer = new FakeTimer();
    capture = new ScriptedCapture("/archive");
    autoStopped = [];
    finalizedNotifications = 0;
  });

  function makeSession(maxDurationSeconds?: number): AndroidSegmentedPlanVideoSession {
    return new AndroidSegmentedPlanVideoSession({
      device,
      outputNamePrefix: "plan",
      timer,
      segmentRotateAfterMs: ROTATE_MS,
      ...(maxDurationSeconds === undefined ? {} : { maxDurationSeconds }),
      startVideoRecording: capture.startVideoRecording,
      stopVideoRecording: capture.stopVideoRecording,
      onAutoStopped: (result) => {
        autoStopped.push(result);
      },
      onFinalized: () => {
        finalizedNotifications += 1;
      },
    });
  }

  test("auto-stop landing while a rotation's stop is in flight stops each segment once and starts none", async () => {
    const session = makeSession(2);
    await session.start();
    const rotationStop = capture.holdStop("rec-0");

    timer.advanceTime(ROTATE_MS);
    await drainUntil(() => capture.count("rec-0") === 1, { description: "rotation stop of rec-0" });
    // The maxDuration auto-stop fires while rec-0's rotation stop is still pending.
    timer.advanceTime(ROTATE_MS);
    await drainMicrotasks(50);
    expect(autoStopped).toHaveLength(0);

    rotationStop.resolve();
    await drainUntil(() => autoStopped.length === 1, { description: "the auto-stop result" });

    expect(capture.started).toEqual(["rec-0"]);
    expect(capture.stopRequests).toEqual(["rec-0"]);
    expect(autoStopped[0].recordingIds).toEqual(["rec-0"]);
    expect(finalizedNotifications).toBe(1);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    timer.advanceTime(ROTATE_MS * 10);
    await drainMicrotasks(50);
    expect(capture.started).toEqual(["rec-0"]);
  });

  test("auto-stop landing while a replacement segment is starting finalizes that segment once", async () => {
    const session = makeSession(2);
    await session.start();
    capture.startHold = deferred<void>();
    const replacementStart = capture.startHold;

    timer.advanceTime(ROTATE_MS);
    await drainUntil(() => capture.startRequests === 2, { description: "the replacement start" });
    timer.advanceTime(ROTATE_MS);
    await drainMicrotasks(50);

    replacementStart.resolve();
    await drainUntil(() => autoStopped.length === 1, { description: "the auto-stop result" });

    expect(capture.started).toEqual(["rec-0", "rec-1"]);
    expect(capture.stopRequests).toEqual(["rec-0", "rec-1"]);
    expect(autoStopped[0].recordingIds).toEqual(["rec-0", "rec-1"]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    timer.advanceTime(ROTATE_MS * 10);
    await drainMicrotasks(50);
    expect(capture.started).toEqual(["rec-0", "rec-1"]);
  });

  test("a plan finalize racing the auto-stop shares one stop of the final segment and one result", async () => {
    const session = makeSession(2);
    await session.start();
    const finalStop = capture.holdStop("rec-0");

    timer.advanceTime(2 * ROTATE_MS);
    await drainUntil(() => capture.count("rec-0") === 1, { description: "auto-stop of rec-0" });
    const finalized = session.finalize();
    const stopped = session.stop();
    finalStop.resolve();
    const [fromFinalize, fromStop] = await Promise.all([finalized, stopped]);
    await drainUntil(() => autoStopped.length === 1, { description: "the auto-stop result" });

    expect(fromFinalize).toBe(fromStop);
    expect(autoStopped[0]).toBe(fromFinalize);
    expect(capture.stopRequests).toEqual(["rec-0"]);
    expect(finalizedNotifications).toBe(1);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("a plan finalize racing a rotation stops each segment once and arms no timer afterwards", async () => {
    const session = makeSession();
    await session.start();
    const rotationStop = capture.holdStop("rec-0");

    timer.advanceTime(ROTATE_MS);
    await drainUntil(() => capture.count("rec-0") === 1, { description: "rotation stop of rec-0" });
    const finalizing = session.finalize();
    rotationStop.resolve();
    const result = await finalizing;

    expect(result.recordingIds).toEqual(["rec-0"]);
    expect(capture.started).toEqual(["rec-0"]);
    expect(capture.stopRequests).toEqual(["rec-0"]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    // Without maxDuration the plan's own finalize is the only stop; no auto-stop result exists.
    expect(autoStopped).toHaveLength(0);
  });

  const allWarnings = (result: SegmentedSessionResult): string[] =>
    result.metadata.flatMap((metadata) => metadata.warnings ?? []);

  test("a replacement start that outlives the rotation stop budget is abandoned and retried on the next tick", async () => {
    const session = makeSession();
    await session.start();
    // The first replacement start hangs; the retry (startHold is consumed once) succeeds at once.
    capture.startHold = deferred<void>();

    timer.advanceTime(ROTATE_MS);
    await drainUntil(() => capture.startRequests === 2, { description: "the hung start" });
    timer.advanceTime(ROTATION_STOP_TIMEOUT_MS);
    await drainMicrotasks(50);

    // Bounded: the loop is not parked behind the hung start; it reschedules and starts again.
    timer.advanceTime(ROTATE_MS);
    await drainUntil(() => capture.startRequests === 3, { description: "the retried start" });
    await drainUntil(() => capture.started.length === 2, { description: "the retry to land" });
    const result = await session.stop();

    const warnings = allWarnings(result);
    expect(warnings).toContainEqual(
      expect.stringMatching(/failed to start next segment.*timed out after 10000ms/),
    );
    // The whole uncaptured stretch (stop done at 1000ms -> retry landed at 12000ms) is reported.
    expect(warnings).toContain(
      "Video gap: 11000ms without capture between segments or before finalization",
    );
  });

  test("a replacement start that lands inside the budget reports its gap duration and no timeout", async () => {
    const session = makeSession();
    await session.start();
    const slowStart = deferred<void>();
    capture.startHold = slowStart;

    timer.advanceTime(ROTATE_MS);
    await drainUntil(() => capture.startRequests === 2, { description: "the slow start" });
    timer.advanceTime(3_000);
    slowStart.resolve();
    await drainUntil(() => capture.started.length === 2, { description: "the slow start to land" });
    const result = await session.stop();

    const warnings = allWarnings(result);
    expect(warnings).toContain(
      "Video gap: 3000ms without capture between segments or before finalization",
    );
    expect(warnings.join(" ")).not.toContain("timed out");
  });

  test("abort while a replacement segment is starting rolls back and starts nothing after", async () => {
    const rolledBack: string[] = [];
    const session = new AndroidSegmentedPlanVideoSession({
      device,
      outputNamePrefix: "plan",
      timer,
      segmentRotateAfterMs: ROTATE_MS,
      maxDurationSeconds: 10,
      startVideoRecording: capture.startVideoRecording,
      stopVideoRecording: capture.stopVideoRecording,
      rollbackVideoRecordingStart: async (recordingId) => {
        rolledBack.push(recordingId);
      },
    });
    await session.start();
    capture.startHold = deferred<void>();
    const replacementStart = capture.startHold;

    timer.advanceTime(ROTATE_MS);
    await drainUntil(() => capture.startRequests === 2, { description: "the replacement start" });
    const aborting = session.abort();
    replacementStart.resolve();
    await aborting;

    // Every segment that ever started is rolled back, and none starts after the abort.
    expect(capture.started).toEqual(["rec-0", "rec-1"]);
    expect(rolledBack.toSorted()).toEqual(capture.started);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    timer.advanceTime(ROTATE_MS * 20);
    await drainMicrotasks(50);
    expect(capture.stopRequests).toEqual(["rec-0"]);
  });
});

describe("size monitor on a rotated Android recording (#10017 x #10026)", () => {
  let mgrTimer: FakeTimer;
  let sessionTimer: FakeTimer;
  let fakeBackend: FakeVideoCaptureBackend;
  let archiveRoot: string;
  let probed: string[];

  beforeEach(async () => {
    mgrTimer = new FakeTimer();
    sessionTimer = new FakeTimer();
    fakeBackend = new FakeVideoCaptureBackend();
    fakeBackend.setNowProvider(() => new Date(mgrTimer.now()));
    probed = [];
    archiveRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "android-segmented-size-"));
    await setVideoRecordingManagerDependencies({
      videoRecorderService: new VideoRecorderService({
        backend: fakeBackend,
        idGenerator: new FakeIdGenerator(),
        archiveRoot,
        now: () => new Date(mgrTimer.now()),
      }),
      recordingRepository: new FakeVideoRecordingRepository(),
      configRepository: new FakeVideoRecordingConfigRepository(),
      highlightClient: new FakeHighlightClient(),
      timer: mgrTimer,
      now: () => new Date(mgrTimer.now()),
      retentionPolicy: { ttlMs: 0, sweepIntervalMs: 600_000, inProgressCheckIntervalMs: 1_000 },
      statFileSize: async (filePath) => {
        probed.push(filePath);
        return 0;
      },
    });
  });

  afterEach(async () => {
    resetVideoRecordingManagerDependencies();
    await fsPromises.rm(archiveRoot, { recursive: true, force: true });
  });

  async function runTwoSegments(): Promise<ActiveVideoRecording[]> {
    const starts: ActiveVideoRecording[] = [];
    const session = new AndroidSegmentedPlanVideoSession({
      device,
      outputNamePrefix: "plan",
      timer: sessionTimer,
      segmentRotateAfterMs: ROTATE_MS,
      startVideoRecording: async (request) => {
        const active = await startVideoRecording(request);
        starts.push(active);
        return active;
      },
      stopVideoRecording,
    });
    await session.start();
    // The first segment's monitor ticks against the first segment's own file.
    mgrTimer.advanceTime(1_000);
    await settleUntil(() => probed.length === 1, "the first segment's size probe");
    probed.push("--rotate--");
    sessionTimer.advanceTime(ROTATE_MS);
    await settleUntil(() => starts.length === 2, "the rotated segment start");
    mgrTimer.advanceTime(1_000);
    await settleUntil(() => probed.length === 3, "the second segment's size probe");
    await session.stop();
    return starts;
  }

  test("each segment's monitor stats that segment's own file, never an earlier one", async () => {
    const [first, second] = await runTwoSegments();

    expect(first.outputPath).not.toBe(second.outputPath);
    expect(probed).toEqual([first.outputPath, "--rotate--", second.outputPath]);
    // Stopping the final segment disarms its monitor: nothing is left ticking.
    expect(mgrTimer.getPendingIntervalCount()).toBe(0);
  });

  test("a backend-reported live capture path is followed per segment", async () => {
    fakeBackend.setLiveCapturePath(
      (config: VideoCaptureConfig) => `${config.outputDirectory}/${config.recordingId}-raw.mov`,
    );
    const [first, second] = await runTwoSegments();

    expect(first.liveCapturePath).toBeDefined();
    expect(probed).toEqual([first.liveCapturePath!, "--rotate--", second.liveCapturePath!]);
    expect(first.liveCapturePath).not.toBe(second.liveCapturePath);
  });
});

describe("each rotated Android segment is confirmed exited by its own pid (#10019 x #10026)", () => {
  const FIRST_ID = "seg-0";
  const SECOND_ID = "seg-1";
  const FIRST_PID = 4321;
  const SECOND_PID = 4322;
  const deviceFile = (id: string) => `/sdcard/auto-mobile-${id}.mp4`;
  const cmdline = (id: string) =>
    `screenrecord\u0000--time-limit\u0000180\u0000${deviceFile(id)}\u0000`;
  const probe = (pid: number) => `shell 'cat /proc/${pid}/cmdline 2>/dev/null; true'`;
  const PIDOF = 'shell \'pidof screenrecord; printf "pidof-status:%s\\n" "$?"\'';
  let tempDir: string;
  let factory: FakeAdbClientFactory;
  let backend: PlatformVideoCaptureBackend;

  beforeEach(async () => {
    tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "android-segment-pids-"));
    factory = new FakeAdbClientFactory();
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    backend = new PlatformVideoCaptureBackend(factory, timer, {
      async codec() {
        return "h264";
      },
    });
    // The two recorders' launch shells report their own device pids; the device paths differ.
    factory.getFakeClient().setSpawnStdout(deviceFile(FIRST_ID), `${FIRST_PID}\n`);
    factory.getFakeClient().setSpawnStdout(deviceFile(SECOND_ID), `${SECOND_PID}\n`);
  });

  afterEach(async () => {
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  });

  async function startSegment(recordingId: string): Promise<RecordingHandle> {
    const config: VideoCaptureConfig = {
      recordingId,
      outputDirectory: tempDir,
      outputPath: path.join(tempDir, `${recordingId}.mp4`),
      fileName: `${recordingId}.mp4`,
      startedAt: "1970-01-01T00:00:00.000Z",
      qualityPreset: "low",
      targetBitrateKbps: 1000,
      maxThroughputMbps: 5,
      fps: 15,
      maxArchiveSizeMb: 100,
      format: "mp4",
      device,
    };
    const handle = await backend.start(config);
    // Let the buffered launch stdout reach the pid reader.
    await new Promise<void>((resolve) => setImmediate(resolve));
    return handle;
  }

  function commands(): string[] {
    return factory.getFakeClient().getAllCommands();
  }

  test("segment N's zero-byte stop is released while segment N+1's recorder is alive, and never signals it", async () => {
    const first = await startSegment(FIRST_ID);
    const second = await startSegment(SECOND_ID);
    const client = factory.getFakeClient();
    client.setCommandResult(`shell stat -c %s ${deviceFile(FIRST_ID)}`, "0");
    // Segment 0's recorder is alive for the signal and gone for the exit check; segment 1's
    // recorder (and an unrelated pidof hit) stay alive throughout.
    client.setCommandResultSequence(probe(FIRST_PID), [cmdline(FIRST_ID), ""]);
    client.setCommandResult(probe(SECOND_PID), cmdline(SECOND_ID));
    client.setCommandResult(PIDOF, `${SECOND_PID}\npidof-status:0\n`);

    const error = await backend.stop(first).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(VideoCaptureFinalizationError);
    expect(error).toMatchObject({ retainOwnership: false });
    expect(commands()).not.toContain(PIDOF);
    expect(commands()).not.toContain(probe(SECOND_PID));
    expect(commands().filter((command) => command.includes("kill"))).toEqual([
      `shell kill -2 ${FIRST_PID}`,
    ]);
    expect(client.wasSpawned(`rm ${deviceFile(FIRST_ID)}`)).toBe(true);
    expect(client.wasSpawned(`rm ${deviceFile(SECOND_ID)}`)).toBe(false);
    expect(second.recordingId).toBe(SECOND_ID);
  });

  test("a retained segment stops cleanly on retry once its own recorder is gone, with the next recorder running", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      const first = await startSegment(FIRST_ID);
      const client = factory.getFakeClient();
      client.setCommandResult(`shell stat -c %s ${deviceFile(FIRST_ID)}`, "0");
      client.setCommandResultSequence(probe(FIRST_PID), [
        cmdline(FIRST_ID),
        cmdline(FIRST_ID),
        cmdline(FIRST_ID),
        "",
      ]);
      // First attempt: own recorder still running => retained, never released.
      await expect(backend.stop(first)).rejects.toMatchObject({ retainOwnership: true });

      const second = await startSegment(SECOND_ID);
      client.setCommandResult(probe(SECOND_PID), cmdline(SECOND_ID));
      client.setCommandResult(PIDOF, `${SECOND_PID}\npidof-status:0\n`);
      client.clearCommands();

      // Retry while segment 1 runs: now released, still without a pidof or a signal to it.
      await expect(backend.stop(first)).rejects.toMatchObject({ retainOwnership: false });
      expect(commands()).not.toContain(PIDOF);
      expect(commands()).not.toContain(probe(SECOND_PID));
      expect(commands()).not.toContain(`shell kill -2 ${SECOND_PID}`);
      expect(second.recordingId).toBe(SECOND_ID);
    } finally {
      warn.mockRestore();
    }
  });
});
