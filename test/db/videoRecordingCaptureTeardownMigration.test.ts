import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { Kysely, sql } from "kysely";
import { BunSqliteDialect } from "../../src/db/bunSqliteDialect";
import type { Database } from "../../src/db/types";
import { VideoRecordingRepository } from "../../src/db/videoRecordingRepository";
import { DEFAULT_VIDEO_RECORDING_CONFIG } from "../../src/features/video/VideoRecorderService";
import { logger } from "../../src/utils/logger";
import { up as baseUp } from "../../src/db/migrations/2026_01_09_000_video_recordings";
import { up as highlightsUp } from "../../src/db/migrations/2026_01_11_000_video_recording_highlights";
import { up as ownerUp } from "../../src/db/migrations/2026_07_31_000_video_recordings_owner_session";
import { up as displayUp } from "../../src/db/migrations/2026_09_30_000_video_recording_display";

let sqlite: BunDatabase;
let db: Kysely<unknown>;
beforeEach(async () => {
  sqlite = new BunDatabase(":memory:");
  db = new Kysely<unknown>({ dialect: new BunSqliteDialect({ database: sqlite }) });
  await baseUp(db);
  await highlightsUp(db);
  await ownerUp(db);
  await displayUp(db);
  await (
    await import("../../src/db/migrations/2026_10_13_000_video_recording_recorder_daemon")
  ).up(db);
});
afterEach(async () => {
  await db.destroy();
});
const migration = () =>
  import("../../src/db/migrations/2026_10_12_001_video_recording_capture_teardown");
const descriptor = {
  kind: "android-screenrecord" as const,
  deviceTempPath: "/sdcard/auto-mobile-rec.mp4",
  devicePid: 42,
};
const record = {
  recordingId: "rec",
  deviceId: "fake-device",
  platform: "android" as const,
  status: "recording" as const,
  fileName: "rec.mp4",
  filePath: "/unused/rec.mp4",
  format: "mp4" as const,
  sizeBytes: 0,
  createdAt: "1970-01-01T00:00:00.000Z",
  startedAt: "1970-01-01T00:00:00.000Z",
  lastAccessedAt: "1970-01-01T00:00:00.000Z",
  config: DEFAULT_VIDEO_RECORDING_CONFIG,
  captureTeardown: descriptor,
};

test("capture teardown migration adds a nullable column idempotently and down removes it", async () => {
  const { up, down } = await migration();
  await up(db);
  await up(db);
  const column = sqlite
    .query<{ name: string; notnull: number }, []>(
      "SELECT name, [notnull] FROM pragma_table_info('video_recordings') WHERE name='capture_teardown_json'",
    )
    .get();
  expect(column).toEqual({ name: "capture_teardown_json", notnull: 0 });
  await down(db);
  expect(
    sqlite
      .query(
        "SELECT name FROM pragma_table_info('video_recordings') WHERE name='capture_teardown_json'",
      )
      .all(),
  ).toEqual([]);
});

test("repository inserts refreshes explicitly clears and filters capture descriptors", async () => {
  await (await migration()).up(db);
  const repo = new VideoRecordingRepository(db.withTables<Database>());
  await repo.insertRecording(record);
  expect((await repo.getRecording("rec"))?.captureTeardown).toEqual(descriptor);
  await repo.updateRecording("rec", { captureTeardown: { ...descriptor, devicePid: 43 } });
  expect(
    (await repo.listRecordings({ hasCaptureTeardown: true }))[0]?.captureTeardown?.devicePid,
  ).toBe(43);
  await repo.updateRecording("rec", { captureTeardown: undefined });
  expect((await repo.getRecording("rec"))?.captureTeardown).toBeUndefined();
  expect(await repo.listRecordings({ hasCaptureTeardown: true })).toEqual([]);
  const row = await sql<{
    capture_teardown_json: string | null;
  }>`SELECT capture_teardown_json FROM video_recordings WHERE recording_id='rec'`.execute(db);
  expect(row.rows[0]?.capture_teardown_json).toBeNull();
  await repo.insertRecording(record);
  await repo.insertRecording({ ...record, captureTeardown: undefined });
  expect((await repo.getRecording("rec"))?.captureTeardown).toBeUndefined();
});

test.each([
  "{broken",
  "null",
  '{"kind":"wrong","deviceTempPath":"/file"}',
  '{"kind":"android-screenrecord","deviceTempPath":"/file","devicePid":-1}',
])("malformed capture descriptor %s warns and reads as absent", async (value: string) => {
  await (await migration()).up(db);
  const repo = new VideoRecordingRepository(db.withTables<Database>());
  await repo.insertRecording(record);
  await sql`UPDATE video_recordings SET capture_teardown_json=${value}`.execute(db);
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    expect((await repo.getRecording("rec"))?.captureTeardown).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  } finally {
    warn.mockRestore();
  }
});

test("capture descriptor query excludes rows belonging to live peer daemons", async () => {
  await (await migration()).up(db);
  await sql`CREATE TABLE device_sessions (session_uuid TEXT, status TEXT, daemon_session_id TEXT)`.execute(
    db,
  );
  await sql`INSERT INTO device_sessions VALUES ('peer-owner','active','peer-daemon')`.execute(db);
  const repo = new VideoRecordingRepository(db.withTables<Database>());
  await repo.insertRecording({
    ...record,
    ownerSessionUuid: "peer-owner",
    recorderDaemonSessionId: "peer-daemon",
  });
  expect(
    await repo.listRecordings({
      hasCaptureTeardown: true,
      excludeLiveDaemonSessionIds: new Set(["peer-daemon"]),
    }),
  ).toEqual([]);
  expect(
    await repo.listRecordings({
      hasCaptureTeardown: true,
      excludeLiveDaemonSessionIds: new Set(["dead-daemon"]),
    }),
  ).toHaveLength(1);
});
