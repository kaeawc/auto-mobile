import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";
import type { BootedDevice, DeviceSnapshotConfig, DeviceSnapshotManifest } from "../../src/models";
import { ActionableError } from "../../src/models";
import {
  captureDeviceSnapshot,
  getDeviceSnapshotConfig,
  listDeviceSnapshots,
  resetDeviceSnapshotManagerDependencies,
  restoreDeviceSnapshot,
  setDeviceSnapshotManagerDependencies,
  updateDeviceSnapshotConfig,
} from "../../src/server/deviceSnapshotManager";
import { DeviceSnapshotStore } from "../../src/utils/DeviceSnapshotStore";
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
      createCaptureProvider: () => ({
        capture: async (args) => {
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
      createRestoreProvider: () => ({
        restore: async (args) => {
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

  test("captureDeviceSnapshot inserts no record when the capture fails (#5710)", async () => {
    // A capture that fails (e.g. iOS 0-packages-captured) throws before the
    // manager shapes a result, so no snapshot record must be persisted.
    store.queueGeneratedName("doomed-snapshot");
    await setDeviceSnapshotManagerDependencies({
      createCaptureProvider: () => ({
        capture: async () => {
          throw new ActionableError("iOS app-data capture backed up 0 of 1 requested app(s)");
        },
      }),
    });

    await expect(captureDeviceSnapshot(TEST_DEVICE, { includeAppData: true })).rejects.toThrow(
      /backed up 0 of 1/i,
    );

    expect(await repository.getSnapshot("doomed-snapshot")).toBeNull();
    const listed = await repository.listSnapshots();
    expect(listed).toEqual([]);
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

  test("restoreDeviceSnapshot round-trips an iOS manifest carrying iosSettings", async () => {
    const createdAt = new Date(0).toISOString();
    const manifest: DeviceSnapshotManifest = {
      snapshotName: "ios-settings-snapshot",
      timestamp: createdAt,
      deviceId: TEST_DEVICE.deviceId,
      deviceName: TEST_DEVICE.name,
      platform: "ios",
      snapshotType: "app_data",
      includeAppData: false,
      includeSettings: true,
      iosSettings: {
        values: { ".GlobalPreferences/AppleLocale": "nl_BE" },
        ui: { appearance: "dark", contentSize: "large" },
      },
    };

    await repository.insertSnapshot({
      snapshotName: "ios-settings-snapshot",
      deviceId: TEST_DEVICE.deviceId,
      deviceName: TEST_DEVICE.name,
      platform: "ios",
      snapshotType: "app_data",
      includeAppData: false,
      includeSettings: true,
      createdAt,
      lastAccessedAt: createdAt,
      sizeBytes: 0,
      manifest,
    });

    // The stored record preserves the optional iosSettings field.
    const stored = await repository.getSnapshot("ios-settings-snapshot");
    expect(stored?.manifest.iosSettings).toEqual(manifest.iosSettings);

    const { manifest: returnedManifest } = await restoreDeviceSnapshot(TEST_DEVICE, {
      snapshotName: "ios-settings-snapshot",
    });

    expect(returnedManifest.iosSettings).toEqual(manifest.iosSettings);
    expect(restoreCalls[restoreCalls.length - 1]?.manifest.iosSettings).toEqual(
      manifest.iosSettings,
    );
  });

  test("restoreDeviceSnapshot migrates legacy manifest when missing from repository", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "snapshot-manager-legacy-"));
    try {
      const legacyStore = new DeviceSnapshotStore(tempRoot);
      await legacyStore.ensureSnapshotsDirectory();

      const snapshotName = "legacy-snapshot";
      const snapshotDir = legacyStore.getSnapshotPath(snapshotName);
      await fs.mkdir(snapshotDir, { recursive: true });

      const timestamp = new Date(fakeTimer.now()).toISOString();
      const legacyManifest: DeviceSnapshotManifest = {
        snapshotName,
        timestamp,
        deviceId: TEST_DEVICE.deviceId,
        deviceName: TEST_DEVICE.name,
        platform: TEST_DEVICE.platform,
        snapshotType: "adb",
        includeAppData: true,
        includeSettings: true,
      };

      await fs.writeFile(
        path.join(snapshotDir, "manifest.json"),
        JSON.stringify(legacyManifest, null, 2),
      );

      await setDeviceSnapshotManagerDependencies({
        snapshotStore: legacyStore as any,
      });

      const { result, manifest } = await restoreDeviceSnapshot(TEST_DEVICE, {
        snapshotName,
      });

      expect(result.snapshotType).toBe("adb");
      expect(manifest.snapshotName).toBe(snapshotName);
      expect(restoreCalls[0]?.snapshotName).toBe(snapshotName);
      expect(restoreCalls[0]?.manifest.snapshotName).toBe(snapshotName);

      const record = await repository.getSnapshot(snapshotName);
      expect(record).not.toBeNull();
      expect(record?.createdAt).toBe(timestamp);
      expect(record?.sizeBytes).toBeGreaterThan(0);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("listDeviceSnapshots imports legacy manifest entries", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "snapshot-manager-archive-"));
    try {
      const legacyStore = new DeviceSnapshotStore(tempRoot);
      await legacyStore.ensureSnapshotsDirectory();

      const snapshotName = "legacy-archive-snapshot";
      const snapshotDir = legacyStore.getSnapshotPath(snapshotName);
      await fs.mkdir(snapshotDir, { recursive: true });

      const timestamp = new Date(fakeTimer.now()).toISOString();
      const legacyManifest: DeviceSnapshotManifest = {
        snapshotName,
        timestamp,
        deviceId: TEST_DEVICE.deviceId,
        deviceName: TEST_DEVICE.name,
        platform: TEST_DEVICE.platform,
        snapshotType: "adb",
        includeAppData: true,
        includeSettings: true,
      };

      await fs.writeFile(
        path.join(snapshotDir, "manifest.json"),
        JSON.stringify(legacyManifest, null, 2),
      );

      await setDeviceSnapshotManagerDependencies({
        snapshotStore: legacyStore as any,
      });

      const { snapshots, count } = await listDeviceSnapshots();
      const firstSnapshot = snapshots[0] as { snapshotName?: string };

      expect(count).toBe(1);
      expect(firstSnapshot.snapshotName).toBe(snapshotName);
      expect(await repository.getSnapshot(snapshotName)).not.toBeNull();
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("getDeviceSnapshotConfig normalizes a legacy zero timeout persisted by the old parser", async () => {
    // Simulate a config written by the pre-fix parser, which could round a
    // (0, 0.5) timeout down to a non-positive 0.
    const legacyConfig: DeviceSnapshotConfig = {
      includeAppData: true,
      includeSettings: true,
      useVmSnapshot: true,
      strictBackupMode: false,
      vmSnapshotTimeoutMs: 0,
      maxArchiveSizeMb: 100,
    };
    await configRepository.setConfig(legacyConfig);

    const config = await getDeviceSnapshotConfig();

    expect(config.vmSnapshotTimeoutMs).toBeGreaterThan(0);
    expect(config.vmSnapshotTimeoutMs).toBe(30000);
  });

  test("evicting an Android emulator snapshot deletes its AVD-scoped directory (#5707)", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "snapshot-manager-avd-"));
    try {
      const realStore = new DeviceSnapshotStore(tempRoot);
      await realStore.ensureSnapshotsDirectory();
      await setDeviceSnapshotManagerDependencies({ snapshotStore: realStore as any });

      const snapshotName = "evict-me";
      const avdName = "Pixel_5";
      const emulatorDeviceId = "emulator-5554";
      const androidOptions = { platform: "android" as const, avdName };

      // Write the snapshot on disk at the AVD-scoped path — where capture puts it.
      const scopedDir = realStore.getSnapshotPathWithOptions(snapshotName, androidOptions);
      await fs.mkdir(scopedDir, { recursive: true });
      await fs.writeFile(path.join(scopedDir, "settings.json"), "{}");
      // The legacy flat path must NOT be where this snapshot lives.
      const flatDir = realStore.getSnapshotPath(snapshotName);
      expect(scopedDir).not.toBe(flatDir);

      const timestamp = new Date(fakeTimer.now()).toISOString();
      const manifest: DeviceSnapshotManifest = {
        snapshotName,
        timestamp,
        deviceId: emulatorDeviceId,
        deviceName: avdName,
        platform: "android",
        snapshotType: "adb",
        includeAppData: false,
        includeSettings: true,
      };
      await repository.insertSnapshot({
        snapshotName,
        deviceId: emulatorDeviceId,
        deviceName: avdName,
        platform: "android",
        snapshotType: "adb",
        includeAppData: false,
        includeSettings: true,
        createdAt: timestamp,
        lastAccessedAt: timestamp,
        sizeBytes: 5 * 1024 * 1024,
        manifest,
      });

      // Force eviction by lowering the archive limit below the record size.
      await updateDeviceSnapshotConfig({ maxArchiveSizeMb: 1 });

      // The AVD-scoped directory is deleted — the manager resolved the path from
      // the record's deviceName (the AVD name), not the flat/legacy path.
      expect(await realStore.snapshotDirectoryExists(snapshotName, androidOptions)).toBe(false);
      expect(await repository.getSnapshot(snapshotName)).toBeNull();
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("evicting a legacy FLAT Android emulator snapshot reclaims the flat directory (#5707/#5724)", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "snapshot-manager-legacy-flat-"));
    try {
      const realStore = new DeviceSnapshotStore(tempRoot);
      await realStore.ensureSnapshotsDirectory();
      await setDeviceSnapshotManagerDependencies({ snapshotStore: realStore as any });

      const snapshotName = "legacy-flat";
      const avdName = "Pixel_5";
      const emulatorDeviceId = "emulator-5554";

      // Pre-scoping data lives at the UNSCOPED flat path. Eviction computes the
      // scoped path from the record; without the flat-path fallback it would
      // fs.rm a nonexistent dir, delete the row, report bytes reclaimed, and
      // leave this directory (and its re-importable manifest) on disk.
      const flatDir = realStore.getSnapshotPath(snapshotName);
      await fs.mkdir(flatDir, { recursive: true });
      await fs.writeFile(path.join(flatDir, "settings.json"), "{}");

      const timestamp = new Date(fakeTimer.now()).toISOString();
      const manifest: DeviceSnapshotManifest = {
        snapshotName,
        timestamp,
        deviceId: emulatorDeviceId,
        deviceName: avdName,
        platform: "android",
        snapshotType: "adb",
        includeAppData: false,
        includeSettings: true,
      };
      await repository.insertSnapshot({
        snapshotName,
        deviceId: emulatorDeviceId,
        deviceName: avdName,
        platform: "android",
        snapshotType: "adb",
        includeAppData: false,
        includeSettings: true,
        createdAt: timestamp,
        lastAccessedAt: timestamp,
        sizeBytes: 5 * 1024 * 1024,
        manifest,
      });

      await updateDeviceSnapshotConfig({ maxArchiveSizeMb: 1 });

      // The flat directory is actually gone — eviction did not silently under-reclaim.
      expect(await realStore.snapshotDirectoryExists(snapshotName)).toBe(false);
      expect(await repository.getSnapshot(snapshotName)).toBeNull();
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("captureDeviceSnapshot rejects a reserved scope-root name (#5707)", async () => {
    for (const reserved of ["android", "ios"]) {
      await expect(captureDeviceSnapshot(TEST_DEVICE, { snapshotName: reserved })).rejects.toThrow(
        /reserved/i,
      );
    }
  });

  test("legacy flat-path cleanup never deletes a reserved scope root (#5707)", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "snapshot-manager-reserved-"));
    try {
      const realStore = new DeviceSnapshotStore(tempRoot);
      await realStore.ensureSnapshotsDirectory();
      await setDeviceSnapshotManagerDependencies({ snapshotStore: realStore as any });

      // A different AVD's real snapshot living under the "android" scope root.
      const other = { platform: "android" as const, avdName: "Pixel_7" };
      const otherDir = realStore.getSnapshotPathWithOptions("keep-me", other);
      await fs.mkdir(otherDir, { recursive: true });
      await fs.writeFile(path.join(otherDir, "settings.json"), "{}");

      // A pathological snapshot literally named "android": its flat path is the
      // scope root that holds `otherDir`. Evicting it must not wipe that tree.
      const timestamp = new Date(fakeTimer.now()).toISOString();
      const manifest: DeviceSnapshotManifest = {
        snapshotName: "android",
        timestamp,
        deviceId: "emulator-5554",
        deviceName: "Pixel_5",
        platform: "android",
        snapshotType: "adb",
        includeAppData: false,
        includeSettings: true,
      };
      await repository.insertSnapshot({
        snapshotName: "android",
        deviceId: "emulator-5554",
        deviceName: "Pixel_5",
        platform: "android",
        snapshotType: "adb",
        includeAppData: false,
        includeSettings: true,
        createdAt: timestamp,
        lastAccessedAt: timestamp,
        sizeBytes: 5 * 1024 * 1024,
        manifest,
      });

      await updateDeviceSnapshotConfig({ maxArchiveSizeMb: 1 });

      // The unrelated AVD's snapshot under the scope root survives.
      expect(await realStore.snapshotDirectoryExists("keep-me", other)).toBe(true);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
