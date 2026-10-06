import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_VIDEO_RECORDING_CONFIG, VideoRecorderService } from "../../src/features/video";
import { DeviceSessionRepository } from "../../src/db/deviceSessionRepository";
import {
  VideoRecordingRepository,
  type VideoRecordingRecord,
} from "../../src/db/videoRecordingRepository";
import {
  listVideoRecordings,
  resetVideoRecordingManagerDependencies,
  setVideoRecordingManagerDependencies,
  startVideoRecording,
  stopVideoRecording,
} from "../../src/server/videoRecordingManager";
import type { BootedDevice } from "../../src/models";
import { FakeSecurePermissions } from "../fakes/FakeSecurePermissions";
import { createTestDatabase } from "../db/testDbHelper";
import { FakeHighlightClient } from "../fakes/FakeHighlightClient";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeVideoCaptureBackend } from "../fakes/FakeVideoCaptureBackend";
import { FakeVideoRecordingConfigRepository } from "../fakes/FakeVideoRecordingConfigRepository";
import { FakeVideoRecordingRepository } from "../fakes/FakeVideoRecordingRepository";

// Issue #10043: the first video-manager use in a daemon interrupts only the
// `recording` rows no live peer daemon owns.
const STARTED_AT = "2026-01-01T00:00:00.000Z";

function recordingRow(recordingId: string, ownerSessionUuid?: string): VideoRecordingRecord {
  return {
    recordingId,
    deviceId: "device",
    platform: "android",
    status: "recording",
    ownerSessionUuid,
    fileName: `${recordingId}.mp4`,
    filePath: `/unused/${recordingId}.mp4`,
    format: "mp4",
    sizeBytes: 0,
    createdAt: STARTED_AT,
    startedAt: STARTED_AT,
    lastAccessedAt: STARTED_AT,
    config: DEFAULT_VIDEO_RECORDING_CONFIG,
  };
}

describe("video recording startup sweep (#10043)", () => {
  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let timer: FakeTimer;

  beforeAll(async () => {
    const warmup = await createTestDatabase();
    await warmup.destroy();
  });
  beforeEach(async () => {
    db = await createTestDatabase();
    timer = new FakeTimer();
  });
  afterEach(async () => {
    resetVideoRecordingManagerDependencies();
    await db.destroy();
  });

  async function insertSession(sessionUuid: string, daemonSessionId: string | null) {
    await new DeviceSessionRepository(db, timer).upsertActiveSession({
      sessionUuid,
      deviceId: "device",
      platform: "android",
      daemonSessionId,
      createdAtMs: 0,
      lastUsedAtMs: 0,
      expiresAtMs: 1_000_000,
      sessionTimeoutMs: 1_000_000,
      heartbeatTimeoutMs: 1_000_000,
      hasReceivedHeartbeat: false,
    });
  }

  async function configure(
    repository: VideoRecordingRepository | FakeVideoRecordingRepository,
    livePeers: () => ReadonlySet<string>,
  ) {
    await setVideoRecordingManagerDependencies({
      recordingRepository: repository,
      configRepository: new FakeVideoRecordingConfigRepository(),
      highlightClient: new FakeHighlightClient(),
      timer,
      now: () => new Date(STARTED_AT),
      statFileSize: async () => 0,
      resolveLivePeerDaemonSessionIds: livePeers,
      videoRecorderService: new VideoRecorderService({
        backend: new FakeVideoCaptureBackend(),
        idGenerator: new FakeIdGenerator(),
        archiveRoot: "/unused",
        securePermissions: new FakeSecurePermissions(false),
        now: () => new Date(STARTED_AT),
      }),
    });
  }

  async function sweep(
    repository: VideoRecordingRepository | FakeVideoRecordingRepository,
    livePeers: () => ReadonlySet<string>,
  ) {
    await configure(repository, livePeers);
    // The first manager use runs the startup sweep.
    await listVideoRecordings();
  }

  async function statuses(repository: VideoRecordingRepository) {
    const rows = await repository.listRecordings();
    return Object.fromEntries(rows.map((row) => [row.recordingId, row.status]));
  }

  test("leaves a live peer's recording untouched and interrupts the orphans", async () => {
    await insertSession("peer-session", "peer");
    await insertSession("dead-session", "gone");
    const repo = new VideoRecordingRepository(db);
    await repo.insertRecording(recordingRow("peer-row", "peer-session"));
    await repo.insertRecording(recordingRow("dead-owner-row", "dead-session"));
    await repo.insertRecording(recordingRow("unknown-owner-row", "no-such-session"));

    await sweep(repo, () => new Set(["peer"]));

    expect(await statuses(repo)).toEqual({
      "peer-row": "recording",
      "dead-owner-row": "interrupted",
      "unknown-owner-row": "interrupted",
    });
    expect((await repo.getRecording("peer-row"))?.endedAt).toBeUndefined();
  });

  test("keeps an unowned legacy row while a live peer might have written it", async () => {
    const repo = new VideoRecordingRepository(db);
    await repo.insertRecording(recordingRow("legacy-row"));

    await sweep(repo, () => new Set(["peer"]));

    expect(await statuses(repo)).toEqual({ "legacy-row": "recording" });
  });

  test("interrupts an unowned legacy row when no live peer exists", async () => {
    const repo = new VideoRecordingRepository(db);
    await insertSession("old-session", "previous-incarnation");
    await repo.insertRecording(recordingRow("legacy-row"));
    await repo.insertRecording(recordingRow("old-row", "old-session"));

    await sweep(repo, () => new Set());

    expect(await statuses(repo)).toEqual({
      "legacy-row": "interrupted",
      "old-row": "interrupted",
    });
  });

  test("interrupts nothing when live peers cannot be determined", async () => {
    const repo = new VideoRecordingRepository(db);
    await repo.insertRecording(recordingRow("some-row", "some-session"));

    await sweep(repo, () => {
      throw new Error("pid file unreadable");
    });

    expect(await statuses(repo)).toEqual({ "some-row": "recording" });
  });

  test("a live peer's row is not discovered by an implicit stop in this daemon", async () => {
    await insertSession("peer-session", "peer");
    const repo = new VideoRecordingRepository(db);
    await repo.insertRecording(recordingRow("peer-row", "peer-session"));

    await sweep(repo, () => new Set(["peer"]));

    await expect(stopVideoRecording()).rejects.toThrow("No active video recording found");
    expect((await repo.getRecording("peer-row"))?.status).toBe("recording");
  });

  test("the fake repository mirrors the scoped sweep", async () => {
    const repo = new FakeVideoRecordingRepository();
    repo.setSessionDaemon("peer-session", "peer");
    await repo.insertRecording(recordingRow("peer-row", "peer-session"));
    await repo.insertRecording(recordingRow("orphan-row", "other-session"));

    await sweep(repo, () => new Set(["peer"]));

    expect((await repo.getRecording("peer-row"))?.status).toBe("recording");
    expect((await repo.getRecording("orphan-row"))?.status).toBe("interrupted");
  });

  describe("start preflight (#10043 follow-up)", () => {
    const device: BootedDevice = { deviceId: "device", platform: "android", name: "Device" };

    // Run the startup sweep on an empty table so the rows inserted next reach the
    // start preflight instead of being swept first.
    async function armedRepository(livePeers: () => ReadonlySet<string>) {
      const repo = new VideoRecordingRepository(db);
      await configure(repo, livePeers);
      await listVideoRecordings();
      return repo;
    }

    test("refuses to start over a live peer's recording and leaves its row untouched", async () => {
      await insertSession("peer-session", "peer");
      const repo = await armedRepository(() => new Set(["peer"]));
      await repo.insertRecording(recordingRow("peer-row", "peer-session"));

      const start = startVideoRecording({ device });

      await expect(start).rejects.toThrow("peer-session");
      await expect(start).rejects.toThrow("another AutoMobile daemon");
      const row = await repo.getRecording("peer-row");
      expect(row?.status).toBe("recording");
      expect(row?.endedAt).toBeUndefined();
    });

    test("interrupts this process's stale row and starts", async () => {
      await insertSession("own-session", "self");
      const repo = await armedRepository(() => new Set(["peer"]));
      await repo.insertRecording(recordingRow("own-row", "own-session"));

      const active = await startVideoRecording({ device });

      expect((await repo.getRecording("own-row"))?.status).toBe("interrupted");
      expect(active.recordingId).not.toBe("own-row");
    });

    test("interrupts a dead daemon's row and starts", async () => {
      await insertSession("dead-session", "gone");
      const repo = await armedRepository(() => new Set(["peer"]));
      await repo.insertRecording(recordingRow("dead-row", "dead-session"));

      await startVideoRecording({ device });

      expect((await repo.getRecording("dead-row"))?.status).toBe("interrupted");
    });

    test("interrupts an unowned legacy row even with a live peer and starts", async () => {
      const repo = await armedRepository(() => new Set(["peer"]));
      await repo.insertRecording(recordingRow("legacy-row"));

      await startVideoRecording({ device });

      expect((await repo.getRecording("legacy-row"))?.status).toBe("interrupted");
    });

    test("fails closed when live peers cannot be determined", async () => {
      let discoveryFails = false;
      const repo = await armedRepository(() => {
        if (discoveryFails) {
          throw new Error("pid file unreadable");
        }
        return new Set();
      });
      await repo.insertRecording(recordingRow("some-row", "some-session"));
      discoveryFails = true;

      await expect(startVideoRecording({ device })).rejects.toThrow("pid file unreadable");
      expect((await repo.getRecording("some-row"))?.status).toBe("recording");
    });

    test("the fake repository mirrors the peer-owned refusal", async () => {
      const repo = new FakeVideoRecordingRepository();
      repo.setSessionDaemon("peer-session", "peer");
      await configure(repo, () => new Set(["peer"]));
      await listVideoRecordings();
      await repo.insertRecording(recordingRow("peer-row", "peer-session"));

      await expect(startVideoRecording({ device })).rejects.toThrow("peer-session");
      expect((await repo.getRecording("peer-row"))?.status).toBe("recording");
    });
  });
});
