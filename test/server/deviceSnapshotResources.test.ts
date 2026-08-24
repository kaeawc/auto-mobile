import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { DeviceSnapshotRecord } from "../../src/db/deviceSnapshotRepository";
import {
  resetDeviceSnapshotManagerDependencies,
  setDeviceSnapshotManagerDependencies,
} from "../../src/server/deviceSnapshotManager";
import { registerDeviceSnapshotResources } from "../../src/server/deviceSnapshotResources";
import { DEVICE_SNAPSHOT_RESOURCE_URIS } from "../../src/server/deviceSnapshotResourceUris";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSnapshotRepository } from "../fakes/FakeDeviceSnapshotRepository";
import { FakeDeviceSnapshotConfigRepository } from "../fakes/FakeDeviceSnapshotConfigRepository";
import { FakeDeviceSnapshotStore } from "../fakes/FakeDeviceSnapshotStore";

function makeRecord(overrides: Partial<DeviceSnapshotRecord> = {}): DeviceSnapshotRecord {
  return {
    snapshotName: "snapshot-1",
    deviceId: "test-device",
    deviceName: "Test Device",
    platform: "android",
    snapshotType: "adb",
    sizeBytes: 1024,
    createdAt: "2024-06-01T12:00:00.000Z",
    lastAccessedAt: "2024-06-01T12:00:00.000Z",
    manifest: {
      snapshotName: "snapshot-1",
      timestamp: "2024-06-01T12:00:00.000Z",
      deviceId: "test-device",
      deviceName: "Test Device",
      platform: "android",
      snapshotType: "adb",
      includeAppData: true,
      includeSettings: true,
    },
    ...overrides,
  };
}

async function readArchiveResource(): Promise<Record<string, unknown>> {
  const resource = ResourceRegistry.getResource(DEVICE_SNAPSHOT_RESOURCE_URIS.ARCHIVE);
  if (!resource) {
    throw new Error("Archive resource was not registered");
  }
  const content = await resource.handler();
  return JSON.parse(content.text ?? "{}");
}

describe("deviceSnapshotResources", () => {
  beforeEach(() => {
    registerDeviceSnapshotResources();
  });

  afterEach(async () => {
    ResourceRegistry.clearResources();
    await resetDeviceSnapshotManagerDependencies();
  });

  test("getSnapshotArchive returns the snapshots/count/totalSizeBytes/maxArchiveSizeMb envelope", async () => {
    const repository = new FakeDeviceSnapshotRepository();
    await repository.insertSnapshot(makeRecord());
    await repository.insertSnapshot(makeRecord({ snapshotName: "snapshot-2", sizeBytes: 2048 }));

    const configRepository = new FakeDeviceSnapshotConfigRepository();
    await configRepository.setConfig({ maxArchiveSizeMb: 500 } as never);

    await setDeviceSnapshotManagerDependencies({
      snapshotRepository: repository as any,
      configRepository: configRepository as any,
      snapshotStore: new FakeDeviceSnapshotStore() as any,
      timer: new FakeTimer(),
      now: () => new Date(0),
    });

    const parsed = await readArchiveResource();

    expect(parsed.count).toBe(2);
    expect(parsed.totalSizeBytes).toBe(3072);
    expect(parsed.maxArchiveSizeMb).toBe(500);
    expect(Array.isArray(parsed.snapshots)).toBe(true);
    expect((parsed.snapshots as unknown[]).length).toBe(2);
  });

  test("getSnapshotArchive returns an empty envelope when there are no snapshots", async () => {
    await setDeviceSnapshotManagerDependencies({
      snapshotRepository: new FakeDeviceSnapshotRepository() as any,
      configRepository: new FakeDeviceSnapshotConfigRepository() as any,
      snapshotStore: new FakeDeviceSnapshotStore() as any,
      timer: new FakeTimer(),
      now: () => new Date(0),
    });

    const parsed = await readArchiveResource();

    expect(parsed.count).toBe(0);
    expect(parsed.totalSizeBytes).toBe(0);
    expect(parsed.snapshots).toEqual([]);
  });

  test("getSnapshotArchive returns an error payload when listing snapshots fails", async () => {
    await setDeviceSnapshotManagerDependencies({
      snapshotRepository: {
        listSnapshots: async () => {
          throw new Error("db unavailable");
        },
      } as any,
      configRepository: new FakeDeviceSnapshotConfigRepository() as any,
      snapshotStore: new FakeDeviceSnapshotStore() as any,
      timer: new FakeTimer(),
      now: () => new Date(0),
    });

    const parsed = await readArchiveResource();

    expect(typeof parsed.error).toBe("string");
    expect(parsed.error as string).toContain("db unavailable");
  });
});
