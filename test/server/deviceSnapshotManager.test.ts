import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
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
import { FakeAvdSnapshotService } from "../fakes/FakeAvdSnapshotService";
import {
  noOpSnapshotDirectorySync,
  noOpSnapshotFileSync,
} from "../helpers/deviceSnapshotStoreSync";

import { DefaultDeviceIncarnationInvalidator } from "../../src/server/DeviceIncarnationInvalidator";
import { createInstalledAppsDeviceIncarnationListener } from "../../src/server/appResources";
import { PerDeviceInstalledAppsCacheWriteCoordinator } from "../../src/db/installedAppsCacheWriteCoordinator";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { RestoreSnapshot } from "../../src/features/action/RestoreSnapshot";
import { AndroidEmulatorClient } from "../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import { FakeAdbClient } from "../fakes/FakeAdbClient";
import { DaemonState } from "../../src/daemon/daemonState";
import { createDeviceRestoreEpochHarness } from "../helpers/deviceRestoreEpochHarness";

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
      // No real ~/.android/avd scan in a unit test (#6490).
      avdSnapshots: new FakeAvdSnapshotService(),
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
    DaemonState.getInstance().reset();
  });

  test.each(["success", "readiness-failure", "preload-failure", "recovery-failure"] as const)(
    "VM restore epoch boundary: %s",
    async (exit) => {
      const device = { ...TEST_DEVICE, deviceId: "emulator-5554" };
      const { registry } = await createDeviceRestoreEpochHarness(device, fakeTimer);
      const timestamp = new Date(fakeTimer.now()).toISOString();
      const manifest: DeviceSnapshotManifest = {
        snapshotName: "epoch-restore",
        timestamp,
        deviceId: device.deviceId,
        deviceName: device.name,
        platform: "android",
        snapshotType: "vm",
        includeAppData: true,
        includeSettings: true,
      };
      await repository.insertSnapshot({
        ...manifest,
        createdAt: timestamp,
        lastAccessedAt: timestamp,
        sizeBytes: 0,
        manifest,
      });
      const stamped: string[] = [];
      await setDeviceSnapshotManagerDependencies({
        deviceIncarnationInvalidator: new DefaultDeviceIncarnationInvalidator([
          {
            name: "restored-events",
            onDeviceIncarnationChanged: () => {
              stamped.push(registry.getByDeviceId(device.deviceId)!.deviceSessionUuid);
            },
          },
        ]),
        createRestoreProvider: () => ({
          restore: async (args) => {
            if (exit === "preload-failure") {
              throw Object.assign(new Error("load rejected"), {
                isDefinitiveVmSnapshotLoadFailure: true,
              });
            }
            await args.onBeforeVmSnapshotLoad?.();
            await args.onVmSnapshotLoaded?.();
            if (exit === "readiness-failure") {
              throw new Error("readiness failed");
            }
            return { snapshotType: "vm", restoredAt: timestamp };
          },
        }),
      });
      if (exit === "recovery-failure") {
        store.recoverSnapshotData = async () => {
          throw new Error("recovery failed");
        };
      }
      const restoring = restoreDeviceSnapshot(device, {
        snapshotName: manifest.snapshotName,
        useVmSnapshot: true,
      });
      if (exit === "success") {
        expect((await restoring).deviceSessionUuid).toBe("epoch-new");
      } else {
        await expect(restoring).rejects.toThrow(
          exit === "preload-failure"
            ? "load rejected"
            : exit === "recovery-failure"
              ? "recovery failed"
              : "readiness failed",
        );
      }
      const rewound = exit === "success" || exit === "readiness-failure";
      expect(registry.getByDeviceId(device.deviceId)?.deviceSessionUuid).toBe(
        rewound ? "epoch-new" : "epoch-old",
      );
      expect(stamped).toEqual(rewound ? ["epoch-new"] : []);
    },
  );

  test("captureDeviceSnapshot uses defaults, generates name, and evicts old snapshots", async () => {
    const config: DeviceSnapshotConfig = {
      includeAppData: false,
      includeSettings: true,
      useVmSnapshot: true,
      strictBackupMode: false,
      vmSnapshotTimeoutMs: 12000,
      maxVmSnapshotsPerAvd: 3,
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

  test("records a pending reclaim when a dispatched VM save fails", async () => {
    const emulator: BootedDevice = {
      deviceId: "emulator-5554",
      name: "Pixel_8_API_35",
      platform: "android",
    };
    store.queueGeneratedName("orphaned-vm-save");
    await setDeviceSnapshotManagerDependencies({
      createCaptureProvider: () => ({
        capture: async () => {
          const error = new ActionableError("VM snapshot save was cancelled");
          Object.assign(error, { isVmSnapshotSaveDispatched: true });
          throw error;
        },
      }),
    });

    await expect(captureDeviceSnapshot(emulator, { useVmSnapshot: true })).rejects.toThrow(
      /cancelled/i,
    );

    expect(await repository.getSnapshot("orphaned-vm-save")).toMatchObject({
      snapshotName: "orphaned-vm-save",
      deviceId: "emulator-5554",
      deviceName: "Pixel_8_API_35",
      snapshotType: "vm",
      pendingReclaim: true,
    });
  });

  test("re-capturing an existing name replaces it instead of erroring (#5713)", async () => {
    const first = await captureDeviceSnapshot(TEST_DEVICE, {
      snapshotName: "dup",
      includeAppData: true,
    });
    expect(first.result.snapshotName).toBe("dup");

    // A stale on-disk directory (the historical check-then-create rejected this).
    store.setSnapshotExists("dup", true);
    fakeTimer.advanceTime(1000);

    const second = await captureDeviceSnapshot(TEST_DEVICE, {
      snapshotName: "dup",
      includeAppData: false,
    });
    expect(second.result.snapshotName).toBe("dup");

    // Record is replaced, not duplicated, and reflects the second capture.
    const listed = await repository.listSnapshots();
    expect(listed.length).toBe(1);
    const record = await repository.getSnapshot("dup");
    expect(record?.includeAppData).toBe(false);
    // Both captures actually ran (the second was not short-circuited by an error).
    expect(captureCalls.length).toBe(2);
  });

  test("serializes concurrent same-name captures into one consistent snapshot (#5713)", async () => {
    const events: string[] = [];
    const releases: Array<() => void> = [];
    let captureIndex = 0;

    await setDeviceSnapshotManagerDependencies({
      createCaptureProvider: () => ({
        capture: async (args) => {
          const index = captureIndex++;
          events.push(`start:${index}`);
          await new Promise<void>((resolve) => releases.push(resolve));
          events.push(`end:${index}`);
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
          return { snapshotName: args.snapshotName, timestamp, snapshotType: "adb", manifest };
        },
      }),
    });

    // Microtask-only polling — deterministic, no real timers.
    const waitUntil = async (cond: () => boolean): Promise<void> => {
      for (let i = 0; i < 1000 && !cond(); i++) {
        await Promise.resolve();
      }
      if (!cond()) {
        throw new Error(`waitUntil timed out; events=${JSON.stringify(events)}`);
      }
    };

    const p1 = captureDeviceSnapshot(TEST_DEVICE, { snapshotName: "race" });
    const p2 = captureDeviceSnapshot(TEST_DEVICE, { snapshotName: "race" });

    // Only the first capture may be in flight; the second must wait for the lock.
    await waitUntil(() => events.length >= 1);
    expect(events).toEqual(["start:0"]);
    expect(releases.length).toBe(1);

    releases[0]();
    await waitUntil(() => events.length >= 3);
    expect(events.slice(0, 3)).toEqual(["start:0", "end:0", "start:1"]);
    expect(releases.length).toBe(2);

    releases[1]();
    await Promise.all([p1, p2]);

    const listed = await repository.listSnapshots();
    expect(listed.length).toBe(1);
    expect(listed[0]?.snapshotName).toBe("race");
  });

  test("concurrent captures on two devices run one budget eviction, never over-evicting (#6491)", async () => {
    // Two sessions capture DIFFERENT names on DIFFERENT devices. They take
    // different per-NAME capture locks, so both reach the archive-budget
    // eviction phase concurrently. Under the pre-fix code both eviction passes
    // read the same list and the same running total up front, then delete
    // least-recently-accessed first: pass A evicts the over-budget tail while
    // pass B — getting `deleted === false` for every row A already removed —
    // credits itself nothing and keeps walking, deleting snapshots that were
    // never over budget (including a snapshot the other session just captured),
    // emptying the archive. The fix serializes the budget arithmetic on one
    // constant-keyed lock, so the second pass re-reads a fresh, accurate list.
    const MB = 1024 * 1024;
    const maxArchiveSizeMb = 3;
    const maxSizeBytes = maxArchiveSizeMb * MB;

    const config: DeviceSnapshotConfig = {
      includeAppData: true,
      includeSettings: true,
      useVmSnapshot: false,
      strictBackupMode: false,
      vmSnapshotTimeoutMs: 12000,
      maxVmSnapshotsPerAvd: 3,
      maxArchiveSizeMb,
    };
    await configRepository.setConfig(config);

    // Physical-style device ids (not "emulator-...") keep the eviction delete on
    // the simple unscoped path — no AVD-scoped second delete to reason about.
    const deviceA: BootedDevice = { deviceId: "device-a", name: "Device A", platform: "android" };
    const deviceB: BootedDevice = { deviceId: "device-b", name: "Device B", platform: "android" };

    // Three pre-seeded 1 MB snapshots, oldest-accessed first.
    for (const [name, accessedMs] of [
      ["s1", 1000],
      ["s2", 2000],
      ["s3", 3000],
    ] as const) {
      const timestamp = new Date(accessedMs).toISOString();
      const manifest: DeviceSnapshotManifest = {
        snapshotName: name,
        timestamp,
        deviceId: "seed-device",
        deviceName: "Seed Device",
        platform: "android",
        snapshotType: "adb",
        includeAppData: true,
        includeSettings: true,
      };
      await repository.insertSnapshot({
        snapshotName: name,
        deviceId: "seed-device",
        deviceName: "Seed Device",
        platform: "android",
        snapshotType: "adb",
        includeAppData: true,
        includeSettings: true,
        createdAt: timestamp,
        lastAccessedAt: timestamp,
        sizeBytes: 1 * MB,
        manifest,
      });
    }

    // The two new captures are the newest-accessed and 1 MB each. After both
    // insert, the archive holds 5 MB against a 3 MB budget, so a correct single
    // pass evicts exactly the two oldest (s1, s2) and stops.
    fakeTimer.advanceTime(1_000_000);
    store.setSnapshotSize("cap-a", 1 * MB);
    store.setSnapshotSize("cap-b", 1 * MB);

    // A deferred gate per capture: both captures block inside the provider until
    // released, so both are in flight and both reach eviction together.
    const started: string[] = [];
    const releases: Array<() => void> = [];
    await setDeviceSnapshotManagerDependencies({
      createCaptureProvider: () => ({
        capture: async (args) => {
          started.push(args.snapshotName);
          await new Promise<void>((resolve) => releases.push(resolve));
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
          return { snapshotName: args.snapshotName, timestamp, snapshotType: "adb", manifest };
        },
      }),
    });

    // Deterministic microtask-only polling — no real timers.
    const waitUntil = async (cond: () => boolean): Promise<void> => {
      for (let i = 0; i < 1000 && !cond(); i++) {
        await Promise.resolve();
      }
      if (!cond()) {
        throw new Error(`waitUntil timed out; started=${JSON.stringify(started)}`);
      }
    };

    const p1 = captureDeviceSnapshot(deviceA, { snapshotName: "cap-a", includeAppData: true });
    const p2 = captureDeviceSnapshot(deviceB, { snapshotName: "cap-b", includeAppData: true });

    // Both captures are simultaneously in flight (different names => different locks).
    await waitUntil(() => started.length >= 2);
    expect(started.slice().sort()).toEqual(["cap-a", "cap-b"]);

    // Release both; both proceed to insert their record and then evict.
    releases.forEach((release) => release());
    const [r1, r2] = await Promise.all([p1, p2]);

    const survivors = (await repository.listSnapshots()).map((record) => record.snapshotName);
    const survivorNames = new Set(survivors);
    const totalSize = (await repository.listSnapshots()).reduce(
      (sum, record) => sum + record.sizeBytes,
      0,
    );
    const allInitial = ["s1", "s2", "s3", "cap-a", "cap-b"];
    const rowsRemoved = allInitial.filter((name) => !survivorNames.has(name)).sort();
    const evictedUnion = [...r1.evictedSnapshotNames, ...r2.evictedSnapshotNames].sort();

    // Only the over-budget tail (the two oldest) is evicted; nothing beyond it.
    expect(survivorNames).toEqual(new Set(["s3", "cap-a", "cap-b"]));
    // Neither session's freshly-captured snapshot was destroyed by the other pass.
    expect(await repository.getSnapshot("cap-a")).not.toBeNull();
    expect(await repository.getSnapshot("cap-b")).not.toBeNull();
    // The archive ends trimmed to (not below) the budget.
    expect(totalSize).toBe(maxSizeBytes);
    expect(totalSize).toBeLessThanOrEqual(maxSizeBytes);
    // Reported evicted names equal the rows actually removed — no phantoms, no omissions.
    expect(rowsRemoved).toEqual(["s1", "s2"]);
    expect(evictedUnion).toEqual(["s1", "s2"]);
  });

  test.each([
    {
      deviceId: "UDID-A",
      name: "iPhone A",
      platform: "ios" as const,
      options: { platform: "ios" as const, deviceId: "UDID-A" },
    },
    {
      deviceId: "emulator-5554",
      name: "Pixel_A",
      platform: "android" as const,
      options: { platform: "android" as const, avdName: "Pixel_A" },
    },
  ])(
    "restore recovers the record's scoped data before constructing the provider ($platform)",
    async (device) => {
      const timestamp = new Date(fakeTimer.now()).toISOString();
      const manifest: DeviceSnapshotManifest = {
        snapshotName: "recover-before-restore",
        timestamp,
        deviceId: device.deviceId,
        deviceName: device.name,
        platform: device.platform,
        snapshotType: "adb",
        includeAppData: false,
        includeSettings: true,
      };
      await repository.insertSnapshot({
        ...manifest,
        createdAt: timestamp,
        lastAccessedAt: timestamp,
        sizeBytes: 0,
        manifest,
      });
      await setDeviceSnapshotManagerDependencies({
        createRestoreProvider: () => {
          expect(store.recoveryCalls).toEqual([
            { snapshotName: manifest.snapshotName, options: device.options },
          ]);
          return { restore: async () => ({ snapshotType: "adb", restoredAt: timestamp }) };
        },
      });
      await restoreDeviceSnapshot(device, { snapshotName: manifest.snapshotName });
    },
  );

  test("restore rejects recovery failure without constructing the provider", async () => {
    await captureDeviceSnapshot(TEST_DEVICE, { snapshotName: "broken-recovery" });
    store.queueRecoveryFailure(new Error("archive recovery failed"));
    let providerConstructed = false;
    await setDeviceSnapshotManagerDependencies({
      createRestoreProvider: () => {
        providerConstructed = true;
        return {
          restore: async () => ({ snapshotType: "adb", restoredAt: new Date(0).toISOString() }),
        };
      },
    });
    const restoring = restoreDeviceSnapshot(TEST_DEVICE, { snapshotName: "broken-recovery" });
    await expect(restoring).rejects.toBeInstanceOf(ActionableError);
    await expect(restoring).rejects.toThrow(/archive recovery failed/);
    expect(providerConstructed).toBe(false);
    expect(restoreCalls).toEqual([]);
  });

  test.each(["flat", "scoped"])(
    "legacy scan skips a %s capture's in-flight directory",
    async (layout) => {
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "snapshot-manager-inflight-"));
      const gate = Promise.withResolvers<void>();
      const written = Promise.withResolvers<void>();
      let capturing: Promise<unknown> | undefined;
      try {
        const realStore = new DeviceSnapshotStore(
          tempRoot,
          noOpSnapshotDirectorySync,
          noOpSnapshotFileSync,
        );
        const device =
          layout === "flat"
            ? TEST_DEVICE
            : { ...TEST_DEVICE, deviceId: "emulator-5554", name: "Pixel_A" };
        const options =
          layout === "flat" ? undefined : { platform: "android" as const, avdName: device.name };
        const orphanDir = realStore.getSnapshotPathWithOptions("unlocked-orphan", options);
        await fs.mkdir(orphanDir, { recursive: true });
        await fs.writeFile(path.join(orphanDir, "settings.json"), "{}");
        await setDeviceSnapshotManagerDependencies({
          snapshotStore: realStore,
          createCaptureProvider: () => ({
            capture: async (args) => {
              const captureDir = realStore.getSnapshotPathWithOptions(args.snapshotName, options);
              await fs.mkdir(captureDir, { recursive: true });
              await fs.writeFile(path.join(captureDir, "settings.json"), "{}");
              written.resolve();
              await gate.promise;
              throw new Error("capture failed after settings write");
            },
          }),
        });
        capturing = captureDeviceSnapshot(device, {
          snapshotName: "inflight-new",
          useVmSnapshot: false,
        });
        await written.promise;
        const { snapshots } = await listDeviceSnapshots();
        const imported = await repository.getSnapshot("inflight-new");
        gate.resolve();
        await expect(capturing).rejects.toThrow("capture failed after settings write");
        expect(imported).toBeNull();
        expect(snapshots.map((record) => record.snapshotName)).toEqual(["unlocked-orphan"]);
        expect(await realStore.snapshotDirectoryExists("inflight-new", options)).toBe(false);
        await listDeviceSnapshots();
        expect(await repository.getSnapshot("inflight-new")).toBeNull();
        expect(await repository.getSnapshot("unlocked-orphan")).not.toBeNull();
      } finally {
        gate.resolve();
        // allSettled consumes the intentionally failed capture before removing its temp archive.
        if (capturing) {
          await Promise.allSettled([capturing]);
        }
        await fs.rm(tempRoot, { recursive: true, force: true });
      }
    },
  );

  test.each([
    {
      platform: "ios" as const,
      oldId: "UDID-A",
      newId: "UDID-B",
      oldName: "iPhone A",
      newName: "iPhone B",
      expectedDeletes: [{ platform: "ios" as const, deviceId: "UDID-A" }],
    },
    {
      platform: "android" as const,
      oldId: "emulator-5554",
      newId: "emulator-5556",
      oldName: "Pixel_A",
      newName: "Pixel_B",
      expectedDeletes: [{ platform: "android" as const, avdName: "Pixel_A" }, undefined],
    },
    {
      platform: "android" as const,
      oldId: "emulator-5554",
      newId: "physical-b",
      oldName: "Pixel_A",
      newName: "Phone B",
      expectedDeletes: [{ platform: "android" as const, avdName: "Pixel_A" }],
    },
  ])(
    "successful cross-device overwrite retires only prior archive paths ($oldId -> $newId)",
    async (scenario) => {
      const prior: BootedDevice = {
        platform: scenario.platform,
        deviceId: scenario.oldId,
        name: scenario.oldName,
      };
      const current: BootedDevice = {
        platform: scenario.platform,
        deviceId: scenario.newId,
        name: scenario.newName,
      };
      await setDeviceSnapshotManagerDependencies({
        createCaptureProvider: (device) => ({
          capture: async (args) => {
            const timestamp = new Date(fakeTimer.now()).toISOString();
            const manifest: DeviceSnapshotManifest = {
              snapshotName: args.snapshotName,
              timestamp,
              deviceId: device.deviceId,
              deviceName: device.name,
              platform: device.platform,
              snapshotType: "adb",
              includeAppData: false,
              includeSettings: true,
            };
            return { snapshotName: args.snapshotName, timestamp, snapshotType: "adb", manifest };
          },
        }),
      });
      await captureDeviceSnapshot(prior, { snapshotName: "cross-device", useVmSnapshot: false });
      const priorRecord = await repository.getSnapshot("cross-device");
      await setDeviceSnapshotManagerDependencies({
        createCaptureProvider: () => ({
          capture: async () => {
            throw new Error("replacement failed");
          },
        }),
      });
      await expect(
        captureDeviceSnapshot(current, { snapshotName: "cross-device", useVmSnapshot: false }),
      ).rejects.toThrow("replacement failed");
      expect(store.deleteCalls).toEqual([]);
      expect(await repository.getSnapshot("cross-device")).toEqual(priorRecord);
      expect(await store.snapshotDirectoryExists("cross-device")).toBe(true);

      await setDeviceSnapshotManagerDependencies({
        createCaptureProvider: (device) => ({
          capture: async (args) => {
            const timestamp = new Date(fakeTimer.now()).toISOString();
            const manifest: DeviceSnapshotManifest = {
              snapshotName: args.snapshotName,
              timestamp,
              deviceId: device.deviceId,
              deviceName: device.name,
              platform: device.platform,
              snapshotType: "adb",
              includeAppData: false,
              includeSettings: true,
            };
            return { snapshotName: args.snapshotName, timestamp, snapshotType: "adb", manifest };
          },
        }),
      });
      await captureDeviceSnapshot(current, { snapshotName: "cross-device", useVmSnapshot: false });
      expect(store.deleteCalls).toEqual(
        scenario.expectedDeletes.map((options) => ({ snapshotName: "cross-device", options })),
      );
      expect((await repository.getSnapshot("cross-device"))?.deviceId).toBe(current.deviceId);
      expect(await store.snapshotDirectoryExists("cross-device")).toBe(true);
      const deletionCount = store.deleteCalls.length;
      await captureDeviceSnapshot(current, { snapshotName: "cross-device", useVmSnapshot: false });
      expect(store.deleteCalls).toHaveLength(deletionCount);
      expect(await store.snapshotDirectoryExists("cross-device")).toBe(true);
    },
  );

  test("archive retirement failure leaves the successful replacement usable", async () => {
    const timestamp = new Date(fakeTimer.now()).toISOString();
    const manifest: DeviceSnapshotManifest = {
      snapshotName: "retirement-failure",
      timestamp,
      deviceId: "UDID-A",
      deviceName: "iPhone A",
      platform: "ios",
      snapshotType: "app_data",
      includeAppData: true,
      includeSettings: false,
    };
    await repository.insertSnapshot({
      ...manifest,
      createdAt: timestamp,
      lastAccessedAt: timestamp,
      sizeBytes: 0,
      manifest,
    });
    const deletion = spyOn(store, "deleteSnapshotData").mockRejectedValueOnce(
      new Error("retirement denied"),
    );
    try {
      const { result } = await captureDeviceSnapshot(TEST_DEVICE, {
        snapshotName: manifest.snapshotName,
      });
      expect(result.snapshotName).toBe(manifest.snapshotName);
      expect(deletion).toHaveBeenCalledWith(manifest.snapshotName, {
        platform: "ios",
        deviceId: "UDID-A",
      });
      expect((await repository.getSnapshot(manifest.snapshotName))?.deviceId).toBe(
        TEST_DEVICE.deviceId,
      );
      expect(await store.snapshotDirectoryExists(manifest.snapshotName)).toBe(true);
      await restoreDeviceSnapshot(TEST_DEVICE, { snapshotName: manifest.snapshotName });
      expect(restoreCalls).toHaveLength(1);
    } finally {
      deletion.mockRestore();
    }
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

  test("restoreDeviceSnapshot rejects a snapshot owned by another device", async () => {
    const timestamp = new Date(0).toISOString();
    const manifest: DeviceSnapshotManifest = {
      snapshotName: "foreign-snapshot",
      timestamp,
      deviceId: "other-device",
      deviceName: "Other Device",
      platform: "android",
      snapshotType: "adb",
      includeAppData: false,
      includeSettings: true,
    };
    await repository.insertSnapshot({
      snapshotName: manifest.snapshotName,
      deviceId: manifest.deviceId,
      deviceName: manifest.deviceName,
      platform: manifest.platform,
      snapshotType: manifest.snapshotType,
      includeAppData: manifest.includeAppData,
      includeSettings: manifest.includeSettings,
      createdAt: timestamp,
      lastAccessedAt: timestamp,
      sizeBytes: 0,
      manifest,
    });

    await expect(
      restoreDeviceSnapshot(TEST_DEVICE, { snapshotName: manifest.snapshotName }),
    ).rejects.toThrow(
      /belongs to android device 'Other Device' \(other-device\).*capture a snapshot/i,
    );
    expect(restoreCalls).toEqual([]);
  });

  test("restoreDeviceSnapshot accepts an emulator using the same AVD name", async () => {
    const timestamp = new Date(0).toISOString();
    const manifest: DeviceSnapshotManifest = {
      snapshotName: "avd-snapshot",
      timestamp,
      deviceId: "emulator-5554",
      deviceName: "Pixel_7",
      platform: "android",
      snapshotType: "adb",
      includeAppData: false,
      includeSettings: true,
    };
    await repository.insertSnapshot({
      snapshotName: manifest.snapshotName,
      deviceId: manifest.deviceId,
      deviceName: manifest.deviceName,
      platform: manifest.platform,
      snapshotType: manifest.snapshotType,
      includeAppData: manifest.includeAppData,
      includeSettings: manifest.includeSettings,
      createdAt: timestamp,
      lastAccessedAt: timestamp,
      sizeBytes: 0,
      manifest,
    });
    const restartedEmulator: BootedDevice = {
      deviceId: "emulator-5556",
      name: "Pixel_7",
      platform: "android",
    };

    await restoreDeviceSnapshot(restartedEmulator, { snapshotName: manifest.snapshotName });

    expect(restoreCalls).toHaveLength(1);
    expect(restoreCalls[0]?.manifest).toEqual(manifest);
  });

  async function seedVmRestore() {
    const device = { ...TEST_DEVICE, deviceId: "emulator-5554", name: "Pixel_9_Pro" };
    const manifest: DeviceSnapshotManifest = {
      snapshotName: "settlement-vm",
      timestamp: new Date(0).toISOString(),
      deviceId: device.deviceId,
      deviceName: device.name,
      platform: "android",
      snapshotType: "vm",
      includeAppData: true,
      includeSettings: false,
    };
    await repository.insertSnapshot({
      ...manifest,
      createdAt: manifest.timestamp,
      lastAccessedAt: manifest.timestamp,
      sizeBytes: 0,
      manifest,
    });
    return { device, manifest };
  }

  test.each(["success", "pre-load", "load", "readiness", "prepare"])(
    "settles exactly once after preparation on %s exit",
    async (exit) => {
      const { device, manifest } = await seedVmRestore();
      const outcomes: { ready: boolean }[] = [];
      await setDeviceSnapshotManagerDependencies({
        deviceIncarnationInvalidator: {
          prepareForIncarnationChange: async () => {
            if (exit === "prepare") {
              throw new Error("prepare failed");
            }
          },
          invalidate: async () => {},
          settleIncarnationChange: async (settledDevice, outcome) => {
            expect(settledDevice).toBe(device);
            outcomes.push(outcome);
          },
        },
        createRestoreProvider: () => ({
          restore: async (args) => {
            await args.onBeforeVmSnapshotLoad?.();
            await args.onBeforeVmSnapshotLoad?.();
            if (exit === "pre-load") {
              throw Object.assign(new Error("pre-load failed"), {
                isDefinitiveVmSnapshotLoadFailure: true,
              });
            }
            if (exit === "load") {
              throw new Error("load failed");
            }
            await args.onVmSnapshotLoaded?.();
            if (exit === "readiness") {
              throw new Error("readiness failed");
            }
            return { snapshotType: manifest.snapshotType, restoredAt: manifest.timestamp };
          },
        }),
      });
      const restore = restoreDeviceSnapshot(device, { snapshotName: manifest.snapshotName });
      if (exit === "success") {
        await restore;
      } else {
        await expect(restore).rejects.toThrow(`${exit} failed`);
      }
      expect(outcomes).toEqual([{ ready: exit === "success" }]);
    },
  );

  test.each([true, false])(
    "installed-app notifications wait for real restore readiness (ready=%s)",
    async (ready) => {
      const { device, manifest } = await seedVmRestore();
      const apps = new FakeInstalledAppsRepository();
      await apps.seedInstalledApp(device.deviceId, 0, "com.example.app", false, 123);
      const barrier = new FakeDbWriteBarrier();
      let invalidations = 0;
      let notifications = 0;
      const listener = createInstalledAppsDeviceIncarnationListener(
        apps,
        new PerDeviceInstalledAppsCacheWriteCoordinator(() => barrier),
        barrier,
        () => {
          invalidations++;
        },
        async () => {
          notifications++;
        },
      );
      let release!: (device: BootedDevice) => void;
      let reject!: (error: Error) => void;
      const readiness = new Promise<BootedDevice>((resolve, fail) => {
        release = resolve;
        reject = fail;
      });
      let entered!: () => void;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      class DeferredEmulator extends AndroidEmulatorClient {
        override async waitForEmulatorReady(): Promise<BootedDevice> {
          entered();
          return readiness;
        }
      }
      const adb = new FakeAdbClient();
      adb.setCommandResult(`emu avd snapshot load ${manifest.snapshotName}`, "OK");
      const emulator = new DeferredEmulator(null, null, fakeTimer, { create: () => adb });
      await setDeviceSnapshotManagerDependencies({
        deviceIncarnationInvalidator: new DefaultDeviceIncarnationInvalidator([listener]),
        createRestoreProvider: () =>
          new RestoreSnapshot(
            device,
            { create: () => adb },
            emulator,
            fakeTimer,
            new DeviceSnapshotStore(path.join(os.tmpdir(), "settlement-test-unused")),
          ),
      });
      const restore = restoreDeviceSnapshot(device, { snapshotName: manifest.snapshotName });
      // Attach rejection handling before rejecting the deferred readiness promise.
      const completion = restore.then(
        () => undefined,
        (error: unknown) => error,
      );
      await waiting;
      try {
        expect(invalidations).toBe(1);
        expect(await apps.getCacheVerifiedAt(device.deviceId)).toBe(0);
        expect(notifications).toBe(0);
      } finally {
        // Always settle the deferred guest, even when the pending-state assertion fails.
        if (ready) {
          release(device);
        } else {
          reject(new Error("readiness failed"));
        }
        const failure = await completion;
        if (ready) {
          expect(failure).toBeUndefined();
        } else {
          expect(failure).toBeInstanceOf(ActionableError);
        }
      }
      expect(notifications).toBe(ready ? 1 : 0);
    },
  );

  test("restoreDeviceSnapshot invalidates an Android VM device incarnation after restore", async () => {
    const vmDevice: BootedDevice = {
      ...TEST_DEVICE,
      deviceId: "emulator-5554",
      name: "Pixel_9_Pro",
    };
    const manifest: DeviceSnapshotManifest = {
      snapshotName: "vm-restore",
      timestamp: new Date(0).toISOString(),
      deviceId: vmDevice.deviceId,
      deviceName: vmDevice.name,
      platform: "android",
      snapshotType: "vm",
      includeAppData: true,
      includeSettings: false,
    };
    const calls: string[] = [];

    await repository.insertSnapshot({
      snapshotName: manifest.snapshotName,
      deviceId: manifest.deviceId,
      deviceName: manifest.deviceName,
      platform: manifest.platform,
      snapshotType: manifest.snapshotType,
      includeAppData: manifest.includeAppData,
      includeSettings: manifest.includeSettings,
      createdAt: manifest.timestamp,
      lastAccessedAt: manifest.timestamp,
      sizeBytes: 0,
      manifest,
    });
    await setDeviceSnapshotManagerDependencies({
      createRestoreProvider: () => ({
        restore: async (args) => {
          await args.onBeforeVmSnapshotLoad?.();
          calls.push("restore");
          return { snapshotType: args.manifest.snapshotType, restoredAt: manifest.timestamp };
        },
      }),
      deviceIncarnationInvalidator: {
        settleIncarnationChange: async () => {},
        prepareForIncarnationChange: async () => {
          calls.push("prepare");
        },
        invalidate: async (invalidatedDevice) => {
          expect(invalidatedDevice).toBe(vmDevice);
          calls.push("invalidate");
        },
      },
    });

    await restoreDeviceSnapshot(vmDevice, { snapshotName: manifest.snapshotName });

    expect(calls).toEqual(["prepare", "restore", "invalidate"]);
  });

  test("restoreDeviceSnapshot invalidates after VM load when readiness fails", async () => {
    const vmDevice: BootedDevice = {
      ...TEST_DEVICE,
      deviceId: "emulator-5554",
      name: "Pixel_9_Pro",
    };
    const manifest: DeviceSnapshotManifest = {
      snapshotName: "vm-readiness-failure",
      timestamp: new Date(0).toISOString(),
      deviceId: vmDevice.deviceId,
      deviceName: vmDevice.name,
      platform: "android",
      snapshotType: "vm",
      includeAppData: true,
      includeSettings: false,
    };
    const calls: string[] = [];

    await repository.insertSnapshot({
      snapshotName: manifest.snapshotName,
      deviceId: manifest.deviceId,
      deviceName: manifest.deviceName,
      platform: manifest.platform,
      snapshotType: manifest.snapshotType,
      includeAppData: manifest.includeAppData,
      includeSettings: manifest.includeSettings,
      createdAt: manifest.timestamp,
      lastAccessedAt: manifest.timestamp,
      sizeBytes: 0,
      manifest,
    });
    await setDeviceSnapshotManagerDependencies({
      createRestoreProvider: () => ({
        restore: async (args) => {
          calls.push("restore");
          await args.onVmSnapshotLoaded?.();
          throw new Error("emulator readiness failed");
        },
      }),
      deviceIncarnationInvalidator: {
        settleIncarnationChange: async () => {},
        prepareForIncarnationChange: async () => {},
        invalidate: async (invalidatedDevice) => {
          expect(invalidatedDevice).toBe(vmDevice);
          calls.push("invalidate");
        },
      },
    });

    await expect(
      restoreDeviceSnapshot(vmDevice, { snapshotName: manifest.snapshotName, useVmSnapshot: true }),
    ).rejects.toThrow("emulator readiness failed");

    expect(calls).toEqual(["restore", "invalidate"]);
  });

  test("restoreDeviceSnapshot retains the live incarnation after a definitive pre-load rejection", async () => {
    const vmDevice: BootedDevice = {
      ...TEST_DEVICE,
      deviceId: "emulator-5554",
      name: "Pixel_9_Pro",
    };
    const manifest: DeviceSnapshotManifest = {
      snapshotName: "vm-definitive-rejection",
      timestamp: new Date(0).toISOString(),
      deviceId: vmDevice.deviceId,
      deviceName: vmDevice.name,
      platform: "android",
      snapshotType: "vm",
      includeAppData: true,
      includeSettings: false,
    };
    let invalidations = 0;
    const rejection = Object.assign(new Error("console rejected load"), {
      isDefinitiveVmSnapshotLoadFailure: true,
    });

    await repository.insertSnapshot({
      snapshotName: manifest.snapshotName,
      deviceId: manifest.deviceId,
      deviceName: manifest.deviceName,
      platform: manifest.platform,
      snapshotType: manifest.snapshotType,
      includeAppData: manifest.includeAppData,
      includeSettings: manifest.includeSettings,
      createdAt: manifest.timestamp,
      lastAccessedAt: manifest.timestamp,
      sizeBytes: 0,
      manifest,
    });
    await setDeviceSnapshotManagerDependencies({
      createRestoreProvider: () => ({
        restore: async () => {
          throw rejection;
        },
      }),
      deviceIncarnationInvalidator: {
        settleIncarnationChange: async () => {},
        prepareForIncarnationChange: async () => {},
        invalidate: async () => {
          invalidations++;
        },
      },
    });

    await expect(
      restoreDeviceSnapshot(vmDevice, { snapshotName: manifest.snapshotName, useVmSnapshot: true }),
    ).rejects.toThrow(rejection.message);

    expect(invalidations).toBe(0);
  });

  test("restoreDeviceSnapshot does not invalidate a settings-only Android restore", async () => {
    const manifest: DeviceSnapshotManifest = {
      snapshotName: "settings-restore",
      timestamp: new Date(0).toISOString(),
      deviceId: TEST_DEVICE.deviceId,
      deviceName: TEST_DEVICE.name,
      platform: "android",
      snapshotType: "adb",
      includeAppData: false,
      includeSettings: true,
    };
    let invalidated = false;

    await repository.insertSnapshot({
      snapshotName: manifest.snapshotName,
      deviceId: manifest.deviceId,
      deviceName: manifest.deviceName,
      platform: manifest.platform,
      snapshotType: manifest.snapshotType,
      includeAppData: manifest.includeAppData,
      includeSettings: manifest.includeSettings,
      createdAt: manifest.timestamp,
      lastAccessedAt: manifest.timestamp,
      sizeBytes: 0,
      manifest,
    });
    await setDeviceSnapshotManagerDependencies({
      deviceIncarnationInvalidator: {
        settleIncarnationChange: async () => {},
        prepareForIncarnationChange: async () => {},
        invalidate: async () => {
          invalidated = true;
        },
      },
    });

    await restoreDeviceSnapshot(TEST_DEVICE, { snapshotName: manifest.snapshotName });

    expect(invalidated).toBe(false);
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

    const iosDevice: BootedDevice = { ...TEST_DEVICE, platform: "ios" };
    const { manifest: returnedManifest } = await restoreDeviceSnapshot(iosDevice, {
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
      const legacyStore = new DeviceSnapshotStore(
        tempRoot,
        noOpSnapshotDirectorySync,
        noOpSnapshotFileSync,
      );
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
      const legacyStore = new DeviceSnapshotStore(
        tempRoot,
        noOpSnapshotDirectorySync,
        noOpSnapshotFileSync,
      );
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
      maxVmSnapshotsPerAvd: 3,
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
      const realStore = new DeviceSnapshotStore(
        tempRoot,
        noOpSnapshotDirectorySync,
        noOpSnapshotFileSync,
      );
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
      const realStore = new DeviceSnapshotStore(
        tempRoot,
        noOpSnapshotDirectorySync,
        noOpSnapshotFileSync,
      );
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

  test("evicting an iOS snapshot preserves an unrelated legacy flat Android snapshot (#5746)", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "snapshot-manager-ios-evict-"));
    try {
      const realStore = new DeviceSnapshotStore(
        tempRoot,
        noOpSnapshotDirectorySync,
        noOpSnapshotFileSync,
      );
      await realStore.ensureSnapshotsDirectory();
      await setDeviceSnapshotManagerDependencies({ snapshotStore: realStore });

      const snapshotName = "shared-name";
      const iosDeviceId = "ios-simulator-udid";
      const iosOptions = { platform: "ios" as const, deviceId: iosDeviceId };
      const flatDir = realStore.getSnapshotPath(snapshotName);
      const scopedDir = realStore.getSnapshotPathWithOptions(snapshotName, iosOptions);
      await fs.mkdir(flatDir, { recursive: true });
      await fs.writeFile(path.join(flatDir, "android-settings.json"), "legacy Android data");
      await fs.mkdir(scopedDir, { recursive: true });
      await fs.writeFile(path.join(scopedDir, "settings.json"), "{}");

      const timestamp = new Date(fakeTimer.now()).toISOString();
      const manifest: DeviceSnapshotManifest = {
        snapshotName,
        timestamp,
        deviceId: iosDeviceId,
        deviceName: "iPhone 16",
        platform: "ios",
        snapshotType: "adb",
        includeAppData: false,
        includeSettings: true,
      };
      await repository.insertSnapshot({
        snapshotName,
        deviceId: iosDeviceId,
        deviceName: "iPhone 16",
        platform: "ios",
        snapshotType: "adb",
        includeAppData: false,
        includeSettings: true,
        createdAt: timestamp,
        lastAccessedAt: timestamp,
        sizeBytes: 5 * 1024 * 1024,
        manifest,
      });

      await updateDeviceSnapshotConfig({ maxArchiveSizeMb: 1 });

      expect(await realStore.snapshotDirectoryExists(snapshotName, iosOptions)).toBe(false);
      expect(await repository.getSnapshot(snapshotName)).toBeNull();
      expect(await realStore.snapshotDirectoryExists(snapshotName)).toBe(true);
      expect(await fs.readFile(path.join(flatDir, "android-settings.json"), "utf8")).toBe(
        "legacy Android data",
      );
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

  test("captureDeviceSnapshot rejects a path-traversal name before capturing (#5705)", async () => {
    for (const badName of ["../traversal_x", "a/b", "/etc/passwd"]) {
      await expect(captureDeviceSnapshot(TEST_DEVICE, { snapshotName: badName })).rejects.toThrow(
        /invalid snapshot name/i,
      );
    }
    // The capture provider must never be invoked for an unsafe name.
    expect(captureCalls).toEqual([]);
  });

  test("restoreDeviceSnapshot rejects a path-traversal name before lookup (#5705)", async () => {
    for (const badName of ["../traversal_x", "a/b", "/etc/passwd"]) {
      await expect(restoreDeviceSnapshot(TEST_DEVICE, { snapshotName: badName })).rejects.toThrow(
        /invalid snapshot name/i,
      );
    }
    expect(restoreCalls).toEqual([]);
  });

  test("captureDeviceSnapshot rejects a name ending in the reserved '.replacing' suffix (#5713)", async () => {
    // The atomic overwrite uses a sibling `<name>.replacing` dir; a snapshot
    // literally named `<x>.replacing` would let one capture's set-aside path
    // collide with — and delete — this real snapshot's directory.
    for (const snapshotName of [
      "foo.replacing",
      "foo.REPLACING",
      "foo.Journal.Replacing",
      "Android",
      "IOS",
    ]) {
      await expect(captureDeviceSnapshot(TEST_DEVICE, { snapshotName })).rejects.toThrow(
        /reserved/i,
      );
      expect(captureCalls).toEqual([]);
    }
    // The capture provider must never run for a rejected name.
    expect(captureCalls).toEqual([]);
  });

  for (const snapshotName of ["foo.journal", "foo.tmp", "a.journal.b"]) {
    test(`captureDeviceSnapshot accepts ordinary name ${snapshotName}`, async () => {
      const { result } = await captureDeviceSnapshot(TEST_DEVICE, { snapshotName });
      expect(result.snapshotName).toBe(snapshotName);
      expect(captureCalls).toHaveLength(1);
      expect(await repository.getSnapshot(snapshotName)).not.toBeNull();
    });
  }

  for (const snapshotName of ["Foo.REPLACING", "Android"]) {
    test(`existing reserved name ${snapshotName} remains restorable and deletable`, async () => {
      const timestamp = new Date(fakeTimer.now()).toISOString();
      const manifest: DeviceSnapshotManifest = {
        snapshotName,
        timestamp,
        deviceId: TEST_DEVICE.deviceId,
        deviceName: TEST_DEVICE.name,
        platform: TEST_DEVICE.platform,
        snapshotType: "adb",
        includeAppData: true,
        includeSettings: true,
      };
      await repository.insertSnapshot({
        ...manifest,
        createdAt: timestamp,
        lastAccessedAt: timestamp,
        sizeBytes: 2 * 1024 * 1024,
        manifest,
      });
      store.setSnapshotExists(snapshotName, true);
      store.setSnapshotSize(snapshotName, 2 * 1024 * 1024);

      const restored = await restoreDeviceSnapshot(TEST_DEVICE, { snapshotName });
      expect(restored.manifest).toEqual(manifest);
      expect(restoreCalls).toHaveLength(1);
      expect((await listDeviceSnapshots()).snapshots).toEqual([
        expect.objectContaining({ snapshotName }),
      ]);

      const { evictedSnapshotNames } = await updateDeviceSnapshotConfig({ maxArchiveSizeMb: 1 });
      expect(evictedSnapshotNames).toContain(snapshotName);
      expect(await repository.getSnapshot(snapshotName)).toBeNull();
      expect(store.getDeletedSnapshots()).toContain(snapshotName);
      expect(await store.snapshotDirectoryExists(snapshotName)).toBe(false);
    });
  }

  test("FakeDeviceSnapshotStore distinguishes an explicit unknown size from an absent size", async () => {
    store.setSnapshotSize("unknown", null);

    expect(await store.getSnapshotSizeBytes("unknown")).toBeNull();
    expect(await store.getSnapshotSizeBytes("never-set")).toBe(0);
  });

  test("listDeviceSnapshots skips a leftover '.replacing' set-aside directory (#5713)", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "snapshot-manager-replacing-"));
    try {
      const realStore = new DeviceSnapshotStore(
        tempRoot,
        noOpSnapshotDirectorySync,
        noOpSnapshotFileSync,
      );
      await realStore.ensureSnapshotsDirectory();
      await setDeviceSnapshotManagerDependencies({ snapshotStore: realStore as any });

      // A leftover set-aside dir from an interrupted overwrite: it holds the
      // prior snapshot's manifest.json at the flat base level. Importing it would
      // resurrect a phantom snapshot named "ghost.replacing" over stale data.
      const asideDir = path.join(tempRoot, "ghost.replacing");
      await fs.mkdir(asideDir, { recursive: true });
      const manifest: DeviceSnapshotManifest = {
        snapshotName: "ghost",
        timestamp: new Date(0).toISOString(),
        deviceId: "emulator-5554",
        deviceName: "Pixel_5",
        platform: "android",
        snapshotType: "adb",
        includeAppData: false,
        includeSettings: true,
      };
      await fs.writeFile(path.join(asideDir, "manifest.json"), JSON.stringify(manifest));

      const { snapshots } = await listDeviceSnapshots();
      expect(snapshots.some((entry) => entry.snapshotName === "ghost.replacing")).toBe(false);
      expect(await repository.getSnapshot("ghost.replacing")).toBeNull();
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("legacy flat-path cleanup never deletes a reserved scope root (#5707)", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "snapshot-manager-reserved-"));
    try {
      const realStore = new DeviceSnapshotStore(
        tempRoot,
        noOpSnapshotDirectorySync,
        noOpSnapshotFileSync,
      );
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

  describe("scoped on-disk settings/metadata read-back (#6492)", () => {
    test("listDeviceSnapshots discovers an AVD-scoped Android metadata.json with no DB row", async () => {
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "snapshot-manager-scoped-meta-"));
      try {
        const realStore = new DeviceSnapshotStore(
          tempRoot,
          noOpSnapshotDirectorySync,
          noOpSnapshotFileSync,
        );
        await realStore.ensureSnapshotsDirectory();
        await setDeviceSnapshotManagerDependencies({ snapshotStore: realStore as any });

        const snapshotName = "baseline";
        const androidOptions = { platform: "android" as const, avdName: "Pixel_7" };
        const scopedDir = realStore.getSnapshotPathWithOptions(snapshotName, androidOptions);
        await fs.mkdir(scopedDir, { recursive: true });

        const timestamp = new Date(fakeTimer.now()).toISOString();
        const manifest: DeviceSnapshotManifest = {
          snapshotName,
          timestamp,
          deviceId: "emulator-5554",
          deviceName: "Pixel_7",
          platform: "android",
          snapshotType: "adb",
          includeAppData: false,
          includeSettings: true,
          settings: { global: { foo: "bar" } },
        };
        await fs.writeFile(
          realStore.getMetadataPath(snapshotName, androidOptions),
          JSON.stringify(manifest, null, 2),
        );

        // No DB row exists for this snapshot yet — it lives only on disk.
        expect(await repository.getSnapshot(snapshotName)).toBeNull();

        const { snapshots, count, totalSizeBytes } = await listDeviceSnapshots();

        expect(count).toBe(1);
        expect(snapshots[0]?.snapshotName).toBe(snapshotName);
        expect(totalSizeBytes).toBeGreaterThan(0);

        const record = await repository.getSnapshot(snapshotName);
        expect(record).not.toBeNull();
        expect(record?.manifest.settings).toEqual(manifest.settings);
      } finally {
        await fs.rm(tempRoot, { recursive: true, force: true });
      }
    });

    test("restoreDeviceSnapshot hydrates an AVD-scoped metadata.json snapshot directly, with no prior listDeviceSnapshots call", async () => {
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "snapshot-manager-scoped-restore-"));
      try {
        const realStore = new DeviceSnapshotStore(
          tempRoot,
          noOpSnapshotDirectorySync,
          noOpSnapshotFileSync,
        );
        await realStore.ensureSnapshotsDirectory();
        await setDeviceSnapshotManagerDependencies({ snapshotStore: realStore as any });

        const snapshotName = "baseline";
        const androidOptions = { platform: "android" as const, avdName: "Pixel_7" };
        const scopedDir = realStore.getSnapshotPathWithOptions(snapshotName, androidOptions);
        await fs.mkdir(scopedDir, { recursive: true });

        const timestamp = new Date(fakeTimer.now()).toISOString();
        const manifest: DeviceSnapshotManifest = {
          snapshotName,
          timestamp,
          deviceId: "emulator-5554",
          deviceName: "Pixel_7",
          platform: "android",
          snapshotType: "adb",
          includeAppData: false,
          includeSettings: true,
          settings: { global: { foo: "bar" } },
        };
        await fs.writeFile(
          realStore.getMetadataPath(snapshotName, androidOptions),
          JSON.stringify(manifest, null, 2),
        );

        expect(await repository.getSnapshot(snapshotName)).toBeNull();

        // No listDeviceSnapshots() call first — restore must find it on its own.
        const matchingAvd: BootedDevice = {
          deviceId: "emulator-5556",
          name: "Pixel_7",
          platform: "android",
        };
        const { result, manifest: returnedManifest } = await restoreDeviceSnapshot(matchingAvd, {
          snapshotName,
        });

        expect(result.snapshotType).toBe("adb");
        expect(returnedManifest.settings).toEqual(manifest.settings);
        expect(restoreCalls[0]?.manifest.settings).toEqual(manifest.settings);
      } finally {
        await fs.rm(tempRoot, { recursive: true, force: true });
      }
    });

    test("restoreDeviceSnapshot round-trips a settings-only Android capture's settings.json when the DB row is absent", async () => {
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "snapshot-manager-settings-only-"));
      try {
        const realStore = new DeviceSnapshotStore(
          tempRoot,
          noOpSnapshotDirectorySync,
          noOpSnapshotFileSync,
        );
        await realStore.ensureSnapshotsDirectory();
        await setDeviceSnapshotManagerDependencies({ snapshotStore: realStore as any });

        const snapshotName = "settings-baseline";
        const androidOptions = { platform: "android" as const, avdName: "Pixel_7" };
        const scopedDir = realStore.getSnapshotPathWithOptions(snapshotName, androidOptions);
        await fs.mkdir(scopedDir, { recursive: true });

        // This is exactly what CaptureSnapshot.saveSettings writes: the raw
        // settings triplet, NOT a full manifest — no metadata.json/manifest.json
        // exists anywhere for this snapshot (mirrors the real non-VM Android
        // settings-only capture path).
        const settings = {
          global: { some_global_setting: "1" },
          secure: { some_secure_setting: "on" },
          system: { some_system_setting: "off" },
        };
        await fs.writeFile(
          realStore.getSettingsPath(snapshotName, androidOptions),
          JSON.stringify(settings, null, 2),
        );

        expect(await repository.getSnapshot(snapshotName)).toBeNull();

        const matchingAvd: BootedDevice = {
          deviceId: "emulator-5556",
          name: "Pixel_7",
          platform: "android",
        };
        const { result, manifest } = await restoreDeviceSnapshot(matchingAvd, {
          snapshotName,
        });

        expect(result.snapshotType).toBe("adb");
        expect(manifest.platform).toBe("android");
        expect(manifest.includeSettings).toBe(true);
        expect(manifest.settings).toEqual(settings);
        expect(restoreCalls[0]?.manifest.settings).toEqual(settings);
      } finally {
        await fs.rm(tempRoot, { recursive: true, force: true });
      }
    });

    test("listDeviceSnapshots skips a '.replacing' set-aside directory nested under android/<avd>/", async () => {
      const tempRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), "snapshot-manager-scoped-replacing-"),
      );
      try {
        const realStore = new DeviceSnapshotStore(
          tempRoot,
          noOpSnapshotDirectorySync,
          noOpSnapshotFileSync,
        );
        await realStore.ensureSnapshotsDirectory();
        await setDeviceSnapshotManagerDependencies({ snapshotStore: realStore as any });

        const androidOptions = { platform: "android" as const, avdName: "Pixel_5" };
        const asideDir = realStore.getSnapshotPathWithOptions("ghost.replacing", androidOptions);
        await fs.mkdir(asideDir, { recursive: true });

        const manifest: DeviceSnapshotManifest = {
          snapshotName: "ghost",
          timestamp: new Date(0).toISOString(),
          deviceId: "emulator-5554",
          deviceName: "Pixel_5",
          platform: "android",
          snapshotType: "adb",
          includeAppData: false,
          includeSettings: true,
        };
        await fs.writeFile(path.join(asideDir, "metadata.json"), JSON.stringify(manifest));

        const { snapshots } = await listDeviceSnapshots();

        expect(snapshots.some((entry) => entry.snapshotName === "ghost.replacing")).toBe(false);
        expect(await repository.getSnapshot("ghost.replacing")).toBeNull();
      } finally {
        await fs.rm(tempRoot, { recursive: true, force: true });
      }
    });

    test("listDeviceSnapshots degrades a malformed scoped metadata.json to a skip, without throwing", async () => {
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "snapshot-manager-scoped-bad-"));
      try {
        const realStore = new DeviceSnapshotStore(
          tempRoot,
          noOpSnapshotDirectorySync,
          noOpSnapshotFileSync,
        );
        await realStore.ensureSnapshotsDirectory();
        await setDeviceSnapshotManagerDependencies({ snapshotStore: realStore as any });

        const snapshotName = "corrupt";
        const androidOptions = { platform: "android" as const, avdName: "Pixel_5" };
        const scopedDir = realStore.getSnapshotPathWithOptions(snapshotName, androidOptions);
        await fs.mkdir(scopedDir, { recursive: true });
        await fs.writeFile(
          realStore.getMetadataPath(snapshotName, androidOptions),
          "{ not valid json",
        );

        const { snapshots, count } = await listDeviceSnapshots();

        expect(count).toBe(0);
        expect(snapshots).toEqual([]);
        expect(await repository.getSnapshot(snapshotName)).toBeNull();
      } finally {
        await fs.rm(tempRoot, { recursive: true, force: true });
      }
    });
  });
});
