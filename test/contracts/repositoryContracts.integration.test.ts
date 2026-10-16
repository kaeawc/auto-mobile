import type { DeviceSnapshotConfig, VideoRecordingConfig } from "../../src/models";
import {
  createDeviceSnapshotConfigRepository,
  createVideoRecordingConfigRepository,
} from "../../src/db/keyedJsonConfigRepository";
import { SqliteFeatureFlagRepository } from "../../src/features/featureFlags/FeatureFlagRepository";
import { SqliteSessionToolSelectionRepository } from "../../src/features/toolSelection/SqliteSessionToolSelectionRepository";
import { createTestDatabase } from "../db/testDbHelper";
import { FakeVideoRecordingConfigRepository } from "../fakes/FakeVideoRecordingConfigRepository";
import { FakeFeatureFlagRepository } from "../fakes/FakeFeatureFlagRepository";
import { FakeDeviceSnapshotConfigRepository } from "../fakes/FakeDeviceSnapshotConfigRepository";
import { FakeToolSelectionRepository } from "../fakes/FakeToolSelectionRepository";
import { runConfigRepositoryContract } from "./ConfigRepositoryContract";
import { runFeatureFlagRepositoryContract } from "./FeatureFlagRepositoryContract";
import { runSessionToolSelectionRepositoryContract } from "./SessionToolSelectionRepositoryContract";

// Real implementations run over createTestDatabase() (in-memory SQLite), never the
// file-backed database (#11868).
runFeatureFlagRepositoryContract("FakeFeatureFlagRepository", async () => ({
  repository: new FakeFeatureFlagRepository(),
}));
runFeatureFlagRepositoryContract("SqliteFeatureFlagRepository", async () => {
  const db = await createTestDatabase();
  return { repository: new SqliteFeatureFlagRepository(db), dispose: () => db.destroy() };
});

runSessionToolSelectionRepositoryContract("FakeToolSelectionRepository", async () => ({
  repository: new FakeToolSelectionRepository(),
}));
runSessionToolSelectionRepositoryContract("SqliteSessionToolSelectionRepository", async () => {
  const db = await createTestDatabase();
  return {
    repository: new SqliteSessionToolSelectionRepository(() => db),
    dispose: () => db.destroy(),
  };
});

const videoConfigs: { first: VideoRecordingConfig; second: VideoRecordingConfig } = {
  first: {
    qualityPreset: "low",
    targetBitrateKbps: 1000,
    maxThroughputMbps: 5,
    fps: 15,
    maxArchiveSizeMb: 100,
    format: "mp4",
  },
  second: {
    qualityPreset: "high",
    targetBitrateKbps: 8000,
    maxThroughputMbps: 25,
    fps: 30,
    maxArchiveSizeMb: 500,
    format: "mp4",
    resolution: { width: 1280, height: 720 },
  },
};
runConfigRepositoryContract(
  "FakeVideoRecordingConfigRepository",
  async () => ({
    repository: new FakeVideoRecordingConfigRepository(),
  }),
  videoConfigs,
);
runConfigRepositoryContract(
  "VideoRecordingConfig (SQLite)",
  async () => {
    const db = await createTestDatabase();
    return { repository: createVideoRecordingConfigRepository(db), dispose: () => db.destroy() };
  },
  videoConfigs,
);

const snapshotConfigs: { first: DeviceSnapshotConfig; second: DeviceSnapshotConfig } = {
  first: {
    includeAppData: true,
    includeSettings: true,
    useVmSnapshot: true,
    strictBackupMode: false,
    vmSnapshotTimeoutMs: 60_000,
    maxVmSnapshotsPerAvd: 3,
    maxArchiveSizeMb: 100,
  },
  second: {
    includeAppData: false,
    includeSettings: false,
    useVmSnapshot: false,
    strictBackupMode: true,
    vmSnapshotTimeoutMs: 120_000,
    maxVmSnapshotsPerAvd: 5,
    maxVmArchiveSizeMb: 4096,
    maxArchiveSizeMb: 250,
  },
};
runConfigRepositoryContract(
  "FakeDeviceSnapshotConfigRepository",
  async () => ({
    repository: new FakeDeviceSnapshotConfigRepository(),
  }),
  snapshotConfigs,
);
runConfigRepositoryContract(
  "DeviceSnapshotConfig (SQLite)",
  async () => {
    const db = await createTestDatabase();
    return { repository: createDeviceSnapshotConfigRepository(db), dispose: () => db.destroy() };
  },
  snapshotConfigs,
);
