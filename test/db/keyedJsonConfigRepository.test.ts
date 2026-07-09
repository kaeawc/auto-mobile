import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import { KeyedJsonConfigRepository } from "../../src/db/keyedJsonConfigRepository";
import type { Database } from "../../src/db/types";
import { logger } from "../../src/utils/logger";
import { createTestDatabase } from "./testDbHelper";

describe("KeyedJsonConfigRepository", () => {
  let db: Kysely<Database>;

  beforeEach(async () => {
    db = await createTestDatabase();
  });

  afterEach(async () => {
    await db.destroy();
  });

  test("stores the singleton config in the configured table only", async () => {
    const repo = new KeyedJsonConfigRepository<{ theme: string }>({
      tableName: "appearance_configs",
      db,
    });

    await repo.setConfig({ theme: "dark" });

    expect(await repo.getConfig()).toEqual({ theme: "dark" });
    expect(await db.selectFrom("appearance_configs").selectAll().execute()).toHaveLength(1);
    expect(await db.selectFrom("device_snapshot_configs").selectAll().execute()).toHaveLength(0);
    expect(await db.selectFrom("video_recording_configs").selectAll().execute()).toHaveLength(0);
  });

  test("updates concurrent first writes with one row for the singleton key", async () => {
    const repo = new KeyedJsonConfigRepository<{ enabled: boolean }>({
      tableName: "video_recording_configs",
      db,
    });

    await expect(
      Promise.all(
        Array.from({ length: 10 }, (_unused, index) =>
          repo.setConfig({ enabled: index % 2 === 0 })
        )
      )
    ).resolves.toBeDefined();

    expect(await db.selectFrom("video_recording_configs").selectAll().execute()).toHaveLength(1);
  });

  test("returns null and logs a warning for malformed config JSON", async () => {
    const warnings: string[] = [];
    const originalWarn = logger.warn;
    logger.warn = (message: string) => {
      warnings.push(message);
    };

    try {
      const repo = new KeyedJsonConfigRepository<{ autoCapture: boolean }>({
        tableName: "device_snapshot_configs",
        loggerTag: "DeviceSnapshotConfigRepository",
        db,
      });
      await db
        .insertInto("device_snapshot_configs")
        .values({
          key: "global",
          config_json: "{not-json",
          updated_at: new Date().toISOString(),
        })
        .execute();

      expect(await repo.getConfig()).toBeNull();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("[DeviceSnapshotConfigRepository] Failed to parse config JSON:");
    } finally {
      logger.warn = originalWarn;
    }
  });
});
