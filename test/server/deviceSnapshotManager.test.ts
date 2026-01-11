import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BootedDevice, DeviceSnapshotConfig, DeviceSnapshotManifest } from "../../src/models";
import {
  captureDeviceSnapshot,
  resetDeviceSnapshotManagerDependencies,
  restoreDeviceSnapshot,
  setDeviceSnapshotManagerDependencies,
} from "../../src/server/deviceSnapshotManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSnapshotRepository } from "../fakes/FakeDeviceSnapshotRepository";
import { FakeDeviceSnapshotConfigRepository } from "../fakes/FakeDeviceSnapshotConfigRepository";
import { FakeDeviceSnapshotStore } from "../fakes/FakeDeviceSnapshotStore";

const TEST_DEVICE: BootedDevice = {
  deviceId: "test-device",
  name: "Test Device",
  platform: "android",
};

describe("deviceSnapshotManager", () => {
  let fakeTimer: FakeTimer;
  let repository: FakeDeviceSnapshotRepository;
  let configRepository: FakeDeviceSnapshotConfigRepository;
  let store: FakeDeviceSnapshotStore;
  let captureCalls: Array<Record<string, unknown>>;
  let restoreCalls: Array<Record<string, unknown>>;

  beforeEach(async () => {
    fakeTimer = new FakeTimer();
    fakeTimer.setManualMode();
    repository = new FakeDeviceSnapshotRepository();
    configRepository = new FakeDeviceSnapshotConfigRepository();
    store = new FakeDeviceSnapshotStore();
    captureCalls = [];
    restoreCalls = [];

    await setDeviceSnapshotManagerDependencies({
      snapshotRepository: repository as any,
      configRepository: configRepository as any,
      snapshotStore: store as any,
      timer: fakeTimer,
      now: () => new Date(fakeTimer.now()),
      createCaptureAction: () => ({
        execute: async args => {
          captureCalls.push({ ...args });
          const timestamp = new Date(fakeTimer.now()).toISOString();
          const manifest: DeviceSnapshotManifest = {
            snapshotName: args.snapshotName,
            timestamp,
            deviceId: TEST_DEVICE.deviceId,
            deviceName: TEST_DEVICE.name,
            platform: TEST_DEVICE.platform,
            snapshotType: "adb",
            includeAppData: args.includeAppData ?? true,
            includeSettings: args.includeSettings ?? true,
          };
          return {
            snapshotName: args.snapshotName,
            timestamp,
            snapshotType: "adb",
            manifest,
          };
        },
      }),
      createRestoreAction: () => ({
        execute: async args => {
          restoreCalls.push({ ...args });
          return {
            snapshotType: args.manifest.snapshotType,
            restoredAt: new Date(fakeTimer.now()).toISOString(),
          };
        },
      }),
    });
  });

  afterEach(() => {
    resetDeviceSnapshotManagerDependencies();
  });

  test("captureDeviceSnapshot uses defaults, generates name, and evicts old snapshots", async () => {
    const config: DeviceSnapshotConfig = {
      includeAppData: false,
      includeSettings: true,
      useVmSnapshot: true,
      strictBackupMode: false,
      backupTimeoutMs: 10000,
      userApps: "current",
      vmSnapshotTimeoutMs: 12000,
      maxArchiveSizeMb: 1,
    };
    await configRepository.setConfig(config);

    const oldTimestamp = new Date(0).toISOString();
    const oldManifest: DeviceSnapshotManifest = {
      snapshotName: "old-snapshot",
      timestamp: oldTimestamp,
      deviceId: TEST_DEVICE.deviceId,
      deviceName: TEST_DEVICE.name,
      platform: TEST_DEVICE.platform,
      snapshotType: "adb",
      includeAppData: true,
      includeSettings: true,
    };

    await repository.insertSnapshot({
      snapshotName: "old-snapshot",
      deviceId: TEST_DEVICE.deviceId,
      deviceName: TEST_DEVICE.name,
      platform: TEST_DEVICE.platform,
      snapshotType: "adb",
      includeAppData: true,
      includeSettings: true,
      createdAt: oldTimestamp,
      lastAccessedAt: oldTimestamp,
      sizeBytes: 900 * 1024,
      manifest: oldManifest,
    });

    store.setSnapshotSize("old-snapshot", 900 * 1024);
    store.setSnapshotExists("old-snapshot", true);
    store.queueGeneratedName("new-snapshot");
    store.setSnapshotSize("new-snapshot", 700 * 1024);

    const { result, evictedSnapshotNames } = await captureDeviceSnapshot(TEST_DEVICE, {
      includeAppData: true,
    });

    expect(result.snapshotName).toBe("new-snapshot");
    expect(captureCalls[0]?.includeAppData).toBe(true);
    expect(evictedSnapshotNames).toEqual(["old-snapshot"]);
    expect(await repository.getSnapshot("old-snapshot")).toBeNull();
    expect(store.getDeletedSnapshots()).toContain("old-snapshot");

    const inserted = await repository.getSnapshot("new-snapshot");
    expect(inserted?.sizeBytes).toBe(700 * 1024);
  });

  test("restoreDeviceSnapshot touches lastAccessedAt and forwards manifest", async () => {
    const createdAt = new Date(0).toISOString();
    const manifest: DeviceSnapshotManifest = {
      snapshotName: "restore-me",
      timestamp: createdAt,
      deviceId: TEST_DEVICE.deviceId,
      deviceName: TEST_DEVICE.name,
      platform: TEST_DEVICE.platform,
      snapshotType: "adb",
      includeAppData: true,
      includeSettings: true,
    };

    await repository.insertSnapshot({
      snapshotName: "restore-me",
      deviceId: TEST_DEVICE.deviceId,
      deviceName: TEST_DEVICE.name,
      platform: TEST_DEVICE.platform,
      snapshotType: "adb",
      includeAppData: true,
      includeSettings: true,
      createdAt,
      lastAccessedAt: createdAt,
      sizeBytes: 0,
      manifest,
    });

    fakeTimer.advanceTime(5000);
    const nowIso = new Date(fakeTimer.now()).toISOString();

    const { result, manifest: returnedManifest } = await restoreDeviceSnapshot(TEST_DEVICE, {
      snapshotName: "restore-me",
    });

    expect(result.snapshotType).toBe("adb");
    expect(returnedManifest.snapshotName).toBe("restore-me");
    expect(restoreCalls[0]?.manifest).toEqual(manifest);

    const updated = await repository.getSnapshot("restore-me");
    expect(updated?.lastAccessedAt).toBe(nowIso);
  });
});
