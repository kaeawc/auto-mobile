import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { promises as fs } from "fs";
import * as path from "path";
import { useScratchRoot } from "../helpers/scratchRoot";
import { ActionableError, type DeviceSnapshotManifest } from "../../src/models";
import {
  captureDeviceSnapshot,
  listDeviceSnapshots,
  resetDeviceSnapshotManagerDependencies,
  setDeviceSnapshotManagerDependencies,
} from "../../src/daemon/deviceSnapshotManager";
import { FakeDeviceSnapshotRepository } from "../fakes/FakeDeviceSnapshotRepository";
import { FakeDeviceSnapshotConfigRepository } from "../fakes/FakeDeviceSnapshotConfigRepository";
import { FakeDeviceSnapshotStore } from "../fakes/FakeDeviceSnapshotStore";
import { FakeAvdSnapshotService } from "../fakes/FakeAvdSnapshotService";
import { FakeTimer } from "../fakes/FakeTimer";
import { logger } from "../../src/utils/logger";

let repository: FakeDeviceSnapshotRepository;
let store: FakeDeviceSnapshotStore;
let avd: FakeAvdSnapshotService;
// One temp root for the file, a fresh empty snapshots directory per test (see scratchRoot.ts).
const scratch = useScratchRoot("snapshot-characterization-");
beforeEach(async () => {
  repository = new FakeDeviceSnapshotRepository();
  store = new FakeDeviceSnapshotStore(scratch.next());
  avd = new FakeAvdSnapshotService();
  const timer = new FakeTimer();
  await setDeviceSnapshotManagerDependencies({
    snapshotRepository: repository,
    snapshotStore: store,
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
    const archiveDir = path.join(store.getBasePath(), "archive");
    await fs.mkdir(archiveDir, { recursive: true });
    await fs.writeFile(store.getMetadataPath("archive"), JSON.stringify(value));
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
      warn.mockRestore();
    }
  });
}
