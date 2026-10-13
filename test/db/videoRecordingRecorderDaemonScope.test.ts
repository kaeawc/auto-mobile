import { afterEach, beforeEach, expect, test } from "bun:test";
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
import {
  up as recorderUp,
  down as recorderDown,
} from "../../src/db/migrations/2026_10_13_000_video_recording_recorder_daemon";
import { up as captureUp } from "../../src/db/migrations/2026_10_12_001_video_recording_capture_teardown";

let db: Kysely<unknown>;
let repo: VideoRecordingRepository;
beforeEach(async () => {
  db = new Kysely<unknown>({
    dialect: new BunSqliteDialect({ database: new BunDatabase(":memory:") }),
  });
  for (const up of [baseUp, highlightsUp, ownerUp, displayUp, captureUp]) {
    await up(db);
  }
  await recorderUp(db);
  await sql`CREATE TABLE device_sessions (session_uuid TEXT, status TEXT, daemon_session_id TEXT)`.execute(
    db,
  );
  await sql`INSERT INTO device_sessions VALUES ('peer-owner', 'released', 'peer-daemon')`.execute(
    db,
  );
  repo = new VideoRecordingRepository(db.withTables<Database>());
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

for (const owner of [undefined, "peer-owner"]) {
  for (const sweep of ["capture", "interruption"] as const) {
    test(`live peer recorder is excluded from ${sweep} sweep (owner=${owner ?? "none"})`, async () => {
      await insert("peer-daemon", owner);
      expect(
        await repo.listRecordings({
          ...(sweep === "capture"
            ? { hasCaptureTeardown: true }
            : { status: "recording" as const }),
          excludeLiveDaemonSessionIds: new Set(["peer-daemon"]),
        }),
      ).toEqual([]);
    });
  }
  test(`dead recorder remains eligible (owner=${owner ?? "none"})`, async () => {
    await insert("this-daemon", owner);
    expect(
      await repo.listRecordings({
        hasCaptureTeardown: true,
        excludeLiveDaemonSessionIds: new Set(["peer-daemon"]),
      }),
    ).toHaveLength(1);
  });
}

test("unknown recorder is protected while any peer is live", async () => {
  await insert(null);
  expect(
    await repo.listRecordings({
      hasCaptureTeardown: true,
      excludeLiveDaemonSessionIds: new Set(["peer-daemon"]),
    }),
  ).toEqual([]);
});

test("unknown recorder remains eligible without live peers", async () => {
  await insert(null);
  expect(
    await repo.listRecordings({
      hasCaptureTeardown: true,
      excludeLiveDaemonSessionIds: new Set(),
    }),
  ).toHaveLength(1);
});

test("recorder migration is nullable, idempotent, and reversible", async () => {
  await recorderUp(db);
  const columns = await sql<{
    name: string;
    notnull: number;
  }>`SELECT name, [notnull] FROM pragma_table_info('video_recordings') WHERE name='recorder_daemon_session_id'`.execute(
    db,
  );
  expect(columns.rows).toEqual([{ name: "recorder_daemon_session_id", notnull: 0 }]);
  await insert(null);
  const rows = await sql<{
    recorder_daemon_session_id: string | null;
  }>`SELECT recorder_daemon_session_id FROM video_recordings`.execute(db);
  expect(rows.rows[0]?.recorder_daemon_session_id).toBeNull();
  await recorderDown(db);
  expect(
    (
      await sql`SELECT name FROM pragma_table_info('video_recordings') WHERE name='recorder_daemon_session_id'`.execute(
        db,
      )
    ).rows,
  ).toEqual([]);
});

test("recorder stamp round trips and an unstamped conflict preserves it", async () => {
  await insert("peer-daemon");
  const stored = await repo.getRecording("capture");
  expect(stored?.recorderDaemonSessionId).toBe("peer-daemon");
  await repo.insertRecording({ ...stored!, recorderDaemonSessionId: undefined });
  expect((await repo.getRecording("capture"))?.recorderDaemonSessionId).toBe("peer-daemon");
});

test("active peer owner additionally protects a row stamped by a dead recorder", async () => {
  await sql`UPDATE device_sessions SET status='active'`.execute(db);
  await insert("this-daemon", "peer-owner");
  expect(
    await repo.listRecordings({
      hasCaptureTeardown: true,
      excludeLiveDaemonSessionIds: new Set(["peer-daemon"]),
    }),
  ).toEqual([]);
});
