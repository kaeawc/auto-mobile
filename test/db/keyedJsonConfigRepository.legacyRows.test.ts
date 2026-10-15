import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  createAppearanceConfigRepository,
  createDeviceSnapshotConfigRepository,
  createVideoRecordingConfigRepository,
  type KeyedJsonConfigTableName,
} from "../../src/db/keyedJsonConfigRepository";
import { DEFAULT_DEVICE_SNAPSHOT_CONFIG } from "../../src/features/snapshot/DeviceSnapshotConfig";
import { createTestDatabase } from "./testDbHelper";

let db: Awaited<ReturnType<typeof createTestDatabase>>;
beforeEach(async () => {
  db = await createTestDatabase();
});
afterEach(async () => {
  await db.destroy();
});
async function insert(table: KeyedJsonConfigTableName, config: unknown) {
  await db
    .insertInto(table)
    .values({
      key: "global",
      config_json: JSON.stringify(config),
      updated_at: "2026-01-01T00:00:00Z",
    })
    .execute();
}

test("oldest appearance row round-trips", async () => {
  const config = { syncWithHost: false, defaultMode: "dark", applyOnConnect: true };
  await insert("appearance_configs", config);
  expect(await createAppearanceConfigRepository(db).getConfig()).toEqual(config);
});
test("oldest video recording row round-trips without optional resolution", async () => {
  const config = {
    qualityPreset: "high",
    targetBitrateKbps: 2000,
    maxThroughputMbps: 8,
    fps: 30,
    maxArchiveSizeMb: 45,
    format: "mp4",
  };
  await insert("video_recording_configs", config);
  expect(await createVideoRecordingConfigRepository(db).getConfig()).toEqual(config);
});
const storedSnapshot = {
  includeAppData: false,
  includeSettings: false,
  useVmSnapshot: false,
  vmSnapshotTimeoutMs: 34000,
  maxArchiveSizeMb: 12,
};
test("oldest snapshot row defaults new fields and strips removed keys", async () => {
  await insert("device_snapshot_configs", {
    ...storedSnapshot,
    backupTimeoutMs: 500,
    userApps: ["legacy"],
  });
  expect(await createDeviceSnapshotConfigRepository(db).getConfig()).toEqual({
    ...storedSnapshot,
    strictBackupMode: false,
    maxVmSnapshotsPerAvd: DEFAULT_DEVICE_SNAPSHOT_CONFIG.maxVmSnapshotsPerAvd,
  });
});
test("missing strictBackupMode preserves every stored snapshot value", async () => {
  await insert("device_snapshot_configs", {
    ...storedSnapshot,
    maxVmSnapshotsPerAvd: 7,
    maxVmArchiveSizeMb: 2048,
  });
  expect(await createDeviceSnapshotConfigRepository(db).getConfig()).toEqual({
    ...storedSnapshot,
    strictBackupMode: false,
    maxVmSnapshotsPerAvd: 7,
    maxVmArchiveSizeMb: 2048,
  });
});
test("missing snapshot fields use their matching manager defaults", async () => {
  await insert("device_snapshot_configs", {});
  expect(await createDeviceSnapshotConfigRepository(db).getConfig()).toEqual(
    DEFAULT_DEVICE_SNAPSHOT_CONFIG,
  );
});
