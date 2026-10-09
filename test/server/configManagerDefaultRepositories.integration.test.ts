import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Kysely } from "kysely";
import * as databaseModule from "../../src/db/database";
import type { KeyedJsonConfigTableName } from "../../src/db/keyedJsonConfigRepository";
import type { Database } from "../../src/db/types";
import type {
  AppearanceConfig,
  DeviceSnapshotConfig,
  VideoRecordingConfig,
} from "../../src/models";
import {
  clearSessionAppearanceConfig,
  getAppearanceConfig,
  updateAppearanceConfig,
} from "../../src/server/appearanceManager";
import {
  getDeviceSnapshotConfig,
  resetDeviceSnapshotManagerDependencies,
} from "../../src/server/deviceSnapshotManager";
import {
  getVideoRecordingConfig,
  resetVideoRecordingManagerDependencies,
} from "../../src/server/videoRecordingManager";
import { createTestDatabase } from "../db/testDbHelper";

describe("config manager default repositories", () => {
  let db: Kysely<Database>;
  let ensureMigrationsSpy: ReturnType<typeof spyOn>;
  let getDatabaseSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    db = await createTestDatabase();
    ensureMigrationsSpy = spyOn(databaseModule, "ensureMigrations").mockResolvedValue();
    getDatabaseSpy = spyOn(databaseModule, "getDatabase").mockReturnValue(db);
    resetDeviceSnapshotManagerDependencies();
    resetVideoRecordingManagerDependencies();
  });

  afterEach(async () => {
    ensureMigrationsSpy.mockRestore();
    getDatabaseSpy.mockRestore();
    resetDeviceSnapshotManagerDependencies();
    resetVideoRecordingManagerDependencies();
    await db.destroy();
  });

  async function seedConfig(
    tableName: KeyedJsonConfigTableName,
    config: Record<string, unknown>,
  ): Promise<void> {
    await db
      .insertInto(tableName)
      .values({
        key: "global",
        config_json: JSON.stringify(config),
        updated_at: new Date().toISOString(),
      })
      .execute();
  }

  test("appearance manager reads the shared repository's appearance table by default", async () => {
    const config: AppearanceConfig = {
      syncWithHost: false,
      defaultMode: "dark",
      applyOnConnect: false,
    };
    await seedConfig("appearance_configs", config);

    expect(await getAppearanceConfig()).toEqual(config);
  });

  test("appearance config is stored per session and never leaks to another session (#10976)", async () => {
    await updateAppearanceConfig({ syncWithHost: false, defaultMode: "dark" }, "session-a");

    expect((await getAppearanceConfig("session-a")).defaultMode).toBe("dark");
    expect((await getAppearanceConfig("session-a")).syncWithHost).toBe(false);
    // B has stored nothing, so it sees the defaults, not A's choice.
    expect((await getAppearanceConfig("session-b")).defaultMode).toBe("auto");
    expect((await getAppearanceConfig("session-b")).syncWithHost).toBe(true);
    expect((await getAppearanceConfig()).defaultMode).toBe("auto");
  });

  test("a session without its own row falls back to the global row, and clearing drops only its own", async () => {
    const global: AppearanceConfig = {
      syncWithHost: false,
      defaultMode: "light",
      applyOnConnect: true,
    };
    await seedConfig("appearance_configs", global);
    expect(await getAppearanceConfig("session-a")).toEqual(global);

    await updateAppearanceConfig({ defaultMode: "dark" }, "session-a");
    await updateAppearanceConfig({ defaultMode: "dark" }, "session-b");
    await clearSessionAppearanceConfig("session-a");

    expect(await getAppearanceConfig("session-a")).toEqual(global);
    expect((await getAppearanceConfig("session-b")).defaultMode).toBe("dark");
  });

  test("device snapshot manager reads the shared repository's snapshot table by default", async () => {
    const config: DeviceSnapshotConfig = {
      includeAppData: false,
      includeSettings: true,
      useVmSnapshot: false,
      strictBackupMode: true,
      vmSnapshotTimeoutMs: 34000,
      maxVmSnapshotsPerAvd: 4,
      maxVmArchiveSizeMb: 2048,
      maxArchiveSizeMb: 12,
    };
    await seedConfig("device_snapshot_configs", config);

    expect(await getDeviceSnapshotConfig()).toEqual(config);
  });

  test("video recording manager reads the shared repository's video table by default", async () => {
    const config: VideoRecordingConfig = {
      qualityPreset: "high",
      targetBitrateKbps: 2000,
      maxThroughputMbps: 8,
      fps: 30,
      maxArchiveSizeMb: 45,
      format: "mp4",
    };
    await seedConfig("video_recording_configs", config);

    expect(await getVideoRecordingConfig()).toEqual(config);
  });
});
