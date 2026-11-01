import { afterEach, beforeEach, expect, test, spyOn } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { Kysely, sql } from "kysely";
import { BunSqliteDialect } from "../../src/db/bunSqliteDialect";
import type { Database } from "../../src/db/types";
import { VideoRecordingRepository } from "../../src/db/videoRecordingRepository";
import { DEFAULT_VIDEO_RECORDING_CONFIG } from "../../src/features/video/VideoRecorderService";
import { up as baseUp } from "../../src/db/migrations/2026_01_09_000_video_recordings";
import { up as highlightsUp } from "../../src/db/migrations/2026_01_11_000_video_recording_highlights";
import { up as ownerUp } from "../../src/db/migrations/2026_07_31_000_video_recordings_owner_session";
import { up as displayUp } from "../../src/db/migrations/2026_09_30_000_video_recording_display";
import { up as recorderUp } from "../../src/db/migrations/2026_10_13_000_video_recording_recorder_daemon";
import { up as captureUp } from "../../src/db/migrations/2026_10_12_001_video_recording_capture_teardown";
import { up as audioStateUp } from "../../src/db/migrations/2026_10_29_000_video_recording_audio_state";

let db: Kysely<Database>;
let repo: VideoRecordingRepository;
beforeEach(async () => {
  db = new Kysely<Database>({
    dialect: new BunSqliteDialect({ database: new BunDatabase(":memory:") }),
  });
  for (const up of [baseUp, highlightsUp, ownerUp, displayUp, captureUp]) {
    await up(db);
  }
  await recorderUp(db);
  await audioStateUp(db);
  await sql`CREATE TABLE device_sessions (session_uuid TEXT, status TEXT, daemon_session_id TEXT)`.execute(
    db,
  );
  await sql`INSERT INTO device_sessions VALUES ('peer-owner', 'released', 'peer-daemon')`.execute(
    db,
  );
  repo = new VideoRecordingRepository({ db });
});
afterEach(async () => {
  await db.destroy();
});

async function insert(recorder: string | null, ownerSessionUuid?: string) {
  await repo.insertRecording({
    recordingId: "capture",
    deviceId: "fake-device",
    platform: "android",
    status: "recording",
    fileName: "capture.mp4",
    filePath: "/unused/capture.mp4",
    format: "mp4",
    sizeBytes: 0,
    createdAt: "1970-01-01T00:00:00.000Z",
    startedAt: "1970-01-01T00:00:00.000Z",
    lastAccessedAt: "1970-01-01T00:00:00.000Z",
    config: DEFAULT_VIDEO_RECORDING_CONFIG,
    captureTeardown: {
      kind: "android-screenrecord",
      deviceTempPath: "/sdcard/auto-mobile-capture.mp4",
      devicePid: 42,
    },
    ownerSessionUuid,
    recorderDaemonSessionId: recorder ?? undefined,
  });
}

import {
  redriveUnconfirmedCaptureTeardowns,
  type RecordingTeardownRedriveDeps,
} from "../../src/daemon/recordingTeardownRedrive";
import { FakeTimer } from "../fakes/FakeTimer";
import { logger } from "../../src/utils/logger";

for (const owner of [undefined, "peer-owner"]) {
  test(`startup never marks or stops a live peer capture (owner=${owner ?? "none"})`, async () => {
    await insert("peer-daemon", owner);
    const timer = new FakeTimer();
    const retries: Array<() => Promise<void>> = [];
    let kills = 0;
    const manager = {
      markDeviceNeedsRecorderTeardown: (_id: string, retry: () => Promise<void>) => {
        retries.push(retry);
        return () => {};
      },
      getSessionForDevice: () => null,
      onSessionRelease: () => {},
      onSessionDeviceUnbound: () => {},
      registerPendingDeviceCleanup: () => {},
    };
    await redriveUnconfirmedCaptureTeardowns(manager, {
      recordingRepository: repo,
      liveDaemonSessionIds: new Set(["peer-daemon"]),
      ownedCaptureIds: () => [],
      getDevice: () => ({ deviceId: "fake-device", name: "Fake", platform: "android" }),
      getDeviceIncarnation: () => 1,
      forceStopOrphanedCapture: async () => {
        kills++;
      },
      now: () => timer.now(),
      timer,
    });
    for (const retry of retries) {
      await retry();
    }
    expect(kills).toBe(0);
    expect(retries).toHaveLength(0);
    timer.reset();
  });
}

test.each([undefined, "peer-owner"])(
  "hook revalidation protects a retained capture after its recorder becomes live (owner=%s)",
  async (owner) => {
    await insert("peer-daemon", owner);
    const timer = new FakeTimer();
    let listener: (id: string) => void = () => {};
    let incarnation: number | undefined;
    let kills = 0;
    const live = new Set<string>();
    const retries: Array<() => Promise<void>> = [];
    const manager = {
      markDeviceNeedsRecorderTeardown: (_id: string, retry: () => Promise<void>) => {
        retries.push(retry);
        return () => {};
      },
      getSessionForDevice: () => null,
      onSessionRelease: () => {},
      onSessionDeviceUnbound: () => {},
      registerPendingDeviceCleanup: () => {},
    };
    const deps: RecordingTeardownRedriveDeps = {
      recordingRepository: repo,
      liveDaemonSessionIds: live,
      ownedCaptureIds: () => [],
      getDevice: () => ({ deviceId: "fake-device", name: "Fake", platform: "android" }),
      getDeviceIncarnation: () => incarnation,
      forceStopOrphanedCapture: async () => {
        kills++;
      },
      onDeviceIncarnationAssigned: (callback) => {
        listener = callback;
      },
      now: () => timer.now(),
      timer,
    };
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await redriveUnconfirmedCaptureTeardowns(manager, deps);
      live.add("peer-daemon");
      incarnation = 1;
      listener("fake-device");
      expect(retries).toHaveLength(1);
      await retries[0]!();
      expect(kills).toBe(0);
      expect((await repo.getRecording("capture"))?.captureTeardown).toBeDefined();
    } finally {
      warn.mockRestore();
      timer.reset();
    }
  },
);

test("dead recorder is still marked and force stopped", async () => {
  await insert("this-daemon");
  const timer = new FakeTimer();
  const retries: Array<() => Promise<void>> = [];
  let kills = 0;
  await redriveUnconfirmedCaptureTeardowns(
    {
      markDeviceNeedsRecorderTeardown: (_id, retry) => {
        retries.push(retry);
        return () => {};
      },
      getSessionForDevice: () => null,
      onSessionRelease: () => {},
      onSessionDeviceUnbound: () => {},
      registerPendingDeviceCleanup: () => {},
    },
    {
      recordingRepository: repo,
      liveDaemonSessionIds: new Set(["peer-daemon"]),
      ownedCaptureIds: () => [],
      getDevice: () => ({ deviceId: "fake-device", name: "Fake", platform: "android" }),
      getDeviceIncarnation: () => 1,
      forceStopOrphanedCapture: async () => {
        kills++;
      },
      now: () => timer.now(),
      timer,
    },
  );
  expect(retries).toHaveLength(1);
  await retries[0]!();
  expect(kills).toBe(1);
  expect((await repo.getRecording("capture"))?.captureTeardown).toBeUndefined();
  timer.reset();
});
