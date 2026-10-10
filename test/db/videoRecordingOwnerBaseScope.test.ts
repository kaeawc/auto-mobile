import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import type { Database } from "../../src/db/types";
import {
  VideoRecordingRepository,
  type VideoRecordingRecord,
} from "../../src/db/videoRecordingRepository";
import { createTestDatabase } from "./testDbHelper";

function makeRecord(recordingId: string, ownerSessionUuid?: string): VideoRecordingRecord {
  return {
    recordingId,
    deviceId: "emulator-5554",
    platform: "android",
    status: "completed",
    fileName: "recording.mp4",
    filePath: `/tmp/${recordingId}.mp4`,
    format: "mp4",
    sizeBytes: 1,
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
    },
    ownerSessionUuid,
  };
}

describe("VideoRecordingRepository owner scope with a base session (#11533)", () => {
  let db: Kysely<Database>;
  let repo: VideoRecordingRepository;

  beforeEach(async () => {
    db = await createTestDatabase();
    repo = new VideoRecordingRepository(db);
    const rows: Array<[string, string | undefined]> = [
      ["derived", "plan-base:pixel"],
      ["sibling", "plan-base:tablet"],
      ["base-owned", "plan-base"],
      ["other-derived", "other:pixel"],
      ["other-prefix", "plan-base2:pixel"],
      ["wild", "plan_base:pixel"],
      ["emoji", "😀:pixel"],
      ["legacy", undefined],
    ];
    for (const [id, owner] of rows) {
      await repo.insertRecording(makeRecord(id, owner));
    }
  });

  afterEach(async () => {
    await db.destroy();
  });

  async function visible(requester: string, base?: string): Promise<string[]> {
    const rows = await repo.listRecordings({
      ownerSessionUuid: requester,
      ownerBaseSessionUuid: base,
    });
    return rows.map((row) => row.recordingId).sort();
  }

  test("the base session reads its own and every derived label session's rows in the query", async () => {
    expect(await visible("plan-base", "plan-base")).toEqual([
      "base-owned",
      "derived",
      "legacy",
      "sibling",
    ]);
    const one = await repo.getRecording("derived", {
      ownerSessionUuid: "plan-base",
      ownerBaseSessionUuid: "plan-base",
    });
    expect(one?.recordingId).toBe("derived");
  });

  test("a derived requester reads its sibling label session's rows through its base", async () => {
    expect(await visible("plan-base:pixel", "plan-base")).toContain("sibling");
  });

  test("another base, a prefix lookalike and a LIKE wildcard base gain nothing", async () => {
    expect(await visible("other", "other")).toEqual(["legacy", "other-derived"]);
    expect(await visible("plan", "plan")).toEqual(["legacy"]);
    expect(await visible("plan%", "plan%")).toEqual(["legacy"]);
    expect(await visible("plan_base", "plan_base")).toEqual(["legacy", "wild"]);
    expect(
      await repo.getRecording("derived", {
        ownerSessionUuid: "other",
        ownerBaseSessionUuid: "other",
      }),
    ).toBeNull();
  });

  test("a non-BMP base id matches by code points, as the in-memory rule does", async () => {
    expect(await visible("😀", "😀")).toEqual(["emoji", "legacy"]);
  });

  test("without a base the scope stays exact-owner", async () => {
    expect(await visible("plan-base")).toEqual(["base-owned", "legacy"]);
  });
});
