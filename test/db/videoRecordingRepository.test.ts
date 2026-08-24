import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import type { Database } from "../../src/db/types";
import { VideoRecordingRepository } from "../../src/db/videoRecordingRepository";
import type {
  VideoRecordingRecord,
  VideoRecordingQuery,
} from "../../src/db/videoRecordingRepository";
import { createTestDatabase } from "./testDbHelper";
import type { VideoRecordingConfig } from "../../src/models";

function makeConfig(overrides: Partial<VideoRecordingConfig> = {}): VideoRecordingConfig {
  return {
    qualityPreset: "low",
    targetBitrateKbps: 1000,
    maxThroughputMbps: 5,
    fps: 15,
    maxArchiveSizeMb: 100,
    format: "mp4",
    ...overrides,
  };
}

function makeRecord(overrides: Partial<VideoRecordingRecord> = {}): VideoRecordingRecord {
  return {
    recordingId: "rec-1",
    deviceId: "emulator-5554",
    platform: "android",
    status: "recording",
    fileName: "recording.mp4",
    filePath: "/tmp/recording.mp4",
    format: "mp4",
    sizeBytes: 0,
    createdAt: "2024-01-01T00:00:00.000Z",
    startedAt: "2024-01-01T00:00:00.000Z",
    lastAccessedAt: "2024-01-01T00:00:00.000Z",
    config: makeConfig(),
    ...overrides,
  };
}

describe("VideoRecordingRepository", () => {
  let db: Kysely<Database>;
  let repo: VideoRecordingRepository;

  beforeEach(async () => {
    db = await createTestDatabase();
    repo = new VideoRecordingRepository(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  test("insertRecording and getRecording round-trip", async () => {
    const record = makeRecord();
    await repo.insertRecording(record);

    const result = await repo.getRecording("rec-1");
    expect(result).not.toBeNull();
    expect(result!.recordingId).toBe("rec-1");
    expect(result!.deviceId).toBe("emulator-5554");
    expect(result!.platform).toBe("android");
    expect(result!.status).toBe("recording");
    expect(result!.fileName).toBe("recording.mp4");
    expect(result!.filePath).toBe("/tmp/recording.mp4");
    expect(result!.format).toBe("mp4");
    expect(result!.sizeBytes).toBe(0);
    expect(result!.config.qualityPreset).toBe("low");
    expect(result!.config.fps).toBe(15);
  });

  describe("owner-session scoping (issue #4752)", () => {
    beforeEach(async () => {
      await repo.insertRecording(
        makeRecord({ recordingId: "owned-a", status: "completed", ownerSessionUuid: "session-a" }),
      );
      await repo.insertRecording(
        makeRecord({ recordingId: "owned-b", status: "completed", ownerSessionUuid: "session-b" }),
      );
      await repo.insertRecording(makeRecord({ recordingId: "legacy", status: "completed" }));
    });

    test("insertRecording round-trips the owning session", async () => {
      const owned = await repo.getRecording("owned-a");
      expect(owned!.ownerSessionUuid).toBe("session-a");
      const legacy = await repo.getRecording("legacy");
      expect(legacy!.ownerSessionUuid).toBeUndefined();
    });

    test("getRecording rejects a cross-session read but allows the owner and legacy rows", async () => {
      expect(await repo.getRecording("owned-b", { ownerSessionUuid: "session-a" })).toBeNull();
      expect(
        (await repo.getRecording("owned-a", { ownerSessionUuid: "session-a" }))!.recordingId,
      ).toBe("owned-a");
      // Legacy (null-owner) rows stay readable by any session for back-compat.
      expect(
        (await repo.getRecording("legacy", { ownerSessionUuid: "session-a" }))!.recordingId,
      ).toBe("legacy");
    });

    test("listRecordings owner filter returns only the caller's rows plus legacy rows", async () => {
      const rows = await repo.listRecordings({
        status: "completed",
        ownerSessionUuid: "session-a",
      });
      const ids = rows.map((row) => row.recordingId).sort();
      expect(ids).toEqual(["legacy", "owned-a"]);
    });

    test("listRecordings without an owner scope returns every row (internal maintenance path)", async () => {
      const rows = await repo.listRecordings({ status: "completed" });
      expect(rows.map((row) => row.recordingId).sort()).toEqual(["legacy", "owned-a", "owned-b"]);
    });
  });

  test("insertRecording upserts an existing recording id", async () => {
    await repo.insertRecording(makeRecord());

    await repo.insertRecording(
      makeRecord({
        recordingId: "rec-1",
        deviceId: "device-B",
        platform: "ios",
        status: "completed",
        outputName: "second-recording",
        fileName: "second.mp4",
        filePath: "/tmp/second.mp4",
        format: "mp4",
        sizeBytes: 4096,
        durationMs: 6000,
        codec: "h265",
        createdAt: "2024-02-01T00:00:00.000Z",
        startedAt: "2024-02-01T00:00:01.000Z",
        endedAt: "2024-02-01T00:00:07.000Z",
        lastAccessedAt: "2024-02-02T00:00:00.000Z",
        config: makeConfig({ qualityPreset: "high", fps: 30 }),
        highlights: [
          {
            description: "second insert highlight",
            shape: { type: "circle", cx: 12, cy: 34, r: 5 },
            timeline: { appearedAtSeconds: 1.5 },
          },
        ],
      }),
    );

    const result = await repo.getRecording("rec-1");
    expect(result).not.toBeNull();
    expect(result!.deviceId).toBe("device-B");
    expect(result!.platform).toBe("ios");
    expect(result!.status).toBe("completed");
    expect(result!.outputName).toBe("second-recording");
    expect(result!.fileName).toBe("second.mp4");
    expect(result!.filePath).toBe("/tmp/second.mp4");
    expect(result!.sizeBytes).toBe(4096);
    expect(result!.durationMs).toBe(6000);
    expect(result!.codec).toBe("h265");
    // created_at is preserved from the original insert on overwrite (#3498).
    expect(result!.createdAt).toBe("2024-01-01T00:00:00.000Z");
    expect(result!.startedAt).toBe("2024-02-01T00:00:01.000Z");
    expect(result!.endedAt).toBe("2024-02-01T00:00:07.000Z");
    expect(result!.lastAccessedAt).toBe("2024-02-02T00:00:00.000Z");
    expect(result!.config.qualityPreset).toBe("high");
    expect(result!.config.fps).toBe(30);
    expect(result!.highlights).toHaveLength(1);
    expect(result!.highlights![0].description).toBe("second insert highlight");
  });

  test("insertRecording overwrite preserves the original created_at (#3498)", async () => {
    await repo.insertRecording(makeRecord({ createdAt: "2024-01-01T00:00:00.000Z" }));

    await repo.insertRecording(
      makeRecord({
        createdAt: "2025-05-05T00:00:00.000Z",
        sizeBytes: 8192,
        lastAccessedAt: "2025-05-05T00:00:00.000Z",
      }),
    );

    const result = await repo.getRecording("rec-1");
    // Original creation time survives; other fields still update.
    expect(result!.createdAt).toBe("2024-01-01T00:00:00.000Z");
    expect(result!.sizeBytes).toBe(8192);
    expect(result!.lastAccessedAt).toBe("2025-05-05T00:00:00.000Z");
  });

  test("insertRecording upsert clears stale optional fields", async () => {
    await repo.insertRecording(
      makeRecord({
        recordingId: "rec-1",
        outputName: "first-recording",
        durationMs: 5000,
        codec: "h264",
        endedAt: "2024-01-01T00:05:00.000Z",
        highlights: [
          {
            description: "first insert highlight",
            shape: { type: "circle", cx: 100, cy: 200, r: 30 },
            timeline: { appearedAtSeconds: 1.0 },
          },
        ],
      }),
    );

    await repo.insertRecording(
      makeRecord({
        recordingId: "rec-1",
        status: "recording",
      }),
    );

    const result = await repo.getRecording("rec-1");
    expect(result).not.toBeNull();
    expect(result!.outputName).toBeUndefined();
    expect(result!.durationMs).toBeUndefined();
    expect(result!.codec).toBeUndefined();
    expect(result!.endedAt).toBeUndefined();
    expect(result!.highlights).toBeUndefined();
  });

  test("getRecording returns null for unknown id", async () => {
    const result = await repo.getRecording("nonexistent");
    expect(result).toBeNull();
  });

  test("insertRecording with optional fields", async () => {
    const record = makeRecord({
      recordingId: "rec-opt",
      outputName: "my-recording",
      durationMs: 5000,
      codec: "h264",
      endedAt: "2024-01-01T00:05:00.000Z",
      highlights: [
        {
          description: "button tap",
          shape: { type: "circle", cx: 100, cy: 200, r: 30 },
          timeline: { appearedAtSeconds: 1.0, disappearedAtSeconds: 2.0 },
        },
      ],
    });

    await repo.insertRecording(record);
    const result = await repo.getRecording("rec-opt");
    expect(result!.outputName).toBe("my-recording");
    expect(result!.durationMs).toBe(5000);
    expect(result!.codec).toBe("h264");
    expect(result!.endedAt).toBe("2024-01-01T00:05:00.000Z");
    expect(result!.highlights).toHaveLength(1);
    expect(result!.highlights![0].description).toBe("button tap");
  });

  test("listRecordings returns all recordings", async () => {
    await repo.insertRecording(makeRecord({ recordingId: "rec-1" }));
    await repo.insertRecording(makeRecord({ recordingId: "rec-2" }));

    const results = await repo.listRecordings();
    expect(results).toHaveLength(2);
  });

  test("listRecordings filters by status (single)", async () => {
    await repo.insertRecording(makeRecord({ recordingId: "rec-1", status: "recording" }));
    await repo.insertRecording(makeRecord({ recordingId: "rec-2", status: "completed" }));

    const results = await repo.listRecordings({ status: "completed" });
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("completed");
  });

  test("listRecordings filters by status (array)", async () => {
    await repo.insertRecording(makeRecord({ recordingId: "rec-1", status: "recording" }));
    await repo.insertRecording(makeRecord({ recordingId: "rec-2", status: "completed" }));
    await repo.insertRecording(makeRecord({ recordingId: "rec-3", status: "interrupted" }));

    const results = await repo.listRecordings({ status: ["completed", "interrupted"] });
    expect(results).toHaveLength(2);
  });

  test("listRecordings filters by deviceId", async () => {
    await repo.insertRecording(makeRecord({ recordingId: "rec-1", deviceId: "device-A" }));
    await repo.insertRecording(makeRecord({ recordingId: "rec-2", deviceId: "device-B" }));

    const results = await repo.listRecordings({ deviceId: "device-A" });
    expect(results).toHaveLength(1);
    expect(results[0].deviceId).toBe("device-A");
  });

  test("listRecordings filters by platform", async () => {
    await repo.insertRecording(makeRecord({ recordingId: "rec-1", platform: "android" }));
    await repo.insertRecording(makeRecord({ recordingId: "rec-2", platform: "ios" }));

    const results = await repo.listRecordings({ platform: "ios" });
    expect(results).toHaveLength(1);
    expect(results[0].platform).toBe("ios");
  });

  test("listRecordings orders by lastAccessedAt", async () => {
    await repo.insertRecording(
      makeRecord({ recordingId: "rec-old", lastAccessedAt: "2024-01-01T00:00:00.000Z" }),
    );
    await repo.insertRecording(
      makeRecord({ recordingId: "rec-new", lastAccessedAt: "2024-06-01T00:00:00.000Z" }),
    );

    const descResults = await repo.listRecordings({ orderByLastAccessed: "desc" });
    expect(descResults[0].recordingId).toBe("rec-new");

    const ascResults = await repo.listRecordings({ orderByLastAccessed: "asc" });
    expect(ascResults[0].recordingId).toBe("rec-old");
  });

  test("listRecordings respects limit", async () => {
    await repo.insertRecording(makeRecord({ recordingId: "rec-1" }));
    await repo.insertRecording(makeRecord({ recordingId: "rec-2" }));
    await repo.insertRecording(makeRecord({ recordingId: "rec-3" }));

    const results = await repo.listRecordings({ limit: 2 });
    expect(results).toHaveLength(2);
  });

  // Degenerate filter values are unspecified-until-pinned. These lock the
  // current behavior: an empty status array matches nothing (`status IN ()`),
  // and a non-positive limit is ignored (`query.limit && query.limit > 0`).
  test.each<[string, VideoRecordingQuery, number]>([
    ["an empty status array matches no rows", { status: [] }, 0],
    ["a zero limit is ignored and returns all rows", { limit: 0 }, 3],
    ["a negative limit is ignored and returns all rows", { limit: -1 }, 3],
  ])("listRecordings with %s", async (_label, query, expectedCount) => {
    await repo.insertRecording(makeRecord({ recordingId: "rec-1" }));
    await repo.insertRecording(makeRecord({ recordingId: "rec-2" }));
    await repo.insertRecording(makeRecord({ recordingId: "rec-3" }));

    const results = await repo.listRecordings(query);

    expect(results).toHaveLength(expectedCount);
  });

  test("updateRecording changes status", async () => {
    await repo.insertRecording(makeRecord({ status: "recording" }));

    await repo.updateRecording("rec-1", {
      status: "completed",
      endedAt: "2024-01-01T00:05:00.000Z",
      sizeBytes: 5000,
      durationMs: 300000,
    });

    const result = await repo.getRecording("rec-1");
    expect(result!.status).toBe("completed");
    expect(result!.endedAt).toBe("2024-01-01T00:05:00.000Z");
    expect(result!.sizeBytes).toBe(5000);
    expect(result!.durationMs).toBe(300000);
  });

  test("updateRecording with empty update is a no-op", async () => {
    await repo.insertRecording(makeRecord());
    await repo.updateRecording("rec-1", {});

    const result = await repo.getRecording("rec-1");
    expect(result!.recordingId).toBe("rec-1");
  });

  test("getLatestRecording returns most recently accessed completed/interrupted recording", async () => {
    await repo.insertRecording(
      makeRecord({
        recordingId: "rec-1",
        status: "completed",
        lastAccessedAt: "2024-01-01T00:00:00.000Z",
      }),
    );
    await repo.insertRecording(
      makeRecord({
        recordingId: "rec-2",
        status: "interrupted",
        lastAccessedAt: "2024-06-01T00:00:00.000Z",
      }),
    );
    await repo.insertRecording(
      makeRecord({
        recordingId: "rec-3",
        status: "recording",
        lastAccessedAt: "2024-12-01T00:00:00.000Z",
      }),
    );

    const latest = await repo.getLatestRecording();
    expect(latest).not.toBeNull();
    expect(latest!.recordingId).toBe("rec-2");
  });

  test("getLatestRecording returns null when no completed/interrupted recordings exist", async () => {
    await repo.insertRecording(makeRecord({ status: "recording" }));

    const latest = await repo.getLatestRecording();
    expect(latest).toBeNull();
  });

  test("touchRecording updates lastAccessedAt", async () => {
    await repo.insertRecording(makeRecord());

    await repo.touchRecording("rec-1", "2025-06-01T00:00:00.000Z");

    const result = await repo.getRecording("rec-1");
    expect(result!.lastAccessedAt).toBe("2025-06-01T00:00:00.000Z");
  });

  test("deleteRecording removes the recording and returns true", async () => {
    await repo.insertRecording(makeRecord());

    const deleted = await repo.deleteRecording("rec-1");
    expect(deleted).toBe(true);

    const result = await repo.getRecording("rec-1");
    expect(result).toBeNull();
  });

  test("deleteRecording returns false for nonexistent recording", async () => {
    const deleted = await repo.deleteRecording("nonexistent");
    expect(deleted).toBe(false);
  });

  test("updateRecording can update highlights", async () => {
    await repo.insertRecording(makeRecord());

    await repo.updateRecording("rec-1", {
      highlights: [
        {
          description: "swipe gesture",
          shape: { type: "circle", cx: 50, cy: 50, r: 20 },
          timeline: { appearedAtSeconds: 0.5 },
        },
      ],
    });

    const result = await repo.getRecording("rec-1");
    expect(result!.highlights).toHaveLength(1);
    expect(result!.highlights![0].description).toBe("swipe gesture");
  });
});
