import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ActionableError,
  type BootedDevice,
  type DeviceSnapshotConfig,
  type DeviceSnapshotManifest,
} from "../../src/models";
import {
  captureDeviceSnapshot,
  listDeviceSnapshots,
  resetDeviceSnapshotManagerDependencies,
  restoreDeviceSnapshot,
  setDeviceSnapshotManagerDependencies,
  updateDeviceSnapshotConfig,
} from "../../src/server/deviceSnapshotManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSnapshotRepository } from "../fakes/FakeDeviceSnapshotRepository";
import { FakeDeviceSnapshotConfigRepository } from "../fakes/FakeDeviceSnapshotConfigRepository";
import { FakeDeviceSnapshotStore } from "../fakes/FakeDeviceSnapshotStore";
import { FakeAvdSnapshotService, fakeAvdSnapshotPath } from "../fakes/FakeAvdSnapshotService";

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
    maxVmSnapshotsPerAvd: 3,
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
      deviceIncarnationInvalidator: {
        prepareForIncarnationChange: async () => undefined,
        invalidate: async () => undefined,
      },
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

  test("a VM capture larger than the non-VM byte budget is retained", async () => {
    // A real VM payload is routinely multiple GB, while maxArchiveSizeMb is the
    // small archive-store budget for adb/app_data/simctl snapshots. It must not
    // delete the VM row the successful capture just created (#6960).
    await updateDeviceSnapshotConfig({ maxArchiveSizeMb: 1 });
    store.queueGeneratedName("vm-oversized");

    const { evictedSnapshotNames } = await captureDeviceSnapshot(EMULATOR, {});

    expect(evictedSnapshotNames).toEqual([]);
    expect(await repository.getSnapshot("vm-oversized")).not.toBeNull();
    expect(avdSnapshots.getDeleteCalls()).toEqual([]);
    expect(avdSnapshots.hasVmSnapshot(AVD_NAME, "vm-oversized")).toBe(true);
  });

  test("VM count retention keeps the just-captured oldest record and evicts other oldest rows first", async () => {
    for (const [index, name] of ["vm-old", "vm-mid"].entries()) {
      const timestamp = new Date(2_000 + index).toISOString();
      avdSnapshots.setVmSnapshot(AVD_NAME, name, 2 * MB);
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
        sizeBytes: 2 * MB,
        manifest: vmManifest(name, timestamp),
      });
    }
    await updateDeviceSnapshotConfig({ maxVmSnapshotsPerAvd: 2 });
    store.queueGeneratedName("vm-skewed");

    const { evictedSnapshotNames } = await captureDeviceSnapshot(EMULATOR, {});

    expect(evictedSnapshotNames).toEqual(["vm-old"]);
    expect(await repository.getSnapshot("vm-skewed")).not.toBeNull();
    expect(await repository.getSnapshot("vm-mid")).not.toBeNull();
    expect(await repository.getSnapshot("vm-old")).toBeNull();
  });

  test("an explicit VM byte ceiling smaller than a capture rolls back its row and payload", async () => {
    await updateDeviceSnapshotConfig({ maxVmArchiveSizeMb: 1 });
    store.queueGeneratedName("vm-too-large");

    const capture = captureDeviceSnapshot(EMULATOR, {});
    await expect(capture).rejects.toBeInstanceOf(ActionableError);
    await expect(capture).rejects.toThrow(/maxVmArchiveSizeMb/i);

    expect(await repository.getSnapshot("vm-too-large")).toBeNull();
    expect(avdSnapshots.hasVmSnapshot(AVD_NAME, "vm-too-large")).toBe(false);
    expect(store.getDeletedSnapshots()).toContain("vm-too-large");
  });

  test("an oversized protected capture does not evict an older VM snapshot before rollback", async () => {
    const timestamp = new Date(1_000).toISOString();
    avdSnapshots.setVmSnapshot(AVD_NAME, "vm-existing", 2 * 1024 * MB);
    await repository.insertSnapshot({
      snapshotName: "vm-existing",
      deviceId: EMULATOR.deviceId,
      deviceName: AVD_NAME,
      platform: "android",
      snapshotType: "vm",
      includeAppData: true,
      includeSettings: false,
      createdAt: timestamp,
      lastAccessedAt: timestamp,
      sizeBytes: 2 * 1024 * MB,
      manifest: vmManifest("vm-existing", timestamp),
    });
    await updateDeviceSnapshotConfig({ maxVmArchiveSizeMb: 3072 });
    await setDeviceSnapshotManagerDependencies({
      createCaptureProvider: () => ({
        capture: async (args) => {
          const capturedAt = new Date(fakeTimer.now()).toISOString();
          avdSnapshots.setVmSnapshot(AVD_NAME, args.snapshotName, 4 * 1024 * MB);
          return {
            snapshotName: args.snapshotName,
            timestamp: capturedAt,
            snapshotType: "vm" as const,
            manifest: vmManifest(args.snapshotName, capturedAt),
          };
        },
      }),
    });
    store.queueGeneratedName("vm-too-large");

    await expect(captureDeviceSnapshot(EMULATOR, {})).rejects.toThrow(/maxVmArchiveSizeMb/i);

    expect((await repository.getSnapshot("vm-existing"))?.sizeBytes).toBe(2 * 1024 * MB);
    expect(await repository.getSnapshot("vm-too-large")).toBeNull();
    expect(avdSnapshots.hasVmSnapshot(AVD_NAME, "vm-too-large")).toBe(false);
  });

  test("an oversized same-name VM recapture keeps its replacement payload", async () => {
    await captureDeviceSnapshot(EMULATOR, { snapshotName: "shared" });
    await updateDeviceSnapshotConfig({ maxVmArchiveSizeMb: 3072 });
    await setDeviceSnapshotManagerDependencies({
      createCaptureProvider: () => ({
        capture: async (args) => {
          const timestamp = new Date(fakeTimer.now()).toISOString();
          avdSnapshots.setVmSnapshot(AVD_NAME, args.snapshotName, 4 * 1024 * MB);
          return {
            snapshotName: args.snapshotName,
            timestamp,
            snapshotType: "vm" as const,
            manifest: vmManifest(args.snapshotName, timestamp),
          };
        },
      }),
    });

    await expect(captureDeviceSnapshot(EMULATOR, { snapshotName: "shared" })).rejects.toThrow(
      /maxVmArchiveSizeMb/i,
    );

    expect((await repository.getSnapshot("shared"))?.sizeBytes).toBe(4 * 1024 * MB);
    expect(avdSnapshots.hasVmSnapshot(AVD_NAME, "shared")).toBe(true);
  });

  test("a rejected VM capture reports an incomplete reclaim instead of claiming rollback", async () => {
    await updateDeviceSnapshotConfig({ maxVmArchiveSizeMb: 1 });
    avdSnapshots.failNextDeletesWith("emulator console unavailable");
    store.queueGeneratedName("vm-reclaim-pending");

    await expect(captureDeviceSnapshot(EMULATOR, {})).rejects.toThrow(/could not be reclaimed/i);

    expect(await repository.getSnapshot("vm-reclaim-pending")).not.toBeNull();
    expect(avdSnapshots.hasVmSnapshot(AVD_NAME, "vm-reclaim-pending")).toBe(true);
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

  test("an archive of VM snapshots over its per-AVD count evicts oldest-first and issues one delete each", async () => {
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

    // Three rows with a one-snapshot per-AVD retention: the two oldest go.
    const { evictedSnapshotNames } = await updateDeviceSnapshotConfig({
      maxVmSnapshotsPerAvd: 1,
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

  test("tightening VM retention sweeps every AVD, not only the most recent capture's AVD", async () => {
    const otherAvd = "am-api34-ga-arm64";
    const otherSerial = "emulator-5554";
    avdSnapshots.setLiveEmulator(otherAvd, otherSerial);
    for (const [deviceName, deviceId] of [
      [AVD_NAME, EMULATOR.deviceId],
      [otherAvd, otherSerial],
    ] as const) {
      for (const [index, name] of ["old", "new"].entries()) {
        const snapshotName = `${deviceName}-${name}`;
        const timestamp = new Date(4_000 + index).toISOString();
        avdSnapshots.setVmSnapshot(deviceName, snapshotName, MB);
        await repository.insertSnapshot({
          snapshotName,
          deviceId,
          deviceName,
          platform: "android",
          snapshotType: "vm",
          includeAppData: true,
          includeSettings: false,
          createdAt: timestamp,
          lastAccessedAt: timestamp,
          sizeBytes: MB,
          manifest: { ...vmManifest(snapshotName, timestamp), deviceId, deviceName },
        });
      }
    }

    const { evictedSnapshotNames } = await updateDeviceSnapshotConfig({ maxVmSnapshotsPerAvd: 1 });

    expect(evictedSnapshotNames.sort()).toEqual([`${AVD_NAME}-old`, `${otherAvd}-old`].sort());
    expect(await repository.getSnapshot(`${AVD_NAME}-new`)).not.toBeNull();
    expect(await repository.getSnapshot(`${otherAvd}-new`)).not.toBeNull();
  });

  describe("a row left unsized is re-measured before the budget is enforced (#6891 review)", () => {
    // The upgrade migration flags every pre-change Android `vm` row unsized,
    // because the size it carries was measured at the archive directory and
    // describes none of its bytes. Nothing re-imports a row that already exists,
    // so unless enforcement re-measures it the payload stays outside the budget
    // forever while the archive reports it as unknown.
    async function seedUnsizedVmRow(sizeOnDisk: number | null): Promise<void> {
      const timestamp = new Date(1000).toISOString();
      if (sizeOnDisk !== null) {
        avdSnapshots.setVmSnapshot(AVD_NAME, "vm-legacy", sizeOnDisk);
      }
      await repository.insertSnapshot({
        snapshotName: "vm-legacy",
        deviceId: EMULATOR.deviceId,
        deviceName: AVD_NAME,
        platform: "android",
        snapshotType: "vm",
        includeAppData: true,
        includeSettings: false,
        createdAt: timestamp,
        lastAccessedAt: timestamp,
        sizeBytes: null,
        manifest: vmManifest("vm-legacy", timestamp),
      });
    }

    test("the re-measured size is persisted and stops being reported as unsized", async () => {
      await seedUnsizedVmRow(2 * 1024 * MB);

      await updateDeviceSnapshotConfig({ maxVmSnapshotsPerAvd: 3 });

      expect((await repository.getSnapshot("vm-legacy"))?.sizeBytes).toBe(2 * 1024 * MB);
      const listed = await listDeviceSnapshots();
      expect(listed.unsizedCount).toBe(0);
      expect(listed.totalSizeBytes).toBe(2 * 1024 * MB);
    });

    test("a re-measured row over the optional VM byte budget is evicted instead of hiding behind an unknown size", async () => {
      await seedUnsizedVmRow(2 * 1024 * MB);

      const { evictedSnapshotNames } = await updateDeviceSnapshotConfig({
        maxVmArchiveSizeMb: 1024,
      });

      expect(evictedSnapshotNames).toEqual(["vm-legacy"]);
      expect(await repository.getSnapshot("vm-legacy")).toBeNull();
      expect(avdSnapshots.hasVmSnapshot(AVD_NAME, "vm-legacy")).toBe(false);
    });

    test("a payload that still cannot be located stays unknown rather than becoming a fabricated 0", async () => {
      await seedUnsizedVmRow(null);

      await updateDeviceSnapshotConfig({ maxVmSnapshotsPerAvd: 3 });

      expect((await repository.getSnapshot("vm-legacy"))?.sizeBytes).toBeNull();
      expect((await listDeviceSnapshots()).unsizedCount).toBe(1);
    });
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

    const { evictedSnapshotNames } = await updateDeviceSnapshotConfig({ maxVmArchiveSizeMb: 1 });

    expect(evictedSnapshotNames).toEqual([]);
    expect(avdSnapshots.getDeleteCalls()).toEqual([]);
    const pending = await repository.getSnapshot("vm-offline");
    expect(pending?.pendingReclaim).toBe(true);
    expect(pending?.pendingReclaimReason).toContain("emulator");
  });

  test("an offline VM count-retention pass schedules only its oldest deferred reclaim", async () => {
    for (const [index, snapshotName] of ["vm-old", "vm-mid", "vm-new"].entries()) {
      const timestamp = new Date(1_000 + index).toISOString();
      avdSnapshots.setVmSnapshot(AVD_NAME, snapshotName, 2 * 1024 * MB);
      await repository.insertSnapshot({
        snapshotName,
        deviceId: EMULATOR.deviceId,
        deviceName: AVD_NAME,
        platform: "android",
        snapshotType: "vm",
        includeAppData: true,
        includeSettings: false,
        createdAt: timestamp,
        lastAccessedAt: timestamp,
        sizeBytes: 2 * 1024 * MB,
        manifest: vmManifest(snapshotName, timestamp),
      });
    }
    avdSnapshots.setLiveEmulator(AVD_NAME, null);

    const { evictedSnapshotNames } = await updateDeviceSnapshotConfig({
      maxVmSnapshotsPerAvd: 2,
    });

    expect(evictedSnapshotNames).toEqual([]);
    expect((await repository.getSnapshot("vm-old"))?.pendingReclaim).toBe(true);
    expect((await repository.getSnapshot("vm-mid"))?.pendingReclaim).not.toBe(true);
    expect((await repository.getSnapshot("vm-new"))?.pendingReclaim).not.toBe(true);
  });

  describe("the reclaim intent is durable across the console delete (#6891 review)", () => {
    // The console delete is the irreversible step: once the emulator accepts it
    // the gigabytes are gone. If the process dies — or the row deletion that
    // follows fails — while the row still reads "not pending", that row keeps
    // being listed and offered for restore with no payload behind it, and the
    // pending sweep cannot repair it because it only ever selects pending rows.
    async function seedLiveVmRow(snapshotName: string): Promise<void> {
      const timestamp = new Date(1000).toISOString();
      avdSnapshots.setVmSnapshot(AVD_NAME, snapshotName, 2 * 1024 * MB);
      await repository.insertSnapshot({
        snapshotName,
        deviceId: EMULATOR.deviceId,
        deviceName: AVD_NAME,
        platform: "android",
        snapshotType: "vm",
        includeAppData: true,
        includeSettings: false,
        createdAt: timestamp,
        lastAccessedAt: timestamp,
        sizeBytes: 2 * 1024 * MB,
        manifest: vmManifest(snapshotName, timestamp),
      });
    }

    test("the row is already flagged pending when the emulator is asked to delete", async () => {
      await seedLiveVmRow("vm-crash");
      let pendingAtDeleteTime: boolean | undefined;
      await setDeviceSnapshotManagerDependencies({
        avdSnapshots: {
          measureVmSnapshotBytes: (avdName: string, snapshotName: string) =>
            avdSnapshots.measureVmSnapshotBytes(avdName, snapshotName),
          listAvdSnapshotDirectories: (avdName: string) =>
            avdSnapshots.listAvdSnapshotDirectories(avdName),
          listKnownAvdNames: () => avdSnapshots.listKnownAvdNames(),
          findLiveEmulatorSerial: (avdName: string) => avdSnapshots.findLiveEmulatorSerial(avdName),
          deleteVmSnapshot: async (deviceId: string, snapshotName: string, timeoutMs: number) => {
            pendingAtDeleteTime = (await repository.getSnapshot(snapshotName))?.pendingReclaim;
            return avdSnapshots.deleteVmSnapshot(deviceId, snapshotName, timeoutMs);
          },
        },
      });

      const { evictedSnapshotNames } = await updateDeviceSnapshotConfig({ maxVmArchiveSizeMb: 1 });

      expect(pendingAtDeleteTime).toBe(true);
      expect(evictedSnapshotNames).toEqual(["vm-crash"]);
      expect(await repository.getSnapshot("vm-crash")).toBeNull();
    });

    test("a row deletion that fails after the payload is gone stays sweepable", async () => {
      await seedLiveVmRow("vm-orphaned-row");
      const failingStore = Object.create(store) as typeof store;
      failingStore.deleteSnapshotData = async () => {
        throw new Error("archive directory is unreadable");
      };
      await setDeviceSnapshotManagerDependencies({ snapshotStore: failingStore as any });

      const { evictedSnapshotNames } = await updateDeviceSnapshotConfig({ maxVmArchiveSizeMb: 1 });

      expect(evictedSnapshotNames).toEqual([]);
      expect(avdSnapshots.hasVmSnapshot(AVD_NAME, "vm-orphaned-row")).toBe(false);
      expect((await repository.getSnapshot("vm-orphaned-row"))?.pendingReclaim).toBe(true);

      // With the store healthy again the sweep finishes what the failure
      // interrupted, instead of leaving a restorable row with no payload.
      await setDeviceSnapshotManagerDependencies({ snapshotStore: store as any });
      await updateDeviceSnapshotConfig({ maxVmArchiveSizeMb: 0 });
      store.queueGeneratedName("vm-after");
      await captureDeviceSnapshot(EMULATOR, {});

      expect(await repository.getSnapshot("vm-orphaned-row")).toBeNull();
    });
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

  describe("a pending reclaim on another AVD survives name reuse (#6490 review)", () => {
    const OTHER_AVD = "am-api34-ga-arm64";
    const OTHER_SERIAL = "emulator-5554";

    async function seedPendingOnOtherAvd(): Promise<void> {
      const timestamp = new Date(1000).toISOString();
      avdSnapshots.setVmSnapshot(OTHER_AVD, "shared", 2 * 1024 * MB);
      await repository.insertSnapshot({
        snapshotName: "shared",
        deviceId: OTHER_SERIAL,
        deviceName: OTHER_AVD,
        platform: "android",
        snapshotType: "vm",
        includeAppData: true,
        includeSettings: false,
        createdAt: timestamp,
        lastAccessedAt: timestamp,
        sizeBytes: 2 * 1024 * MB,
        pendingReclaim: true,
        pendingReclaimReason: "emulator offline",
        manifest: {
          snapshotName: "shared",
          timestamp,
          deviceId: OTHER_SERIAL,
          deviceName: OTHER_AVD,
          platform: "android",
          snapshotType: "vm",
          includeAppData: true,
          includeSettings: false,
        },
      });
    }

    test("the other AVD's payload is reclaimed before the row is overwritten", async () => {
      await seedPendingOnOtherAvd();
      avdSnapshots.setLiveEmulator(OTHER_AVD, OTHER_SERIAL);

      await captureDeviceSnapshot(EMULATOR, { snapshotName: "shared" });

      expect(avdSnapshots.getDeleteCalls()).toEqual([
        { deviceId: OTHER_SERIAL, snapshotName: "shared", timeoutMs: 12000 },
      ]);
      expect(avdSnapshots.hasVmSnapshot(OTHER_AVD, "shared")).toBe(false);
      expect((await repository.getSnapshot("shared"))?.deviceName).toBe(AVD_NAME);
    });

    test("an unreclaimable payload stays visible as an orphan instead of vanishing", async () => {
      await seedPendingOnOtherAvd();
      avdSnapshots.setLiveEmulator(OTHER_AVD, null);

      await captureDeviceSnapshot(EMULATOR, { snapshotName: "shared" });

      expect(avdSnapshots.hasVmSnapshot(OTHER_AVD, "shared")).toBe(true);
      const listed = await listDeviceSnapshots();
      // The entry carries the directory the scanner actually resolved, so the
      // documented manual cleanup targets that path rather than assuming the
      // conventional one (#6891 review).
      expect(listed.orphanedAvdSnapshots.entries).toEqual([
        {
          avdName: OTHER_AVD,
          snapshotName: "shared",
          directoryPath: fakeAvdSnapshotPath(OTHER_AVD, "shared"),
          sizeBytes: 2 * 1024 * MB,
        },
      ]);
    });
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
      maxVmSnapshotsPerAvd: 3,
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
      {
        avdName: OTHER_AVD,
        snapshotName: "shared",
        directoryPath: fakeAvdSnapshotPath(OTHER_AVD, "shared"),
        sizeBytes: 3 * 1024 * MB,
      },
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

describe("reclaim never races a same-name capture (#6490 review)", () => {
  const MB_LOCAL = 1024 * 1024;
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
    avdSnapshots.setLiveEmulator(AVD_NAME, EMULATOR.deviceId);
    await configRepository.setConfig({
      includeAppData: true,
      includeSettings: false,
      useVmSnapshot: true,
      strictBackupMode: false,
      vmSnapshotTimeoutMs: 12000,
      maxVmSnapshotsPerAvd: 3,
      maxArchiveSizeMb: 4096,
    });
    await setDeviceSnapshotManagerDependencies({
      snapshotRepository: repository as any,
      configRepository: configRepository as any,
      snapshotStore: store as any,
      avdSnapshots,
      timer: fakeTimer,
      now: () => new Date(fakeTimer.now()),
      createCaptureProvider: () => ({
        capture: async (args) => {
          const timestamp = new Date(fakeTimer.now() + 5000).toISOString();
          avdSnapshots.setVmSnapshot(AVD_NAME, args.snapshotName, 4 * 1024 * MB_LOCAL);
          return {
            snapshotName: args.snapshotName,
            timestamp,
            snapshotType: "vm" as const,
            manifest: vmManifest(args.snapshotName, timestamp),
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

  async function seed(snapshotName: string, createdAtMs: number): Promise<void> {
    const timestamp = new Date(createdAtMs).toISOString();
    avdSnapshots.setVmSnapshot(AVD_NAME, snapshotName, 2 * 1024 * MB_LOCAL);
    await repository.insertSnapshot({
      snapshotName,
      deviceId: EMULATOR.deviceId,
      deviceName: AVD_NAME,
      platform: "android",
      snapshotType: "vm",
      includeAppData: true,
      includeSettings: false,
      createdAt: timestamp,
      lastAccessedAt: timestamp,
      sizeBytes: 2 * 1024 * MB_LOCAL,
      manifest: vmManifest(snapshotName, timestamp),
    });
  }

  test("eviction leaves alone a snapshot whose capture is still in flight", async () => {
    await seed("vm-inflight", 1000);
    await seed("vm-idle", 2000);

    // Hold the capture open AFTER its payload is saved and its row upserted —
    // the exact window in which eviction could delete the replacement it just
    // wrote while the capture still reports success.
    const replaceSnapshotData = store.replaceSnapshotData.bind(store);
    let releaseCapture = (): void => {};
    const captureGate = new Promise<void>((resolve) => {
      releaseCapture = resolve;
    });
    let captureReachedGate = (): void => {};
    const atGate = new Promise<void>((resolve) => {
      captureReachedGate = resolve;
    });
    (store as any).replaceSnapshotData = async (
      name: string,
      options: unknown,
      capture: () => Promise<unknown>,
    ) => {
      const result = await replaceSnapshotData(name, options, capture);
      captureReachedGate();
      await captureGate;
      return result;
    };

    const capturing = captureDeviceSnapshot(EMULATOR, { snapshotName: "vm-inflight" });
    await atGate;

    const { evictedSnapshotNames } = await updateDeviceSnapshotConfig({ maxVmArchiveSizeMb: 1 });

    releaseCapture();
    await capturing;

    expect(evictedSnapshotNames).toEqual(["vm-idle"]);
    expect(avdSnapshots.getDeleteCalls().map((call) => call.snapshotName)).toEqual(["vm-idle"]);
    const survivor = await repository.getSnapshot("vm-inflight");
    expect(survivor?.sizeBytes).toBe(4 * 1024 * MB_LOCAL);
    expect(avdSnapshots.hasVmSnapshot(AVD_NAME, "vm-inflight")).toBe(true);
  });

  test("eviction leaves alone a snapshot that is being restored", async () => {
    await seed("vm-restoring", 1000);
    await seed("vm-idle", 2000);

    // A restore reads its row, then awaits the provider for as long as the
    // emulator takes to load the VM state. Reclaim must not run inside that
    // window: the in-AVD payload being loaded would be console-deleted and its
    // row dropped while the restore still reports success (#6490 review).
    let releaseRestore = (): void => {};
    const restoreGate = new Promise<void>((resolve) => {
      releaseRestore = resolve;
    });
    let restoreReachedGate = (): void => {};
    const atGate = new Promise<void>((resolve) => {
      restoreReachedGate = resolve;
    });
    await setDeviceSnapshotManagerDependencies({
      createRestoreProvider: () => ({
        restore: async (args) => {
          restoreReachedGate();
          await restoreGate;
          return {
            snapshotType: args.manifest.snapshotType,
            restoredAt: new Date(fakeTimer.now()).toISOString(),
          };
        },
      }),
      deviceIncarnationInvalidator: {
        prepareForIncarnationChange: async () => undefined,
        invalidate: async () => undefined,
      },
    });

    const restoring = restoreDeviceSnapshot(EMULATOR, { snapshotName: "vm-restoring" });
    await atGate;

    const { evictedSnapshotNames } = await updateDeviceSnapshotConfig({ maxVmArchiveSizeMb: 1 });

    releaseRestore();
    await restoring;

    expect(evictedSnapshotNames).toEqual(["vm-idle"]);
    expect(avdSnapshots.getDeleteCalls().map((call) => call.snapshotName)).toEqual(["vm-idle"]);
    expect(await repository.getSnapshot("vm-restoring")).not.toBeNull();
    expect(avdSnapshots.hasVmSnapshot(AVD_NAME, "vm-restoring")).toBe(true);
  });

  test("eviction re-checks that the selected record is still the current one", async () => {
    await seed("vm-superseded", 1000);

    // A capture completes and upserts its replacement AFTER the eviction pass
    // has read its working list: the record in hand is now stale, and acting on
    // it would delete the fresh payload plus the row that describes it.
    const listSnapshots = repository.listSnapshots.bind(repository);
    let superseded = false;
    (repository as any).listSnapshots = async (query: Record<string, unknown> = {}) => {
      const rows = await listSnapshots(query as never);
      if (!superseded && query.orderByLastAccessed === "asc") {
        superseded = true;
        const timestamp = new Date(9000).toISOString();
        avdSnapshots.setVmSnapshot(AVD_NAME, "vm-superseded", 4 * 1024 * MB_LOCAL);
        await repository.insertSnapshot({
          snapshotName: "vm-superseded",
          deviceId: EMULATOR.deviceId,
          deviceName: AVD_NAME,
          platform: "android",
          snapshotType: "vm",
          includeAppData: true,
          includeSettings: false,
          createdAt: new Date(1000).toISOString(),
          lastAccessedAt: timestamp,
          sizeBytes: 4 * 1024 * MB_LOCAL,
          manifest: vmManifest("vm-superseded", timestamp),
        });
      }
      return rows;
    };

    const { evictedSnapshotNames } = await updateDeviceSnapshotConfig({ maxVmArchiveSizeMb: 1 });

    expect(evictedSnapshotNames).toEqual([]);
    expect(avdSnapshots.getDeleteCalls()).toEqual([]);
    const survivor = await repository.getSnapshot("vm-superseded");
    expect(survivor?.sizeBytes).toBe(4 * 1024 * MB_LOCAL);
    expect(avdSnapshots.hasVmSnapshot(AVD_NAME, "vm-superseded")).toBe(true);
  });
});
