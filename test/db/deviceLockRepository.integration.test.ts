import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import type { Database } from "../../src/db/types";
import { DeviceLockRepository } from "../../src/db/deviceLockRepository";
import { createTestDatabase } from "./testDbHelper";

/**
 * Device-keyed lock memory (issue #4360). Keyed by device_id so it works with no
 * device_sessions row — the default (autolock-off) config and the boot path,
 * neither of which creates a session.
 */
describe("DeviceLockRepository", () => {
  let db: Kysely<Database>;
  let repo: DeviceLockRepository;

  beforeEach(async () => {
    db = await createTestDatabase();
    repo = new DeviceLockRepository(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  test("returns null for a device with nothing recorded", async () => {
    expect(await repo.getCredential("emulator-5554")).toBeNull();
  });

  test("remembers and reads back a credential, with no session row required", async () => {
    await repo.rememberLock("emulator-5554", "pin", "1234");
    expect(await repo.getCredential("emulator-5554")).toBe("1234");
  });

  test("upserts by device_id: remembering again overwrites the prior credential", async () => {
    await repo.rememberLock("emulator-5554", "pin", "1234");
    await repo.rememberLock("emulator-5554", "pin", "5678");
    expect(await repo.getCredential("emulator-5554")).toBe("5678");
  });

  test("a null credential clears a previously remembered one (self-heal on stale pin)", async () => {
    await repo.rememberLock("emulator-5554", "pin", "1234");
    await repo.rememberLock("emulator-5554", "pin", null);
    expect(await repo.getCredential("emulator-5554")).toBeNull();
  });

  test("credentials are isolated per device", async () => {
    await repo.rememberLock("emulator-5554", "pin", "1234");
    await repo.rememberLock("emulator-5556", "pin", "9999");
    expect(await repo.getCredential("emulator-5554")).toBe("1234");
    expect(await repo.getCredential("emulator-5556")).toBe("9999");
  });
});
