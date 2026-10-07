import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import os from "node:os";
import path from "node:path";
import { DeviceSessionRepository } from "../../src/db/deviceSessionRepository";
import {
  VideoRecordingRepository,
  type VideoRecordingRecord,
} from "../../src/db/videoRecordingRepository";
import { DEFAULT_VIDEO_RECORDING_CONFIG, VideoRecorderService } from "../../src/features/video";
import {
  getVideoRecordingConfig,
  resetVideoRecordingManagerDependencies,
  setVideoRecordingManagerDependencies,
  startVideoRecording,
  stopVideoRecording,
} from "../../src/server/videoRecordingManager";
import { createTestDatabase } from "../db/testDbHelper";
import { FakeHighlightClient } from "../fakes/FakeHighlightClient";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeSecurePermissions } from "../fakes/FakeSecurePermissions";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeVideoCaptureBackend } from "../fakes/FakeVideoCaptureBackend";
import { FakeVideoRecordingConfigRepository } from "../fakes/FakeVideoRecordingConfigRepository";

describe("video recording daemon ownership", () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let recordings: VideoRecordingRepository;
  let sessions: DeviceSessionRepository;
  let backend: FakeVideoCaptureBackend;
  let timer: FakeTimer;

  beforeEach(async () => {
    db = await createTestDatabase();
    recordings = new VideoRecordingRepository(db);
    timer = new FakeTimer();
    sessions = new DeviceSessionRepository(db, timer);
    backend = new FakeVideoCaptureBackend();
    backend.setNowProvider(() => new Date(timer.now()));
  });

  afterEach(async () => {
    resetVideoRecordingManagerDependencies();
    await db.destroy();
  });

  async function configure(liveDaemonSessionIds: ReadonlySet<string>): Promise<void> {
    const deps = {
      videoRecorderService: new VideoRecorderService({
        backend,
        archiveRoot: path.join(os.tmpdir(), "auto-mobile-ownership-fake"),
        idGenerator: new FakeIdGenerator(),
        securePermissions: new FakeSecurePermissions(false),
        now: () => new Date(timer.now()),
      }),
      recordingRepository: recordings,
      configRepository: new FakeVideoRecordingConfigRepository(),
      highlightClient: new FakeHighlightClient(),
      timer,
      now: () => new Date(timer.now()),
      retentionPolicy: { ttlMs: 0, sweepIntervalMs: 60_000, inProgressCheckIntervalMs: 15_000 },
      statFileSize: async () => 42,
      liveDaemonSessionIds,
    };
    await setVideoRecordingManagerDependencies(deps);
  }

  async function insertRecording(recordingId: string, ownerSessionUuid?: string): Promise<void> {
    const timestamp = new Date(timer.now()).toISOString();
    const record: VideoRecordingRecord = {
      recordingId,
      ownerSessionUuid,
      deviceId: recordingId,
      platform: "ios",
      status: "recording",
      fileName: "video.mp4",
      filePath: path.join(os.tmpdir(), "auto-mobile-ownership-fake", recordingId, "video.mp4"),
      format: "mp4",
      sizeBytes: 0,
      createdAt: timestamp,
      startedAt: timestamp,
      lastAccessedAt: timestamp,
      config: DEFAULT_VIDEO_RECORDING_CONFIG,
    };
    await recordings.insertRecording(record);
  }

  async function insertSession(sessionUuid: string, daemonSessionId: string): Promise<void> {
    await sessions.upsertActiveSession({
      sessionUuid,
      daemonSessionId,
      deviceId: sessionUuid,
      platform: "ios",
      createdAtMs: timer.now(),
      lastUsedAtMs: timer.now(),
      expiresAtMs: timer.now() + 60_000,
      sessionTimeoutMs: 60_000,
      heartbeatTimeoutMs: 10_000,
      hasReceivedHeartbeat: false,
    });
  }

  test("restart preserves live peer rows and interrupts dead, missing, inactive and NULL owners", async () => {
    await configure(new Set(["peer"]));
    await insertSession("peer-session", "peer");
    await insertSession("dead-session", "dead");
    await insertSession("released-session", "peer");
    await sessions.markReleased("released-session", "released", timer.now(), "test");
    await insertRecording("peer-recording", "peer-session");
    await insertRecording("orphan-recording", "dead-session");
    await insertRecording("missing-session-recording", "missing");
    await insertRecording("released-recording", "released-session");
    await insertRecording("legacy-recording");
    const peerBefore = await recordings.getRecording("peer-recording");

    await getVideoRecordingConfig();

    expect(await recordings.getRecording("peer-recording")).toEqual(peerBefore);
    for (const id of [
      "orphan-recording",
      "missing-session-recording",
      "released-recording",
      "legacy-recording",
    ]) {
      expect(await recordings.getRecording(id)).toMatchObject({
        status: "interrupted",
        endedAt: new Date(timer.now()).toISOString(),
        sizeBytes: 42,
        durationMs: 0,
      });
    }
  });

  test("restart still interrupts an active session's recording when no peers are live", async () => {
    await configure(new Set());
    await insertSession("dead-session", "dead");
    await insertRecording("orphan-recording", "dead-session");
    await insertRecording("legacy-recording");

    await getVideoRecordingConfig();

    expect((await recordings.getRecording("orphan-recording"))?.status).toBe("interrupted");
    expect((await recordings.getRecording("legacy-recording"))?.status).toBe("interrupted");
  });

  test("implicit stop selects the local capture and leaves a peer recording untouched", async () => {
    await configure(new Set(["peer"]));
    const local = await startVideoRecording({ device: { deviceId: "local", platform: "ios" } });
    // A peer can start after this manager's one-time restart sweep.
    await insertSession("peer-session", "peer");
    await insertRecording("peer-recording", "peer-session");

    const stopped = await stopVideoRecording();

    expect(stopped.metadata.recordingId).toBe(local.recordingId);
    expect(backend.stopCalls.map((handle) => handle.recordingId)).toEqual([local.recordingId]);
    expect((await recordings.getRecording("peer-recording"))?.status).toBe("recording");
  });

  test("implicit stop reports no local capture when only a peer row is recording", async () => {
    await configure(new Set(["peer"]));
    await getVideoRecordingConfig();
    await insertSession("peer-session", "peer");
    await insertRecording("peer-recording", "peer-session");

    await expect(stopVideoRecording()).rejects.toThrow(
      "No active video recording found. Provide recordingId.",
    );

    expect(backend.stopCalls).toEqual([]);
    expect((await recordings.getRecording("peer-recording"))?.status).toBe("recording");
  });
});
