import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import type { Database } from "../../src/db/types";
import { DeviceLockRepository } from "../../src/db/deviceLockRepository";
import {
  DEVICE_LOCK_LISTENER_NAME,
  DeviceLockStore,
  createDeviceLockIdentityListener,
} from "../../src/devices/DeviceLockStore";
import { getDeviceIncarnationListeners } from "../../src/utils/deviceIncarnation";
import { createTestDatabase } from "./testDbHelper";
import * as deviceIdentityMigration from "../../src/db/migrations/2026_10_05_000_device_locks_device_identity";

/**
 * A remembered credential is only replayed on the device it was learned on
 * (#10065): adb serials are reused by different emulators, so the row carries the
 * device's stable identity and a mismatch reads as "nothing recorded".
 *
 * Migrates once in `beforeAll` (the expensive part) and clears the one table per
 * test, keeping each test inside the unit time budget.
 */
describe("DeviceLockRepository device identity", () => {
  let db: Kysely<Database>;
  let repo: DeviceLockRepository;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await db.deleteFrom("device_locks").execute();
    repo = new DeviceLockRepository(db);
  });

  test("replays a credential on the device it was learned on", async () => {
    await repo.rememberLock("emulator-5554", "pin", "1234", "avd-a");
    expect(await repo.getCredential("emulator-5554", "avd-a")).toBe("1234");
  });

  test("a different device behind the same serial gets no credential", async () => {
    await repo.rememberLock("emulator-5554", "pin", "1234", "avd-a");
    expect(await repo.getCredential("emulator-5554", "avd-b")).toBeNull();
  });

  test("an unresolved identity never replays a credential", async () => {
    await repo.rememberLock("emulator-5554", "pin", "1234", "avd-a");
    expect(await repo.getCredential("emulator-5554", undefined)).toBeNull();
  });

  test("a row written without an identity is never replayed", async () => {
    await repo.rememberLock("emulator-5554", "pin", "1234", undefined);
    expect(await repo.getCredential("emulator-5554", "avd-a")).toBeNull();
    expect(await repo.getCredential("emulator-5554", undefined)).toBeNull();
  });

  test("re-remembering on a replacement device re-tags the row", async () => {
    await repo.rememberLock("emulator-5554", "pin", "1234", "avd-a");
    await repo.rememberLock("emulator-5554", "pin", "5678", "avd-b");
    expect(await repo.getCredential("emulator-5554", "avd-a")).toBeNull();
    expect(await repo.getCredential("emulator-5554", "avd-b")).toBe("5678");
  });

  test("clearing with a null credential removes the remembered pin", async () => {
    await repo.rememberLock("emulator-5554", "pin", "1234", "avd-a");
    await repo.rememberLock("emulator-5554", "pin", null, "avd-a");
    expect(await repo.getCredential("emulator-5554", "avd-a")).toBeNull();
  });

  test("forget deletes the row for that serial only", async () => {
    await repo.rememberLock("emulator-5554", "pin", "1234", "avd-a");
    await repo.rememberLock("emulator-5556", "pin", "9999", "avd-c");
    await repo.forget("emulator-5554");
    expect(await repo.getCredential("emulator-5554", "avd-a")).toBeNull();
    expect(await db.selectFrom("device_locks").select("device_id").execute()).toEqual([
      { device_id: "emulator-5556" },
    ]);
    expect(await repo.getCredential("emulator-5556", "avd-c")).toBe("9999");
  });

  describe("mixed-version window (an older daemon's upsert never writes device_identity)", () => {
    /** The pre-#10065 upsert: rewrites type, credential and timestamp only. */
    async function olderDaemonUpsert(deviceId: string, credential: string | null): Promise<void> {
      await db
        .updateTable("device_locks")
        .set({ lock_type: "pin", lock_credential: credential })
        .where("device_id", "=", deviceId)
        .execute();
    }

    test("another AVD's PIN written by an older daemon is not replayed to the first AVD", async () => {
      await repo.rememberLock("emulator-5554", "pin", "1111", "avd-a");
      await olderDaemonUpsert("emulator-5554", "2222");

      expect(await repo.getCredential("emulator-5554", "avd-a")).toBeNull();
      expect(await repo.getCredential("emulator-5554", "avd-b")).toBeNull();
    });

    test("an older daemon re-storing the same PIN keeps it usable", async () => {
      await repo.rememberLock("emulator-5554", "pin", "1111", "avd-a");
      await olderDaemonUpsert("emulator-5554", "1111");

      expect(await repo.getCredential("emulator-5554", "avd-a")).toBe("1111");
    });

    test("the stored column is a binding digest, not the raw identity", async () => {
      await repo.rememberLock("emulator-5554", "pin", "1111", "avd-a");
      const row = await db
        .selectFrom("device_locks")
        .select("device_identity")
        .where("device_id", "=", "emulator-5554")
        .executeTakeFirstOrThrow();

      expect(row.device_identity).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  test("the store passes identity through to the repository", async () => {
    const store = new DeviceLockStore(repo);
    await store.rememberLock("emulator-5554", "pin", "1234", "avd-a");
    expect(await store.getRecordedCredential("emulator-5554", "avd-a")).toBe("1234");
    expect(await store.getRecordedCredential("emulator-5554", "avd-b")).toBeNull();
  });

  describe("identity replacement", () => {
    test("the incarnation listener forgets the credential for the replaced serial", async () => {
      await repo.rememberLock("emulator-5554", "pin", "1234", "avd-a");
      createDeviceLockIdentityListener(repo).onDeviceIdentityReplaced?.("emulator-5554");
      // forget() is fire-and-forget from the listener; one query orders after it.
      await repo.forget("emulator-5999");
      expect(await repo.getCredential("emulator-5554", "avd-a")).toBeNull();
    });

    test("same-device incarnation changes keep the credential", async () => {
      await repo.rememberLock("emulator-5554", "pin", "1234", "avd-a");
      await createDeviceLockIdentityListener(repo).onDeviceIncarnationChanged("emulator-5554");
      expect(await repo.getCredential("emulator-5554", "avd-a")).toBe("1234");
    });

    test("the store module registers the listener at load", () => {
      expect(getDeviceIncarnationListeners().map((l) => l.name)).toContain(
        DEVICE_LOCK_LISTENER_NAME,
      );
    });
  });
});

describe("device_locks device_identity migration", () => {
  test("keeps legacy rows with a null identity, never replayed, and is idempotent", async () => {
    const db = await createTestDatabase({ throughMigration: "2026_07_24_000_device_locks" });
    try {
      await db
        .insertInto("device_locks" as never)
        .values({ device_id: "emulator-5554", lock_type: "pin", lock_credential: "1234" } as never)
        .execute();

      await deviceIdentityMigration.up(db as Kysely<unknown>);
      await deviceIdentityMigration.up(db as Kysely<unknown>);

      const repo = new DeviceLockRepository(db);
      expect(await repo.getCredential("emulator-5554", "avd-a")).toBeNull();
      await repo.rememberLock("emulator-5554", "pin", "1234", "avd-a");
      expect(await repo.getCredential("emulator-5554", "avd-a")).toBe("1234");
    } finally {
      await db.destroy();
    }
  });
});
