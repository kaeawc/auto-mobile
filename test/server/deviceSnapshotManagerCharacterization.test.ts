import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { promises as fs, type Dirent } from "fs";
import { ActionableError, type DeviceSnapshotManifest } from "../../src/models";
import {
  captureDeviceSnapshot,
  listDeviceSnapshots,
  resetDeviceSnapshotManagerDependencies,
  setDeviceSnapshotManagerDependencies,
} from "../../src/server/deviceSnapshotManager";
import type { DeviceSnapshotRepository } from "../../src/db/deviceSnapshotRepository";
import type { DeviceSnapshotStore } from "../../src/utils/DeviceSnapshotStore";
import { FakeDeviceSnapshotRepository } from "../fakes/FakeDeviceSnapshotRepository";
import { FakeDeviceSnapshotConfigRepository } from "../fakes/FakeDeviceSnapshotConfigRepository";
import { FakeDeviceSnapshotStore } from "../fakes/FakeDeviceSnapshotStore";
import { FakeAvdSnapshotService } from "../fakes/FakeAvdSnapshotService";
import { FakeTimer } from "../fakes/FakeTimer";
import { logger } from "../../src/utils/logger";

let repository: FakeDeviceSnapshotRepository;
let store: FakeDeviceSnapshotStore;
let avd: FakeAvdSnapshotService;
beforeEach(async () => {
  repository = new FakeDeviceSnapshotRepository();
  store = new FakeDeviceSnapshotStore("/characterization-snapshots");
  avd = new FakeAvdSnapshotService();
  const timer = new FakeTimer();
  await setDeviceSnapshotManagerDependencies({
    snapshotRepository: repository as unknown as DeviceSnapshotRepository,
    snapshotStore: store as unknown as DeviceSnapshotStore,
    configRepository: new FakeDeviceSnapshotConfigRepository(),
    avdSnapshots: avd,
    timer,
    now: () => new Date(timer.now()),
    deviceIncarnationInvalidator: {
      prepareForIncarnationChange: async () => undefined,
      settleIncarnationChange: async () => {},
      invalidate: async () => undefined,
    },
  });
});
afterEach(() => {
  resetDeviceSnapshotManagerDependencies();
});

test("a failed orphan measurement still records the capture settings and original failure", async () => {
  const events: string[] = [];
  const failure = Object.assign(new ActionableError("save failed"), {
    isVmSnapshotSaveDispatched: true,
  });
  const measure = spyOn(avd, "measureVmSnapshotBytes").mockImplementation(async () => {
    events.push("measure");
    throw new Error("size unavailable");
  });
  const insert = repository.insertSnapshot.bind(repository);
  const write = spyOn(repository, "insertSnapshot").mockImplementation(async (record) => {
    events.push("insert");
    return insert(record);
  });
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  await setDeviceSnapshotManagerDependencies({
    createCaptureProvider: () => ({
      capture: async () => {
        events.push("capture");
        throw failure;
      },
    }),
  });
  try {
    await expect(
      captureDeviceSnapshot(
        { name: "Pixel", platform: "android", deviceId: "emulator-5554" },
        { snapshotName: "failed", useVmSnapshot: true, includeSettings: false },
      ),
    ).rejects.toBe(failure);
    expect(events).toEqual(["capture", "measure", "insert"]);
    expect(await repository.getSnapshot("failed")).toMatchObject({
      sizeBytes: null,
      pendingReclaim: true,
      pendingReclaimReason: "VM snapshot save was dispatched but capture failed: save failed",
      includeSettings: false,
      createdAt: "1970-01-01T00:00:00.000Z",
      manifest: { includeSettings: false },
    });
    expect(avd.getDeleteCalls()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Failed to measure orphaned"),
      expect.any(Error),
    );
  } finally {
    measure.mockRestore();
    write.mockRestore();
    warn.mockRestore();
  }
});

const manifest: DeviceSnapshotManifest = {
  snapshotName: "manifest-name",
  timestamp: "2026-01-01T00:00:00.000Z",
  deviceId: "physical",
  deviceName: "Pixel",
  platform: "android",
  snapshotType: "adb",
  includeAppData: true,
  includeSettings: false,
};
const invalidValues: unknown[] = [
  null,
  false,
  "manifest",
  [],
  ...Object.keys(manifest).map((key) => ({ ...manifest, [key]: undefined })),
  { ...manifest, platform: "web" },
  { ...manifest, snapshotType: "other" },
  { ...manifest, includeAppData: 1 },
  { ...manifest, includeSettings: "false" },
];
for (const [index, value] of [
  ...invalidValues,
  ...(["android", "ios"] as const).flatMap((platform) =>
    (["adb", "vm", "simctl", "app_data"] as const).map((snapshotType) => ({
      ...manifest,
      platform,
      snapshotType,
    })),
  ),
].entries()) {
  test(`legacy archive manifest validation case ${index}`, async () => {
    Object.assign(store, {
      getMetadataPath: () => "/characterization-snapshots/archive/metadata.json",
      getSettingsPath: () => "/characterization-snapshots/archive/settings.json",
    });
    const read = spyOn(fs, "readFile").mockImplementation(async (target) => {
      if (String(target).endsWith("metadata.json") || String(target).endsWith("manifest.json")) {
        return JSON.stringify(value);
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    const scan = spyOn(fs, "readdir").mockImplementation(async (target) =>
      String(target) === store.getBasePath()
        ? [{ name: "archive", isDirectory: () => true } as Dirent]
        : [],
    );
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const result = await listDeviceSnapshots();
      expect(result.count).toBe(index < invalidValues.length ? 0 : 1);
      const record = await repository.getSnapshot("archive");
      if (index >= invalidValues.length) {
        expect(record?.manifest).toEqual({
          ...(value as DeviceSnapshotManifest),
          snapshotName: "archive",
        });
      } else {
        expect(record).toBeNull();
      }
    } finally {
      read.mockRestore();
      scan.mockRestore();
      warn.mockRestore();
    }
  });
}
