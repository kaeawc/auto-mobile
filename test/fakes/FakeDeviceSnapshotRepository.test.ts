import { describe, expect, test } from "bun:test";
import { DeviceSnapshotRepository } from "../../src/db/deviceSnapshotRepository";
import type {
  DeviceSnapshotQuery,
  DeviceSnapshotRecord,
} from "../../src/db/deviceSnapshotRepository";
import type { DeviceSnapshotManifest } from "../../src/models";
import { createTestDatabase } from "../db/testDbHelper";
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
  test("insertSnapshot overwrites an existing snapshot name", async () => {
    const repo = new FakeDeviceSnapshotRepository();

    await repo.insertSnapshot(
      makeRecord({
        manifest: makeManifest({ osVersion: "14" }),
      }),
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
      }),
    );

    const result = await repo.getSnapshot("snap-1");
    expect(result).not.toBeNull();
    expect(result!.deviceId).toBe("device-B");
    expect(result!.deviceName).toBe("Pixel_8");
    expect(result!.manifest.osVersion).toBe("17");
  });

  test("insertSnapshot preserves the original createdAt on overwrite (#3498)", async () => {
    const repo = new FakeDeviceSnapshotRepository();

    await repo.insertSnapshot(makeRecord({ createdAt: "2024-01-01T00:00:00.000Z" }));
    await repo.insertSnapshot(makeRecord({ createdAt: "2024-06-06T00:00:00.000Z" }));

    const result = await repo.getSnapshot("snap-1");
    expect(result!.createdAt).toBe("2024-01-01T00:00:00.000Z");
  });

  test("deleteSnapshot returns whether a snapshot existed", async () => {
    const repo = new FakeDeviceSnapshotRepository();
    await repo.insertSnapshot(makeRecord({ snapshotName: "present" }));

    expect(await repo.deleteSnapshot("present")).toBe(true);
    expect(await repo.deleteSnapshot("present")).toBe(false);
    expect(await repo.deleteSnapshot("never-existed")).toBe(false);
  });

  // Two rows whose created_at and last_accessed_at orderings CONFLICT: "a" was
  // created first but accessed last; "b" created last but accessed first. A
  // query asking for both orderings therefore exposes which one is primary.
  const conflictRows = [
    makeRecord({
      snapshotName: "a",
      createdAt: "2024-01-01T00:00:00.000Z",
      lastAccessedAt: "2024-03-01T00:00:00.000Z",
    }),
    makeRecord({
      snapshotName: "b",
      createdAt: "2024-03-01T00:00:00.000Z",
      lastAccessedAt: "2024-01-01T00:00:00.000Z",
    }),
  ];
  const dualOrderQuery: DeviceSnapshotQuery = {
    orderByLastAccessed: "asc",
    orderByCreatedAt: "asc",
  };

  test("dual ordering makes last_accessed primary, matching the real SQL", async () => {
    const repo = new FakeDeviceSnapshotRepository();
    for (const row of conflictRows) {
      await repo.insertSnapshot(row);
    }

    const names = (await repo.listSnapshots(dualOrderQuery)).map((record) => record.snapshotName);
    // last_accessed asc is primary: "b" (accessed Jan) before "a" (accessed Mar).
    // If created_at were primary (the inverted-precedence bug) it would be a,b.
    expect(names).toEqual(["b", "a"]);
  });

  test("fake dual-order precedence matches the real DeviceSnapshotRepository", async () => {
    const fake = new FakeDeviceSnapshotRepository();
    const db = await createTestDatabase();
    const real = new DeviceSnapshotRepository(db);
    try {
      for (const row of conflictRows) {
        await fake.insertSnapshot(row);
        await real.insertSnapshot(row);
      }

      const fakeNames = (await fake.listSnapshots(dualOrderQuery)).map((r) => r.snapshotName);
      const realNames = (await real.listSnapshots(dualOrderQuery)).map((r) => r.snapshotName);

      expect(fakeNames).toEqual(realNames);
    } finally {
      await db.destroy();
    }
  });

  // Offset-bearing timestamps whose LEXICAL (SQLite TEXT/BINARY) order disagrees
  // with their INSTANT (Date.parse) order. "lex-first" reads 12:00:00Z; "lex-last"
  // reads 13:00:00+02:00 == 11:00:00Z (an EARLIER instant). Lexically "12..." sorts
  // before "13...", so SQLite returns lex-first, lex-last; by instant it is the
  // reverse. A fake ordering on parsed instants would diverge from the real SQL.
  const offsetRows = [
    makeRecord({ snapshotName: "lex-first", lastAccessedAt: "2024-01-01T12:00:00Z" }),
    makeRecord({ snapshotName: "lex-last", lastAccessedAt: "2024-01-01T13:00:00+02:00" }),
  ];
  const lastAccessedAscQuery: DeviceSnapshotQuery = { orderByLastAccessed: "asc" };

  test("orders offset-bearing timestamps lexically like SQLite TEXT, not by instant", async () => {
    const fake = new FakeDeviceSnapshotRepository();
    const db = await createTestDatabase();
    const real = new DeviceSnapshotRepository(db);
    try {
      for (const row of offsetRows) {
        await fake.insertSnapshot(row);
        await real.insertSnapshot(row);
      }

      const fakeNames = (await fake.listSnapshots(lastAccessedAscQuery)).map((r) => r.snapshotName);
      const realNames = (await real.listSnapshots(lastAccessedAscQuery)).map((r) => r.snapshotName);

      // Real SQLite orders the stored TEXT lexically: "12:00:00Z" < "13:00:00+02:00".
      expect(realNames).toEqual(["lex-first", "lex-last"]);
      // Instant order would be the reverse (13:00+02:00 == 11:00Z is earlier); the
      // fake must match the real lexical order, not Date.parse instants.
      expect(fakeNames).toEqual(realNames);
    } finally {
      await db.destroy();
    }
  });
});
