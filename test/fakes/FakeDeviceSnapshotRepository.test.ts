import { describe, expect, test } from "bun:test";
import type { DeviceSnapshotRecord } from "../../src/db/deviceSnapshotRepository";
import type { DeviceSnapshotManifest } from "../../src/models";
import { FakeDeviceSnapshotRepository } from "./FakeDeviceSnapshotRepository";

function makeManifest(overrides: Partial<DeviceSnapshotManifest> = {}): DeviceSnapshotManifest {
  return {
    snapshotName: "snap-1",
    timestamp: "2024-01-01T00:00:00.000Z",
    deviceId: "emulator-5554",
    deviceName: "Pixel_6",
    platform: "android",
    snapshotType: "vm",
    includeAppData: false,
    includeSettings: false,
    ...overrides,
  };
}

function makeRecord(overrides: Partial<DeviceSnapshotRecord> = {}): DeviceSnapshotRecord {
  const snapshotName = overrides.snapshotName ?? "snap-1";
  return {
    snapshotName,
    deviceId: "emulator-5554",
    deviceName: "Pixel_6",
    platform: "android",
    snapshotType: "vm",
    includeAppData: false,
    includeSettings: false,
    createdAt: "2024-01-01T00:00:00.000Z",
    lastAccessedAt: "2024-01-01T00:00:00.000Z",
    sizeBytes: 1024,
    manifest: makeManifest({ snapshotName }),
    ...overrides,
  };
}

describe("FakeDeviceSnapshotRepository", () => {
  test("insertSnapshot preserves the first record for an existing snapshot name", async () => {
    const repo = new FakeDeviceSnapshotRepository();

    await repo.insertSnapshot(
      makeRecord({
        manifest: makeManifest({ osVersion: "14" }),
      })
    );
    await repo.insertSnapshot(
      makeRecord({
        snapshotName: "snap-1",
        deviceId: "device-B",
        deviceName: "Pixel_8",
        manifest: makeManifest({
          snapshotName: "snap-1",
          deviceId: "device-B",
          deviceName: "Pixel_8",
          osVersion: "17",
        }),
      })
    );

    const result = await repo.getSnapshot("snap-1");
    expect(result).not.toBeNull();
    expect(result!.deviceId).toBe("emulator-5554");
    expect(result!.deviceName).toBe("Pixel_6");
    expect(result!.manifest.osVersion).toBe("14");
  });
});
