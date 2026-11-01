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
import { up as captureUp } from "../../src/db/migrations/2026_10_12_001_video_recording_capture_teardown";
import { up as recorderUp } from "../../src/db/migrations/2026_10_13_000_video_recording_recorder_daemon";
import { down, up } from "../../src/db/migrations/2026_10_29_000_video_recording_audio_state";

let sqlite: BunDatabase;
let db: Kysely<Database>;
beforeEach(async () => {
  sqlite = new BunDatabase(":memory:");
  db = new Kysely<Database>({ dialect: new BunSqliteDialect({ database: sqlite }) });
  for (const migrate of [baseUp, highlightsUp, ownerUp, displayUp, captureUp, recorderUp]) {
    await migrate(db);
  }
});
afterEach(async () => {
  await db.destroy();
});

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
};
const AUDIO_WARNING = "The recording has no audio track: the audio capture ended early.";

const columns = () =>
  sqlite
    .query<{ name: string; notnull: number }, []>(
      "SELECT name, [notnull] FROM pragma_table_info('video_recordings') WHERE name IN ('has_audio_track', 'warnings_json') ORDER BY name",
    )
    .all();

test("the audio state migration adds two nullable columns idempotently and down removes them", async () => {
  await up(db);
  await up(db);
  expect(columns()).toEqual([
    { name: "has_audio_track", notnull: 0 },
    { name: "warnings_json", notnull: 0 },
  ]);
  await down(db);
  expect(columns()).toEqual([]);
});

test("a completed stop's audio state and warnings round-trip through the row", async () => {
  await up(db);
  const repo = new VideoRecordingRepository({ db });
  await repo.insertRecording(record);
  await repo.updateRecording("rec", {
    status: "completed",
    hasAudioTrack: false,
    warnings: [AUDIO_WARNING],
  });
  const stored = await repo.getRecording("rec");
  expect(stored?.hasAudioTrack).toBe(false);
  expect(stored?.warnings).toEqual([AUDIO_WARNING]);

  await repo.updateRecording("rec", { hasAudioTrack: true });
  expect((await repo.getRecording("rec"))?.hasAudioTrack).toBe(true);
  // Re-inserting the row (the overwrite path) replaces both with what the record carries.
  await repo.insertRecording({ ...record, hasAudioTrack: false, warnings: ["replaced"] });
  expect(await repo.getRecording("rec")).toMatchObject({
    hasAudioTrack: false,
    warnings: ["replaced"],
  });
});

test("a recording that never asked for audio reads with no audio state", async () => {
  await up(db);
  const repo = new VideoRecordingRepository({ db });
  await repo.insertRecording(record);
  const stored = await repo.getRecording("rec");
  expect(stored).not.toHaveProperty("hasAudioTrack");
  expect(stored?.warnings).toBeUndefined();
});

test("malformed stored warnings warn and read as absent", async () => {
  await up(db);
  const repo = new VideoRecordingRepository({ db });
  await repo.insertRecording(record);
  await sql`UPDATE video_recordings SET warnings_json=${'{"not":"a list"}'}`.execute(db);
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    expect((await repo.getRecording("rec"))?.warnings).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  } finally {
    warn.mockRestore();
  }
});
