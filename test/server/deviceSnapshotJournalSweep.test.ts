import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import type { BootedDevice, DeviceSnapshotManifest } from "../../src/models";
import type {
  DeviceSnapshotRecord,
  DeviceSnapshotRepository,
} from "../../src/db/deviceSnapshotRepository";
import { DeviceSnapshotStore, type SnapshotPathOptions } from "../../src/utils/DeviceSnapshotStore";
import { logger } from "../../src/utils/logger";
import { sortedReaddir } from "../../src/utils/io";
import {
  captureDeviceSnapshot,
  listDeviceSnapshots,
  resetDeviceSnapshotManagerDependencies,
  restoreDeviceSnapshot,
  runSnapshotJournalSweep,
  setDeviceSnapshotManagerDependencies,
  sweepPendingVmSnapshotReclaims,
  updateDeviceSnapshotConfig,
  STARTUP_SWEEP_DELAY_MS,
  SNAPSHOT_JOURNAL_SWEEP_MAX_ENTRIES,
  SNAPSHOT_JOURNAL_SWEEP_MAX_SCOPE_DIRECTORIES,
} from "../../src/server/deviceSnapshotManager";
import { FakeDeviceSnapshotRepository } from "../fakes/FakeDeviceSnapshotRepository";
import { FakeDeviceSnapshotConfigRepository } from "../fakes/FakeDeviceSnapshotConfigRepository";
import { FakeDeviceSnapshotStore } from "../fakes/FakeDeviceSnapshotStore";
import { FakeAvdSnapshotService } from "../fakes/FakeAvdSnapshotService";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  noOpSnapshotDirectorySync,
  noOpSnapshotFileSync,
} from "../helpers/deviceSnapshotStoreSync";

const DEVICE: BootedDevice = { platform: "android", deviceId: "physical", name: "Phone" };
const EMULATOR: BootedDevice = { platform: "android", deviceId: "emulator-5554", name: "Pixel" };
const ANDROID_OPTIONS: SnapshotPathOptions = { platform: "android", avdName: "Pixel" };
const IOS_OPTIONS: SnapshotPathOptions = { platform: "ios", deviceId: "UDID" };
const STATES = [
  "pending-existing",
  "pending-new",
  "committed",
  "temp",
  "legacy",
  "legacy-with-dest",
] as const;
type CrashState = (typeof STATES)[number];

function record(snapshotName: string, device = DEVICE): DeviceSnapshotRecord {
  const timestamp = new Date(0).toISOString();
  const manifest: DeviceSnapshotManifest = {
    snapshotName,
    timestamp,
    deviceId: device.deviceId,
    deviceName: device.name,
    platform: device.platform,
    snapshotType: "adb",
    includeAppData: true,
    includeSettings: true,
  };
  return {
    ...manifest,
    createdAt: timestamp,
    lastAccessedAt: timestamp,
    sizeBytes: 2 * 1024 * 1024,
    manifest,
  };
}

describe("snapshot recovery-aware deletion and startup sweep", () => {
  let root: string;
  let realStore: DeviceSnapshotStore;
  let fakeStore: FakeDeviceSnapshotStore;
  let repository: FakeDeviceSnapshotRepository;
  let configRepository: FakeDeviceSnapshotConfigRepository;
  let avdSnapshots: FakeAvdSnapshotService;
  let timer: FakeTimer;

  beforeEach(async () => {
    resetDeviceSnapshotManagerDependencies();
    root = await fs.mkdtemp(path.join(os.tmpdir(), "snapshot-journal-manager-"));
    realStore = new DeviceSnapshotStore(root, noOpSnapshotDirectorySync, noOpSnapshotFileSync);
    fakeStore = new FakeDeviceSnapshotStore(root);
    repository = new FakeDeviceSnapshotRepository();
    configRepository = new FakeDeviceSnapshotConfigRepository();
    avdSnapshots = new FakeAvdSnapshotService();
    timer = new FakeTimer();
    await setDeviceSnapshotManagerDependencies({
      snapshotRepository: repository as DeviceSnapshotRepository,
      configRepository,
      snapshotStore: realStore,
      avdSnapshots,
      timer,
      now: () => new Date(timer.now()),
      createCaptureProvider: (device) => ({
        capture: async (args) => {
          const manifest = record(args.snapshotName, device).manifest;
          return {
            snapshotName: args.snapshotName,
            timestamp: manifest.timestamp,
            snapshotType: "adb",
            manifest,
          };
        },
      }),
      createRestoreProvider: () => ({
        restore: async (args) => ({
          snapshotType: args.manifest.snapshotType,
          restoredAt: new Date(timer.now()).toISOString(),
        }),
      }),
    });
  });

  afterEach(async () => {
    resetDeviceSnapshotManagerDependencies();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function data(directory: string, contents: string): Promise<void> {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "payload"), contents);
  }

  async function crash(
    name: string,
    state: CrashState,
    options?: SnapshotPathOptions,
  ): Promise<string> {
    const destination = realStore.getSnapshotPathWithOptions(name, options);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    if (state !== "legacy") {
      await data(destination, "new");
    }
    if (["pending-existing", "committed", "legacy", "legacy-with-dest"].includes(state)) {
      await data(`${destination}.replacing`, "old");
    }
    if (state === "temp") {
      await fs.writeFile(`${destination}.journal.tmp.replacing`, "pending-new");
    } else if (state !== "legacy" && state !== "legacy-with-dest") {
      await fs.writeFile(`${destination}.journal.replacing`, state);
    }
    return destination;
  }

  async function expectRemoved(destination: string): Promise<void> {
    const entries = await fs.readdir(path.dirname(destination));
    for (const suffix of ["", ".replacing", ".journal.replacing", ".journal.tmp.replacing"]) {
      expect(entries).not.toContain(`${path.basename(destination)}${suffix}`);
    }
  }

  for (const state of STATES) {
    test(`eviction removes archive, row and all artifacts after ${state}`, async () => {
      const destination = await crash("evicted", state);
      await repository.insertSnapshot(record("evicted"));
      const result = await updateDeviceSnapshotConfig({ maxArchiveSizeMb: 1 });
      expect(result.evictedSnapshotNames).toEqual(["evicted"]);
      expect(await repository.getSnapshot("evicted")).toBeNull();
      await expectRemoved(destination);
    });

    test(`eviction recovers Android scoped and legacy flat artifacts after ${state}`, async () => {
      const scoped = await crash("evicted", state, ANDROID_OPTIONS);
      const flat = await crash("evicted", state);
      await repository.insertSnapshot(record("evicted", EMULATOR));
      expect(
        (await updateDeviceSnapshotConfig({ maxArchiveSizeMb: 1 })).evictedSnapshotNames,
      ).toEqual(["evicted"]);
      expect(await repository.getSnapshot("evicted")).toBeNull();
      await expectRemoved(scoped);
      await expectRemoved(flat);
    });

    test(`pending VM reclaim removes scoped and flat artifacts after ${state}`, async () => {
      const scoped = await crash("pending", state, ANDROID_OPTIONS);
      const flat = await crash("pending", state);
      const pending = record("pending", EMULATOR);
      pending.snapshotType = "vm";
      pending.manifest.snapshotType = "vm";
      pending.pendingReclaim = true;
      await repository.insertSnapshot(pending);
      avdSnapshots.setLiveEmulator(EMULATOR.name, EMULATOR.deviceId);
      avdSnapshots.setVmSnapshot(EMULATOR.name, "pending", 2);
      expect(await sweepPendingVmSnapshotReclaims(EMULATOR)).toEqual(["pending"]);
      expect(avdSnapshots.getDeleteCalls()).toHaveLength(1);
      expect(await repository.getSnapshot("pending")).toBeNull();
      await expectRemoved(scoped);
      await expectRemoved(flat);
    });

    test(`startup sweep recovers ${state} without a DB row and is idempotent`, async () => {
      const destination = await crash("recover", state, IOS_OPTIONS);
      expect(await runSnapshotJournalSweep()).toEqual({
        recovered: 1,
        failed: 0,
        skippedLocked: 0,
        truncated: false,
      });
      if (state === "pending-new") {
        await expectRemoved(destination);
      } else {
        const expected = state === "pending-existing" || state === "legacy" ? "old" : "new";
        expect(await fs.readFile(path.join(destination, "payload"), "utf8")).toBe(expected);
        expect(await fs.readdir(path.dirname(destination))).toEqual(["recover"]);
      }
      expect(await repository.listSnapshots()).toEqual([]);
      expect(await runSnapshotJournalSweep()).toEqual({
        recovered: 0,
        failed: 0,
        skippedLocked: 0,
        truncated: false,
      });
    });
  }

  test("invalid journal does not block eviction and discarded artifacts are warned with the error", async () => {
    const destination = await crash("invalid", "pending-existing");
    await fs.writeFile(`${destination}.journal.replacing`, "invalid state");
    await fs.writeFile(`${destination}.journal.tmp.replacing`, "partial journal");
    await repository.insertSnapshot(record("invalid"));
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(
        (await updateDeviceSnapshotConfig({ maxArchiveSizeMb: 1 })).evictedSnapshotNames,
      ).toEqual(["invalid"]);
      expect(await repository.getSnapshot("invalid")).toBeNull();
      await expectRemoved(destination);
      expect(
        warning.mock.calls.some(
          ([message, error]) =>
            String(message).includes("Recovery before deletion failed") && error instanceof Error,
        ),
      ).toBe(true);
    } finally {
      warning.mockRestore();
    }
  });

  test("failed artifact removal warns with exactly the leftover path and still deletes the row", async () => {
    const destination = await crash("invalid", "pending-existing");
    await fs.writeFile(`${destination}.journal.replacing`, "invalid");
    await repository.insertSnapshot(record("invalid"));
    const leftover = `${destination}.replacing`;
    const remove = fs.rm.bind(fs);
    const failure = new Error("permission denied");
    const rm = spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (target === leftover) {
        throw failure;
      }
      return remove(target, options);
    });
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(
        (await updateDeviceSnapshotConfig({ maxArchiveSizeMb: 1 })).evictedSnapshotNames,
      ).toEqual(["invalid"]);
      expect(await repository.getSnapshot("invalid")).toBeNull();
      expect(await fs.readdir(root)).toEqual(["invalid.replacing"]);
      expect(
        warning.mock.calls.some(
          ([message]) =>
            message ===
            `[DeviceSnapshot] Snapshot artifacts left behind after deletion: ${leftover}`,
        ),
      ).toBe(true);
      expect(warning.mock.calls.some(([, error]) => error === failure)).toBe(true);
    } finally {
      rm.mockRestore();
      warning.mockRestore();
    }
  });

  test("fake recovery failure discards that scope, continues legacy recovery and removes the record", async () => {
    await setDeviceSnapshotManagerDependencies({ snapshotStore: fakeStore as DeviceSnapshotStore });
    const failure = new Error("queued recovery failure");
    fakeStore.queueRecoveryFailure(failure);
    fakeStore.queueDiscardLeftovers(["/leftover/aside"]);
    await repository.insertSnapshot(record("evicted", EMULATOR));
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await updateDeviceSnapshotConfig({ maxArchiveSizeMb: 1 });
      expect(fakeStore.recoveryCalls).toEqual([
        { snapshotName: "evicted", options: ANDROID_OPTIONS },
        { snapshotName: "evicted", options: undefined },
      ]);
      expect(fakeStore.discardCalls).toEqual([
        { snapshotName: "evicted", options: ANDROID_OPTIONS },
      ]);
      expect(fakeStore.getDeletedSnapshots()).toEqual(["evicted"]);
      expect(await repository.getSnapshot("evicted")).toBeNull();
      expect(warning.mock.calls.some(([, error]) => error === failure)).toBe(true);
      expect(
        warning.mock.calls.some(([message]) => String(message).endsWith("/leftover/aside")),
      ).toBe(true);
    } finally {
      warning.mockRestore();
    }
  });

  test("reserved Android scoped name never recovers or discards the flat scope root", async () => {
    await setDeviceSnapshotManagerDependencies({ snapshotStore: fakeStore as DeviceSnapshotStore });
    await repository.insertSnapshot(record("android", EMULATOR));
    await updateDeviceSnapshotConfig({ maxArchiveSizeMb: 1 });
    expect(fakeStore.recoveryCalls).toEqual([
      { snapshotName: "android", options: ANDROID_OPTIONS },
    ]);
  });

  test("invalid journal fails only its entry; the next snapshot is recovered", async () => {
    const invalid = await crash("a-invalid", "pending-existing");
    await fs.writeFile(`${invalid}.journal.replacing`, "invalid");
    const good = await crash("b-good", "committed");
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(await runSnapshotJournalSweep()).toEqual({
        recovered: 1,
        failed: 1,
        skippedLocked: 0,
        truncated: false,
      });
      expect(await fs.readFile(`${invalid}.journal.replacing`, "utf8")).toBe("invalid");
      expect(await fs.readFile(path.join(good, "payload"), "utf8")).toBe("new");
      expect(await fs.readdir(root)).not.toContain("b-good.replacing");
      expect(
        warning.mock.calls.some(
          ([message, error]) => String(message).includes("a-invalid") && error instanceof Error,
        ),
      ).toBe(true);
    } finally {
      warning.mockRestore();
    }
  });

  test("clean real and fake stores do no recovery, writes or logs above debug", async () => {
    const recover = spyOn(realStore, "recoverSnapshotData");
    const mkdir = spyOn(fs, "mkdir");
    const warning = spyOn(logger, "warn");
    const info = spyOn(logger, "info");
    try {
      expect((await runSnapshotJournalSweep()).recovered).toBe(0);
      expect(recover).not.toHaveBeenCalled();
      expect(mkdir).not.toHaveBeenCalled();
      expect(await fs.readdir(root)).toEqual([]);
      await setDeviceSnapshotManagerDependencies({
        snapshotStore: fakeStore as DeviceSnapshotStore,
      });
      expect((await runSnapshotJournalSweep()).recovered).toBe(0);
      expect(fakeStore.recoveryCalls).toEqual([]);
      expect(warning).not.toHaveBeenCalled();
      expect(info).not.toHaveBeenCalled();
    } finally {
      recover.mockRestore();
      mkdir.mockRestore();
      warning.mockRestore();
      info.mockRestore();
    }
  });

  test("startup sweep skips scoped artifacts while a restore holds the name lock", async () => {
    const destination = await crash("locked", "pending-existing");
    // Restore recovers its flat archive first; a same-name scoped journal still
    // exercises the sweep's name lock while the provider is restoring.
    const scopedDestination = await crash("locked", "pending-existing", ANDROID_OPTIONS);
    await repository.insertSnapshot(record("locked"));
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await setDeviceSnapshotManagerDependencies({
      createRestoreProvider: () => ({
        restore: async () => {
          started.resolve();
          await release.promise;
          return { snapshotType: "adb", restoredAt: new Date(0).toISOString() };
        },
      }),
    });
    const restoring = restoreDeviceSnapshot(DEVICE, {
      snapshotName: "locked",
      useVmSnapshot: false,
    });
    await started.promise;
    try {
      expect(await fs.readFile(path.join(destination, "payload"), "utf8")).toBe("old");
      expect(await sortedReaddir(root)).toEqual(["android", "locked"]);
      expect(await runSnapshotJournalSweep()).toEqual({
        recovered: 0,
        failed: 0,
        skippedLocked: 1,
        truncated: false,
      });
      expect(await fs.readFile(path.join(scopedDestination, "payload"), "utf8")).toBe("new");
      expect(await fs.readFile(`${scopedDestination}.journal.replacing`, "utf8")).toBe(
        "pending-existing",
      );
      expect(
        await fs.readFile(path.join(`${scopedDestination}.replacing`, "payload"), "utf8"),
      ).toBe("old");
    } finally {
      release.resolve();
      await restoring;
    }
  });

  test("fake sweep skips a capture holding the name lock without waiting and recovers idle entries", async () => {
    await setDeviceSnapshotManagerDependencies({ snapshotStore: fakeStore as DeviceSnapshotStore });
    fakeStore.leftoverJournalEntries = [
      { snapshotName: "locked" },
      { snapshotName: "idle", options: IOS_OPTIONS },
    ];
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await setDeviceSnapshotManagerDependencies({
      createCaptureProvider: () => ({
        capture: async () => {
          started.resolve();
          await release.promise;
          const manifest = record("locked").manifest;
          return {
            snapshotName: "locked",
            timestamp: manifest.timestamp,
            snapshotType: "adb",
            manifest,
          };
        },
      }),
    });
    const capturing = captureDeviceSnapshot(DEVICE, {
      snapshotName: "locked",
      useVmSnapshot: false,
    });
    await started.promise;
    try {
      expect(await runSnapshotJournalSweep()).toEqual({
        recovered: 1,
        failed: 0,
        skippedLocked: 1,
        truncated: false,
      });
      expect(fakeStore.recoveryCalls).toEqual([{ snapshotName: "idle", options: IOS_OPTIONS }]);
    } finally {
      release.resolve();
      await capturing;
    }
  });

  for (const firstEntryPoint of ["list", "capture", "restore", "config"] as const) {
    test(`${firstEntryPoint} schedules once; all entry points return before the deferred enumeration`, async () => {
      await setDeviceSnapshotManagerDependencies({
        snapshotStore: fakeStore as DeviceSnapshotStore,
      });
      fakeStore.leftoverJournalEntries = [{ snapshotName: "leftover" }];
      const enumerate = spyOn(fakeStore, "listLeftoverSnapshotJournals");
      const scheduled = spyOn(timer, "sleep");
      const swept = Promise.withResolvers<void>();
      const recover = spyOn(fakeStore, "recoverSnapshotData").mockImplementation(
        async (snapshotName) => {
          if (snapshotName === "leftover") {
            swept.resolve();
          }
        },
      );
      await repository.insertSnapshot({ ...record("saved"), sizeBytes: 0 });
      const calls = {
        list: () => listDeviceSnapshots(),
        capture: () =>
          captureDeviceSnapshot(DEVICE, { snapshotName: "captured", useVmSnapshot: false }),
        restore: () =>
          restoreDeviceSnapshot(DEVICE, { snapshotName: "saved", useVmSnapshot: false }),
        config: () => updateDeviceSnapshotConfig({ maxArchiveSizeMb: 10 }),
      };
      try {
        expect(scheduled).not.toHaveBeenCalled();
        expect(enumerate).not.toHaveBeenCalled();
        await calls[firstEntryPoint]();
        for (let pass = 0; pass < 2; pass++) {
          for (const entryPoint of Object.values(calls)) {
            await entryPoint();
          }
        }
        expect(scheduled.mock.calls.map(([delay]) => delay)).toEqual([STARTUP_SWEEP_DELAY_MS]);
        expect(timer.getPendingSleeps()).toEqual([STARTUP_SWEEP_DELAY_MS]);
        expect(timer.getPendingSleepCount()).toBe(1);
        expect(enumerate).not.toHaveBeenCalled();
        const lazyRecoveryCount = recover.mock.calls.length;
        expect(recover.mock.calls.some(([snapshotName]) => snapshotName === "leftover")).toBe(
          false,
        );
        await timer.advanceTimeAsync(STARTUP_SWEEP_DELAY_MS - 1);
        expect(enumerate).not.toHaveBeenCalled();
        expect(recover).toHaveBeenCalledTimes(lazyRecoveryCount);
        await timer.advanceTimeAsync(1);
        await swept.promise;
        expect(recover).toHaveBeenCalledTimes(lazyRecoveryCount + 1);
        expect(recover).toHaveBeenLastCalledWith("leftover", undefined);
        expect(timer.getPendingSleepCount()).toBe(0);
        expect(fakeStore.journalListCalls).toEqual([
          {
            maxEntries: SNAPSHOT_JOURNAL_SWEEP_MAX_ENTRIES,
            maxScopeDirectories: SNAPSHOT_JOURNAL_SWEEP_MAX_SCOPE_DIRECTORIES,
          },
        ]);
        await timer.advanceTimeAsync(STARTUP_SWEEP_DELAY_MS);
        expect(enumerate).toHaveBeenCalledTimes(1);
        expect(recover).toHaveBeenCalledTimes(lazyRecoveryCount + 1);
      } finally {
        recover.mockRestore();
        scheduled.mockRestore();
        enumerate.mockRestore();
      }
    });
  }

  test("a sleep scheduled before reset does not sweep after resolving; the next generation schedules once", async () => {
    await setDeviceSnapshotManagerDependencies({ snapshotStore: fakeStore as DeviceSnapshotStore });
    fakeStore.leftoverJournalEntries = [{ snapshotName: "leftover" }];
    await listDeviceSnapshots();
    expect(timer.getPendingSleeps()).toEqual([STARTUP_SWEEP_DELAY_MS]);
    expect(timer.getPendingSleepCount()).toBe(1);
    resetDeviceSnapshotManagerDependencies();
    expect(timer.getPendingSleeps()).toEqual([STARTUP_SWEEP_DELAY_MS]);
    await setDeviceSnapshotManagerDependencies({
      snapshotRepository: repository as DeviceSnapshotRepository,
      configRepository,
      snapshotStore: fakeStore as DeviceSnapshotStore,
      timer,
      avdSnapshots,
    });
    await timer.advanceTimeAsync(STARTUP_SWEEP_DELAY_MS);
    expect(timer.getPendingSleepCount()).toBe(0);
    expect(fakeStore.journalListCalls).toEqual([]);
    expect(fakeStore.recoveryCalls).toEqual([]);
    await updateDeviceSnapshotConfig({ maxArchiveSizeMb: 10 });
    await listDeviceSnapshots();
    expect(timer.getPendingSleeps()).toEqual([STARTUP_SWEEP_DELAY_MS]);
    expect(timer.getPendingSleepCount()).toBe(1);
    await timer.advanceTimeAsync(STARTUP_SWEEP_DELAY_MS);
    expect(fakeStore.journalListCalls).toHaveLength(1);
    expect(fakeStore.recoveryCalls).toEqual([{ snapshotName: "leftover", options: undefined }]);
  });

  test("a pre-reset sleep cannot sweep the new dependencies while their own sleep is pending", async () => {
    await setDeviceSnapshotManagerDependencies({ snapshotStore: fakeStore as DeviceSnapshotStore });
    await listDeviceSnapshots();
    expect(timer.getPendingSleeps()).toEqual([STARTUP_SWEEP_DELAY_MS]);
    resetDeviceSnapshotManagerDependencies();

    const nextTimer = new FakeTimer();
    const nextStore = new FakeDeviceSnapshotStore(root);
    nextStore.leftoverJournalEntries = [{ snapshotName: "next-generation" }];
    await setDeviceSnapshotManagerDependencies({
      snapshotRepository: repository as DeviceSnapshotRepository,
      configRepository,
      snapshotStore: nextStore as DeviceSnapshotStore,
      timer: nextTimer,
      avdSnapshots,
      now: () => new Date(nextTimer.now()),
    });
    await listDeviceSnapshots();
    expect(nextTimer.getPendingSleeps()).toEqual([STARTUP_SWEEP_DELAY_MS]);
    expect(nextTimer.getPendingSleepCount()).toBe(1);

    await timer.advanceTimeAsync(STARTUP_SWEEP_DELAY_MS);
    expect(fakeStore.journalListCalls).toEqual([]);
    expect(nextStore.journalListCalls).toEqual([]);
    expect(nextStore.recoveryCalls).toEqual([]);
    expect(nextTimer.getPendingSleepCount()).toBe(1);

    await nextTimer.advanceTimeAsync(STARTUP_SWEEP_DELAY_MS);
    expect(nextStore.journalListCalls).toHaveLength(1);
    expect(nextStore.recoveryCalls).toEqual([
      { snapshotName: "next-generation", options: undefined },
    ]);
  });

  test("scheduled sleep rejection is caught and warned without running the sweep", async () => {
    await setDeviceSnapshotManagerDependencies({ snapshotStore: fakeStore as DeviceSnapshotStore });
    const failure = new Error("sleep failed");
    const delay = Promise.withResolvers<void>();
    const sleep = spyOn(timer, "sleep").mockReturnValue(delay.promise);
    const warned = Promise.withResolvers<void>();
    const warning = spyOn(logger, "warn").mockImplementation(() => {
      warned.resolve();
    });
    try {
      await listDeviceSnapshots();
      expect(sleep).toHaveBeenCalledTimes(1);
      expect(sleep).toHaveBeenCalledWith(STARTUP_SWEEP_DELAY_MS);
      delay.reject(failure);
      await warned.promise;
      expect(warning).toHaveBeenCalledWith(
        "[DeviceSnapshot] Startup snapshot journal sweep delay failed",
        failure,
      );
      expect(fakeStore.journalListCalls).toEqual([]);
      expect(fakeStore.recoveryCalls).toEqual([]);
    } finally {
      sleep.mockRestore();
      warning.mockRestore();
    }
  });

  test("scheduled enumeration failure is caught and logged without failing the caller", async () => {
    await setDeviceSnapshotManagerDependencies({ snapshotStore: fakeStore as DeviceSnapshotStore });
    const failure = new Error("enumeration failed");
    const enumerate = spyOn(fakeStore, "listLeftoverSnapshotJournals").mockRejectedValue(failure);
    const warned = Promise.withResolvers<void>();
    const warning = spyOn(logger, "warn").mockImplementation(() => {
      warned.resolve();
    });
    try {
      await updateDeviceSnapshotConfig({ maxArchiveSizeMb: 10 });
      expect(enumerate).not.toHaveBeenCalled();
      await timer.advanceTimeAsync(STARTUP_SWEEP_DELAY_MS);
      await warned.promise;
      expect(warning).toHaveBeenCalledWith(
        "[DeviceSnapshot] Startup snapshot journal sweep failed",
        failure,
      );
    } finally {
      enumerate.mockRestore();
      warning.mockRestore();
    }
  });

  test("fake recovery failure is counted and does not stop later entries", async () => {
    await setDeviceSnapshotManagerDependencies({ snapshotStore: fakeStore as DeviceSnapshotStore });
    fakeStore.leftoverJournalEntries = [{ snapshotName: "bad" }, { snapshotName: "good" }];
    const failure = new Error("recovery failed");
    fakeStore.queueRecoveryFailure(failure);
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(await runSnapshotJournalSweep()).toEqual({
        recovered: 1,
        failed: 1,
        skippedLocked: 0,
        truncated: false,
      });
      expect(fakeStore.recoveryCalls.map(({ snapshotName }) => snapshotName)).toEqual([
        "bad",
        "good",
      ]);
      expect(warning.mock.calls.some(([, error]) => error === failure)).toBe(true);
    } finally {
      warning.mockRestore();
    }
  });

  describe("with one more leftover journal than the sweep cap", () => {
    // Writing the leftover journals is arrangement; keep its file IO out of the test's time.
    beforeEach(async () => {
      await Promise.all(
        Array.from({ length: SNAPSHOT_JOURNAL_SWEEP_MAX_ENTRIES + 1 }, (_, index) =>
          fs.writeFile(
            path.join(root, `save-${String(index).padStart(3, "0")}.journal.tmp.replacing`),
            "pending-new",
          ),
        ),
      );
    });

    test("real sweep processes only the entry cap and leaves the remainder for lazy recovery", async () => {
      const warning = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        expect(await runSnapshotJournalSweep()).toEqual({
          recovered: SNAPSHOT_JOURNAL_SWEEP_MAX_ENTRIES,
          failed: 0,
          skippedLocked: 0,
          truncated: true,
        });
        expect(await fs.readdir(root)).toEqual([
          `save-${String(SNAPSHOT_JOURNAL_SWEEP_MAX_ENTRIES).padStart(3, "0")}.journal.tmp.replacing`,
        ]);
        expect(
          warning.mock.calls.some(([message]) => String(message).includes("lazy recovery")),
        ).toBe(true);
      } finally {
        warning.mockRestore();
      }
    });
  });
});
