import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { Kysely } from "kysely";
import * as databaseModule from "../../src/db/database";
import { KeyedJsonConfigRepository } from "../../src/db/keyedJsonConfigRepository";
import type { Database } from "../../src/db/types";
import { logger } from "../../src/utils/logger";
import { createTestDatabase } from "./testDbHelper";

describe("KeyedJsonConfigRepository", () => {
  let db: Kysely<Database>;
  const tableCases = [
    {
      tableName: "appearance_configs",
      firstConfig: { defaultMode: "dark" },
      secondConfig: { defaultMode: "light" },
    },
    {
      tableName: "device_snapshot_configs",
      firstConfig: { includeAppData: true },
      secondConfig: { includeAppData: false },
    },
    {
      tableName: "video_recording_configs",
      firstConfig: { qualityPreset: "high" },
      secondConfig: { qualityPreset: "low" },
    },
  ] as const;

  beforeEach(async () => {
    db = await createTestDatabase();
  });

  afterEach(async () => {
    await db.destroy();
  });

  for (const { tableName, firstConfig, secondConfig } of tableCases) {
    test(`stores, updates, and clears the singleton config in ${tableName}`, async () => {
      const repo = new KeyedJsonConfigRepository<typeof firstConfig>({
        tableName,
        db,
      });

      expect(await repo.getConfig()).toBeNull();

      await repo.setConfig(firstConfig);
      expect(await repo.getConfig()).toEqual(firstConfig);

      await repo.setConfig(secondConfig);
      expect(await repo.getConfig()).toEqual(secondConfig);

      await repo.clearConfig();
      expect(await repo.getConfig()).toBeNull();
    });

    test(`updates concurrent first writes with one row for the singleton key in ${tableName}`, async () => {
      const repo = new KeyedJsonConfigRepository<typeof firstConfig>({
        tableName,
        db,
      });

      await expect(
        Promise.all(
          Array.from({ length: 10 }, (_unused, index) =>
            repo.setConfig(index % 2 === 0 ? firstConfig : secondConfig)
          )
        )
      ).resolves.toBeDefined();

      expect(await db.selectFrom(tableName).selectAll().execute()).toHaveLength(1);
    });
  }

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

  test("defers default database resolution until the first operation", async () => {
    const ensureMigrationsSpy = spyOn(databaseModule, "ensureMigrations").mockResolvedValue();
    const getDatabaseSpy = spyOn(databaseModule, "getDatabase").mockReturnValue(db);

    try {
      const repo = new KeyedJsonConfigRepository<{ theme: string }>({
        tableName: "appearance_configs",
      });

      expect(ensureMigrationsSpy).toHaveBeenCalledTimes(0);
      expect(getDatabaseSpy).toHaveBeenCalledTimes(0);

      await repo.setConfig({ theme: "dark" });

      expect(ensureMigrationsSpy).toHaveBeenCalledTimes(1);
      expect(getDatabaseSpy).toHaveBeenCalledTimes(1);
      expect(await db.selectFrom("appearance_configs").selectAll().execute()).toHaveLength(1);
    } finally {
      ensureMigrationsSpy.mockRestore();
      getDatabaseSpy.mockRestore();
    }
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

  test("uses the shared repository directly instead of per-table wrapper modules", () => {
    const wrapperModulePaths = [
      "../../src/db/appearanceConfigRepository.ts",
      "../../src/db/deviceSnapshotConfigRepository.ts",
      "../../src/db/videoRecordingConfigRepository.ts",
    ];
    for (const relativePath of wrapperModulePaths) {
      expect(existsSync(new URL(relativePath, import.meta.url))).toBe(false);
    }

    const serverDir = new URL("../../src/server/", import.meta.url);
    const serverSources = readdirSync(serverDir)
      .filter(fileName => fileName.endsWith(".ts"))
      .map(fileName => readFileSync(new URL(fileName, serverDir), "utf8"))
      .join("\n");

    expect(serverSources).not.toContain("../db/appearanceConfigRepository");
    expect(serverSources).not.toContain("../db/deviceSnapshotConfigRepository");
    expect(serverSources).not.toContain("../db/videoRecordingConfigRepository");
    expect(serverSources).not.toContain("new AppearanceConfigRepository");
    expect(serverSources).not.toContain("new DeviceSnapshotConfigRepository");
    expect(serverSources).not.toContain("new VideoRecordingConfigRepository");
  });
});
