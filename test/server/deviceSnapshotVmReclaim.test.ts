import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BootedDevice, DeviceSnapshotConfig, DeviceSnapshotManifest } from "../../src/models";
import {
  captureDeviceSnapshot,
  listDeviceSnapshots,
  resetDeviceSnapshotManagerDependencies,
  setDeviceSnapshotManagerDependencies,
  updateDeviceSnapshotConfig,
} from "../../src/server/deviceSnapshotManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSnapshotRepository } from "../fakes/FakeDeviceSnapshotRepository";
import { FakeDeviceSnapshotConfigRepository } from "../fakes/FakeDeviceSnapshotConfigRepository";
import { FakeDeviceSnapshotStore } from "../fakes/FakeDeviceSnapshotStore";
import { FakeAvdSnapshotService } from "../fakes/FakeAvdSnapshotService";

const AVD_NAME = "am-api36-ga-arm64";
const EMULATOR: BootedDevice = {
  deviceId: "emulator-5556",
  name: AVD_NAME,
  platform: "android",
};

const MB = 1024 * 1024;

function vmManifest(snapshotName: string, timestamp: string): DeviceSnapshotManifest {
  return {
    snapshotName,
    timestamp,
    deviceId: EMULATOR.deviceId,
    deviceName: AVD_NAME,
    platform: "android",
    snapshotType: "vm",
    includeAppData: true,
    includeSettings: true,
  };
}

describe("deviceSnapshotManager VM snapshot sizing and reclaim (#6490)", () => {
  let fakeTimer: FakeTimer;
  let repository: FakeDeviceSnapshotRepository;
  let configRepository: FakeDeviceSnapshotConfigRepository;
  let store: FakeDeviceSnapshotStore;
  let avdSnapshots: FakeAvdSnapshotService;

  const config: DeviceSnapshotConfig = {
    includeAppData: true,
    includeSettings: false,
    useVmSnapshot: true,
    strictBackupMode: false,
    vmSnapshotTimeoutMs: 12000,
    maxArchiveSizeMb: 4096,
  };

  beforeEach(async () => {
    fakeTimer = new FakeTimer();
    repository = new FakeDeviceSnapshotRepository();
    configRepository = new FakeDeviceSnapshotConfigRepository();
    store = new FakeDeviceSnapshotStore();
    avdSnapshots = new FakeAvdSnapshotService();
    avdSnapshots.setLiveEmulator(AVD_NAME, EMULATOR.deviceId);
    await configRepository.setConfig(config);

    await setDeviceSnapshotManagerDependencies({
      snapshotRepository: repository as any,
      configRepository: configRepository as any,
      snapshotStore: store as any,
      avdSnapshots,
      timer: fakeTimer,
      now: () => new Date(fakeTimer.now()),
      createCaptureProvider: () => ({
        capture: async (args) => {
          const timestamp = new Date(fakeTimer.now()).toISOString();
          // A real VM capture writes nothing under the archive store; the payload
          // lands inside the AVD. Mirror that here.
          avdSnapshots.setVmSnapshot(AVD_NAME, args.snapshotName, 2 * 1024 * MB);
          const manifest = vmManifest(args.snapshotName, timestamp);
          return {
            snapshotName: args.snapshotName,
            timestamp,
            snapshotType: "vm" as const,
            manifest,
          };
        },
      }),
      createRestoreProvider: () => ({
        restore: async (args) => ({
          snapshotType: args.manifest.snapshotType,
          restoredAt: new Date(fakeTimer.now()).toISOString(),
        }),
      }),
    });
  });

  afterEach(() => {
    resetDeviceSnapshotManagerDependencies();
  });

  test("a vm capture records the in-AVD snapshot size, not the empty archive directory", async () => {
    store.queueGeneratedName("vm-1");

    await captureDeviceSnapshot(EMULATOR, {});

    const record = await repository.getSnapshot("vm-1");
    expect(record?.snapshotType).toBe("vm");
    expect(record?.sizeBytes).toBe(2 * 1024 * MB);
  });

  test("a vm capture whose AVD directory cannot be found records an unknown size, never 0", async () => {
    store.queueGeneratedName("vm-unsized");
    await setDeviceSnapshotManagerDependencies({
      createCaptureProvider: () => ({
        capture: async (args) => {
          const timestamp = new Date(fakeTimer.now()).toISOString();
          return {
            snapshotName: args.snapshotName,
            timestamp,
            snapshotType: "vm" as const,
            manifest: vmManifest(args.snapshotName, timestamp),
          };
        },
      }),
    });

    await captureDeviceSnapshot(EMULATOR, {});

    const record = await repository.getSnapshot("vm-unsized");
    expect(record?.sizeBytes).toBeNull();

    const listed = await listDeviceSnapshots();
    expect(listed.unsizedCount).toBe(1);
    expect(listed.totalSizeBytes).toBe(0);
  });

  test("an archive of vm snapshots over the limit evicts oldest-first and issues one delete each", async () => {
    for (const [index, name] of ["vm-old", "vm-mid", "vm-new"].entries()) {
      const timestamp = new Date(1000 + index).toISOString();
      avdSnapshots.setVmSnapshot(AVD_NAME, name, 2 * 1024 * MB);
      await repository.insertSnapshot({
        snapshotName: name,
        deviceId: EMULATOR.deviceId,
        deviceName: AVD_NAME,
        platform: "android",
        snapshotType: "vm",
        includeAppData: true,
        includeSettings: false,
        createdAt: timestamp,
        lastAccessedAt: timestamp,
        sizeBytes: 2 * 1024 * MB,
        manifest: vmManifest(name, timestamp),
      });
    }

    // 6 GB archived, 3 GB budget: the two least-recently-accessed rows go.
    const { evictedSnapshotNames } = await updateDeviceSnapshotConfig({
      maxArchiveSizeMb: 3 * 1024,
    });

    expect(evictedSnapshotNames).toEqual(["vm-old", "vm-mid"]);
    expect(avdSnapshots.getDeleteCalls().map((call) => call.snapshotName)).toEqual([
      "vm-old",
      "vm-mid",
    ]);
    expect(avdSnapshots.getDeleteCalls()[0]?.deviceId).toBe(EMULATOR.deviceId);
    expect(avdSnapshots.hasVmSnapshot(AVD_NAME, "vm-old")).toBe(false);
    expect(await repository.getSnapshot("vm-old")).toBeNull();
    expect(await repository.getSnapshot("vm-new")).not.toBeNull();
  });

  test("an offline emulator marks the row pending reclaim instead of losing the reference", async () => {
    const timestamp = new Date(1000).toISOString();
    avdSnapshots.setVmSnapshot(AVD_NAME, "vm-offline", 2 * 1024 * MB);
    avdSnapshots.setLiveEmulator(AVD_NAME, null);
    await repository.insertSnapshot({
      snapshotName: "vm-offline",
      deviceId: EMULATOR.deviceId,
      deviceName: AVD_NAME,
      platform: "android",
      snapshotType: "vm",
      includeAppData: true,
      includeSettings: false,
      createdAt: timestamp,
      lastAccessedAt: timestamp,
      sizeBytes: 2 * 1024 * MB,
      manifest: vmManifest("vm-offline", timestamp),
    });

    const { evictedSnapshotNames } = await updateDeviceSnapshotConfig({ maxArchiveSizeMb: 1 });

    expect(evictedSnapshotNames).toEqual([]);
    expect(avdSnapshots.getDeleteCalls()).toEqual([]);
    const pending = await repository.getSnapshot("vm-offline");
    expect(pending?.pendingReclaim).toBe(true);
    expect(pending?.pendingReclaimReason).toContain("emulator");
  });

  test("the sweep completes a pending reclaim when that AVD's emulator is next seen live", async () => {
    const timestamp = new Date(1000).toISOString();
    avdSnapshots.setVmSnapshot(AVD_NAME, "vm-pending", 2 * 1024 * MB);
    await repository.insertSnapshot({
      snapshotName: "vm-pending",
      deviceId: EMULATOR.deviceId,
      deviceName: AVD_NAME,
      platform: "android",
      snapshotType: "vm",
      includeAppData: true,
      includeSettings: false,
      createdAt: timestamp,
      lastAccessedAt: timestamp,
      sizeBytes: 2 * 1024 * MB,
      pendingReclaim: true,
      pendingReclaimReason: "emulator offline",
      manifest: vmManifest("vm-pending", timestamp),
    });

    store.queueGeneratedName("vm-fresh");
    await captureDeviceSnapshot(EMULATOR, {});

    expect(avdSnapshots.getDeleteCalls().map((call) => call.snapshotName)).toEqual(["vm-pending"]);
    expect(await repository.getSnapshot("vm-pending")).toBeNull();
    expect(avdSnapshots.hasVmSnapshot(AVD_NAME, "vm-pending")).toBe(false);
  });

  test("in-AVD snapshot directories with no row are reported as orphans, never deleted", async () => {
    avdSnapshots.setVmSnapshot(AVD_NAME, "default_boot", 1024 * MB);
    avdSnapshots.setVmSnapshot(AVD_NAME, "emulator-5554_2026-08-11_23-05-15-803Z", 3 * 1024 * MB);
    avdSnapshots.setVmSnapshot(AVD_NAME, "sweepSnap", 2 * 1024 * MB);

    const listed = await listDeviceSnapshots();

    expect(listed.orphanedAvdSnapshots.count).toBe(2);
    expect(listed.orphanedAvdSnapshots.totalSizeBytes).toBe(5 * 1024 * MB);
    expect(listed.orphanedAvdSnapshots.entries.map((entry) => entry.snapshotName).sort()).toEqual([
      "emulator-5554_2026-08-11_23-05-15-803Z",
      "sweepSnap",
    ]);
    // Report only: an orphan may predate AutoMobile or be user-made.
    expect(avdSnapshots.getDeleteCalls()).toEqual([]);
    expect(avdSnapshots.hasVmSnapshot(AVD_NAME, "sweepSnap")).toBe(true);
  });
});

describe("orphan accounting is keyed by AVD and record type (#6891 review)", () => {
  const OTHER_AVD = "am-api34-ga-arm64";
  let fakeTimer: FakeTimer;
  let repository: FakeDeviceSnapshotRepository;
  let configRepository: FakeDeviceSnapshotConfigRepository;
  let store: FakeDeviceSnapshotStore;
  let avdSnapshots: FakeAvdSnapshotService;

  beforeEach(async () => {
    fakeTimer = new FakeTimer();
    repository = new FakeDeviceSnapshotRepository();
    configRepository = new FakeDeviceSnapshotConfigRepository();
    store = new FakeDeviceSnapshotStore();
    avdSnapshots = new FakeAvdSnapshotService();
    await configRepository.setConfig({
      includeAppData: true,
      includeSettings: false,
      useVmSnapshot: true,
      strictBackupMode: false,
      vmSnapshotTimeoutMs: 12000,
      maxArchiveSizeMb: 4096,
    });
    await setDeviceSnapshotManagerDependencies({
      snapshotRepository: repository as any,
      configRepository: configRepository as any,
      snapshotStore: store as any,
      avdSnapshots,
      timer: fakeTimer,
      now: () => new Date(fakeTimer.now()),
    });
  });

  afterEach(() => {
    resetDeviceSnapshotManagerDependencies();
  });

  async function insertRecord(
    snapshotName: string,
    deviceName: string,
    platform: "android" | "ios",
    snapshotType: "vm" | "archive",
  ): Promise<void> {
    const timestamp = new Date(1000).toISOString();
    await repository.insertSnapshot({
      snapshotName,
      deviceId: platform === "android" ? "emulator-5556" : "SIM-UUID",
      deviceName,
      platform,
      snapshotType,
      includeAppData: true,
      includeSettings: false,
      createdAt: timestamp,
      lastAccessedAt: timestamp,
      sizeBytes: 0,
      manifest: {
        snapshotName,
        timestamp,
        deviceId: platform === "android" ? "emulator-5556" : "SIM-UUID",
        deviceName,
        platform,
        snapshotType,
        includeAppData: true,
        includeSettings: false,
      },
    });
  }

  test("a vm record for another AVD does not hide an unrecorded directory of the same name", async () => {
    await insertRecord("shared", AVD_NAME, "android", "vm");
    avdSnapshots.setVmSnapshot(AVD_NAME, "shared", 1024 * MB);
    avdSnapshots.setVmSnapshot(OTHER_AVD, "shared", 3 * 1024 * MB);

    const listed = await listDeviceSnapshots();

    expect(listed.orphanedAvdSnapshots.entries).toEqual([
      { avdName: OTHER_AVD, snapshotName: "shared", sizeBytes: 3 * 1024 * MB },
    ]);
  });

  test("a non-vm record of the same name does not account for an in-AVD directory", async () => {
    await insertRecord("mirror", AVD_NAME, "android", "archive");
    await insertRecord("sim-only", "iPhone 16", "ios", "archive");
    avdSnapshots.setVmSnapshot(AVD_NAME, "mirror", 2 * 1024 * MB);
    avdSnapshots.setVmSnapshot(AVD_NAME, "sim-only", 1024 * MB);

    const listed = await listDeviceSnapshots();

    expect(listed.orphanedAvdSnapshots.count).toBe(2);
    expect(listed.orphanedAvdSnapshots.totalSizeBytes).toBe(3 * 1024 * MB);
  });
});
