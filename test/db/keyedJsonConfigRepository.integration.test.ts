import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Kysely } from "kysely";
import * as databaseModule from "../../src/db/database";
import {
  KeyedJsonConfigRepository,
  createAppearanceConfigRepository,
  createDeviceSnapshotConfigRepository,
  createVideoRecordingConfigRepository,
} from "../../src/db/keyedJsonConfigRepository";
import type { Database } from "../../src/db/types";
import { createTestDatabase } from "./testDbHelper";
import { FakeLogger } from "../fakes/FakeLogger";

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
            repo.setConfig(index % 2 === 0 ? firstConfig : secondConfig),
          ),
        ),
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

  test("factory constructors route each config type to its keyed table", async () => {
    const appearance = createAppearanceConfigRepository(db);
    const deviceSnapshot = createDeviceSnapshotConfigRepository(db);
    const videoRecording = createVideoRecordingConfigRepository(db);

    await appearance.setConfig({
      syncWithHost: false,
      defaultMode: "dark",
      applyOnConnect: false,
    });
    await deviceSnapshot.setConfig({
      includeAppData: false,
      includeSettings: true,
      useVmSnapshot: false,
      strictBackupMode: true,
      vmSnapshotTimeoutMs: 34000,
      maxArchiveSizeMb: 12,
    });
    await videoRecording.setConfig({
      qualityPreset: "high",
      targetBitrateKbps: 2000,
      maxThroughputMbps: 8,
      fps: 30,
      maxArchiveSizeMb: 45,
      format: "mp4",
    });

    expect(await db.selectFrom("appearance_configs").selectAll().execute()).toHaveLength(1);
    expect(await db.selectFrom("device_snapshot_configs").selectAll().execute()).toHaveLength(1);
    expect(await db.selectFrom("video_recording_configs").selectAll().execute()).toHaveLength(1);
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
    const log = new FakeLogger();
    const repo = new KeyedJsonConfigRepository<{ autoCapture: boolean }>({
      tableName: "device_snapshot_configs",
      loggerTag: "DeviceSnapshotConfigRepository",
      db,
      logger: log,
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
    expect(log.at("warn")).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining(
          "[DeviceSnapshotConfigRepository] Failed to parse config JSON:",
        ),
      }),
    );
  });
});
