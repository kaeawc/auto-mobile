import { describe, expect, test } from "bun:test";
import type {
  VideoRecordingRecord,
  VideoRecordingRepository,
} from "../../src/db/videoRecordingRepository";

type Repository = Pick<
  VideoRecordingRepository,
  | "insertRecording"
  | "updateRecording"
  | "getRecording"
  | "listRecordings"
  | "getLatestRecording"
  | "touchRecording"
  | "deleteRecording"
>;

export interface VideoRecordingRepositoryHandle {
  repository: Repository;
  dispose?: () => Promise<void>;
}

function record(overrides: Partial<VideoRecordingRecord> = {}): VideoRecordingRecord {
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
    config: {
      qualityPreset: "low",
      targetBitrateKbps: 1000,
      maxThroughputMbps: 5,
      fps: 15,
      maxArchiveSizeMb: 100,
      format: "mp4",
      resolution: { width: 720, height: 1280 },
    },
    ...overrides,
  };
}

/**
 * Shared behavioural contract for the video recording repository (#11868), run against the
 * in-memory fake and the SQLite repository over an in-memory database. Maintenance-scope
 * filters (`excludeLiveDaemonSessionIds`) are real-repository only and are not covered here.
 */
export function runVideoRecordingRepositoryContract(
  name: string,
  make: () => Promise<VideoRecordingRepositoryHandle>,
): void {
  const withRepository = async (body: (repository: Repository) => Promise<void>): Promise<void> => {
    const handle = await make();
    try {
      await body(handle.repository);
    } finally {
      await handle.dispose?.();
    }
  };
  const ids = (records: VideoRecordingRecord[]) => records.map((entry) => entry.recordingId);

  describe(`VideoRecordingRepository contract: ${name}`, () => {
    test("insert then get round-trips the identifying fields and config", () =>
      withRepository(async (repository) => {
        const input = record();
        await repository.insertRecording(input);
        expect(await repository.getRecording("rec-1")).toMatchObject({
          recordingId: "rec-1",
          deviceId: "emulator-5554",
          platform: "android",
          status: "recording",
          filePath: "/tmp/recording.mp4",
          config: input.config,
        });
        expect(await repository.getRecording("missing")).toBeNull();
      }));

    test("re-inserting a recording overwrites it but keeps the original createdAt (#3498)", () =>
      withRepository(async (repository) => {
        await repository.insertRecording(record({ createdAt: "2024-01-01T00:00:00.000Z" }));
        await repository.insertRecording(
          record({ createdAt: "2024-06-06T00:00:00.000Z", status: "completed", sizeBytes: 42 }),
        );
        expect(await repository.getRecording("rec-1")).toMatchObject({
          createdAt: "2024-01-01T00:00:00.000Z",
          status: "completed",
          sizeBytes: 42,
        });
      }));

    test("updateRecording merges fields, ignores unknown ids, and touch updates lastAccessedAt", () =>
      withRepository(async (repository) => {
        await repository.insertRecording(record());
        await repository.updateRecording("rec-1", { status: "completed", sizeBytes: 99 });
        await repository.updateRecording("missing", { status: "completed" });
        await repository.touchRecording("rec-1", "2024-02-02T00:00:00.000Z");
        expect(await repository.getRecording("rec-1")).toMatchObject({
          status: "completed",
          sizeBytes: 99,
          fileName: "recording.mp4",
          lastAccessedAt: "2024-02-02T00:00:00.000Z",
        });
        expect(await repository.getRecording("missing")).toBeNull();
      }));

    test("captureTeardown round-trips, update(undefined) clears it, and hasCaptureTeardown lists only rows with one", () =>
      withRepository(async (repository) => {
        const teardown = {
          kind: "android-screenrecord" as const,
          deviceTempPath: "/sdcard/rec.mp4",
          devicePid: 4242,
        };
        await repository.insertRecording(
          record({ recordingId: "with", captureTeardown: teardown }),
        );
        await repository.insertRecording(record({ recordingId: "without" }));
        expect((await repository.getRecording("with"))?.captureTeardown).toEqual(teardown);
        expect((await repository.getRecording("without"))?.captureTeardown).toBeUndefined();
        expect(ids(await repository.listRecordings({ hasCaptureTeardown: true }))).toEqual([
          "with",
        ]);
        await repository.updateRecording("with", { captureTeardown: undefined });
        expect((await repository.getRecording("with"))?.captureTeardown).toBeUndefined();
        expect(await repository.listRecordings({ hasCaptureTeardown: true })).toEqual([]);
        // An update that does not mention captureTeardown leaves it alone.
        await repository.updateRecording("without", { captureTeardown: teardown });
        await repository.updateRecording("without", { sizeBytes: 5 });
        expect((await repository.getRecording("without"))?.captureTeardown).toEqual(teardown);
      }));

    test("re-inserting without a captureTeardown clears it, but a missing recorderDaemonSessionId keeps the stored one", () =>
      withRepository(async (repository) => {
        await repository.insertRecording(
          record({
            captureTeardown: { kind: "android-screenrecord", deviceTempPath: "/sdcard/a.mp4" },
            recorderDaemonSessionId: "daemon-1",
          }),
        );
        await repository.insertRecording(record({ status: "completed" }));
        const afterOverwrite = await repository.getRecording("rec-1");
        expect(afterOverwrite?.captureTeardown).toBeUndefined();
        expect(afterOverwrite?.recorderDaemonSessionId).toBe("daemon-1");
        await repository.insertRecording(record({ recorderDaemonSessionId: "daemon-2" }));
        expect((await repository.getRecording("rec-1"))?.recorderDaemonSessionId).toBe("daemon-2");
      }));

    test("deleteRecording reports whether a row was removed", () =>
      withRepository(async (repository) => {
        await repository.insertRecording(record());
        expect(await repository.deleteRecording("rec-1")).toBe(true);
        expect(await repository.deleteRecording("rec-1")).toBe(false);
        expect(await repository.getRecording("rec-1")).toBeNull();
      }));

    test("listRecordings filters by status, device and platform, and applies limit", () =>
      withRepository(async (repository) => {
        await repository.insertRecording(record({ recordingId: "a", status: "completed" }));
        await repository.insertRecording(
          record({ recordingId: "b", status: "recording", deviceId: "other" }),
        );
        await repository.insertRecording(
          record({ recordingId: "c", status: "interrupted", platform: "ios" }),
        );
        const sorted = async (query: Parameters<Repository["listRecordings"]>[0]) =>
          ids(await repository.listRecordings(query)).sort();
        expect(await sorted({})).toEqual(["a", "b", "c"]);
        expect(await sorted({ status: "completed" })).toEqual(["a"]);
        expect(await sorted({ status: ["completed", "interrupted"] })).toEqual(["a", "c"]);
        expect(await sorted({ deviceId: "other" })).toEqual(["b"]);
        expect(await sorted({ platform: "ios" })).toEqual(["c"]);
        expect(await repository.listRecordings({ limit: 2 })).toHaveLength(2);
      }));

    test("listRecordings orders by startedAt (ties by id) and by lastAccessedAt", () =>
      withRepository(async (repository) => {
        await repository.insertRecording(
          record({ recordingId: "a", startedAt: "2024-01-02T00:00:00.000Z" }),
        );
        await repository.insertRecording(
          record({ recordingId: "b", startedAt: "2024-01-01T00:00:00.000Z" }),
        );
        await repository.insertRecording(
          record({ recordingId: "c", startedAt: "2024-01-02T00:00:00.000Z" }),
        );
        expect(ids(await repository.listRecordings({ orderByStartedAt: "asc" }))).toEqual([
          "b",
          "a",
          "c",
        ]);
        expect(ids(await repository.listRecordings({ orderByStartedAt: "desc" }))).toEqual([
          "c",
          "a",
          "b",
        ]);
        await repository.touchRecording("b", "2025-01-01T00:00:00.000Z");
        expect(
          ids(await repository.listRecordings({ orderByLastAccessed: "desc", limit: 1 })),
        ).toEqual(["b"]);
      }));

    test("getLatestRecording returns the newest finished recording only", () =>
      withRepository(async (repository) => {
        expect(await repository.getLatestRecording()).toBeNull();
        await repository.insertRecording(
          record({
            recordingId: "old",
            status: "completed",
            startedAt: "2024-01-01T00:00:00.000Z",
          }),
        );
        await repository.insertRecording(
          record({
            recordingId: "new",
            status: "interrupted",
            startedAt: "2024-03-01T00:00:00.000Z",
          }),
        );
        await repository.insertRecording(
          record({
            recordingId: "live",
            status: "recording",
            startedAt: "2024-09-01T00:00:00.000Z",
          }),
        );
        expect((await repository.getLatestRecording())?.recordingId).toBe("new");
        await repository.insertRecording(
          record({
            recordingId: "partial",
            status: "incomplete",
            startedAt: "2024-05-01T00:00:00.000Z",
          }),
        );
        expect((await repository.getLatestRecording())?.recordingId).toBe("partial");
      }));

    test("owner scoping admits own, base-family and legacy rows; unscoped reads see all", () =>
      withRepository(async (repository) => {
        await repository.insertRecording(record({ recordingId: "mine", ownerSessionUuid: "s1" }));
        await repository.insertRecording(
          record({ recordingId: "derived", ownerSessionUuid: "base:label" }),
        );
        await repository.insertRecording(record({ recordingId: "theirs", ownerSessionUuid: "s2" }));
        await repository.insertRecording(record({ recordingId: "legacy" }));
        const visible = async (scope: {
          ownerSessionUuid?: string;
          ownerBaseSessionUuid?: string;
        }) => ids(await repository.listRecordings(scope)).sort();
        expect(await visible({})).toEqual(["derived", "legacy", "mine", "theirs"]);
        expect(await visible({ ownerSessionUuid: "s1" })).toEqual(["legacy", "mine"]);
        expect(await visible({ ownerSessionUuid: "s1", ownerBaseSessionUuid: "base" })).toEqual([
          "derived",
          "legacy",
          "mine",
        ]);
        expect(await repository.getRecording("theirs", { ownerSessionUuid: "s1" })).toBeNull();
        expect(await repository.getRecording("legacy", { ownerSessionUuid: "s1" })).not.toBeNull();
      }));

    test("returned records do not alias stored state, at any depth", () =>
      withRepository(async (repository) => {
        const input = record();
        await repository.insertRecording(input);
        input.config.resolution!.width = 1;
        input.status = "interrupted";
        const read = await repository.getRecording("rec-1");
        read!.config.resolution!.width = 2;
        read!.status = "completed";
        const again = await repository.getRecording("rec-1");
        expect(again?.status).toBe("recording");
        expect(again?.config.resolution).toEqual({ width: 720, height: 1280 });
      }));
  });
}
