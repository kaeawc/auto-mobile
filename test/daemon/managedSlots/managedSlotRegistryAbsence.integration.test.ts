import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RegistryManagedSlotExclusion } from "../../../src/daemon/managedSlots/managedSlotExclusion";
import { ManagedSlotDiscoveryIncompleteError } from "../../../src/daemon/managedSlots/managedSlotRefusal";
import {
  openSqliteSlotRegistry,
  slotRegistryFileExists,
} from "../../../src/daemon/managedSlots/sqliteSlotRegistry";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  bindFileBackedDbHarness,
  WINDOWS_FILE_DB_TEST_TIMEOUT_MS,
} from "../../db/withFileBackedDb";
import { assignManagedSlotDevice } from "./managedSlotFixtures";

// The real SQLite registry file: absent → empty and not created by reading; corrupt → fail closed;
// created by a writer → picked up.

describe("managed-slot registry file absence (real SQLite)", () => {
  const getHarness = bindFileBackedDbHarness();

  function exclusionAt(dbPath: string) {
    const timer = new FakeTimer();
    return new RegistryManagedSlotExclusion(
      () => openSqliteSlotRegistry({ dbPath, timer }),
      timer,
      () => slotRegistryFileExists(dbPath),
    );
  }

  test(
    "an absent file reads as empty and is not created; a writer's file is then read",
    async () => {
      const dir = join(await getHarness().makeTempDbDir("am-slots-abs-"), "registry");
      const dbPath = join(dir, "slots.sqlite");
      const exclusion = exclusionAt(dbPath);

      await exclusion.refresh();
      expect(exclusion.stableIdsFor("android").size).toBe(0);
      expect(existsSync(dir)).toBe(false);

      const writer = await openSqliteSlotRegistry({ dbPath });
      try {
        await assignManagedSlotDevice(writer, "android", "avd-slot");
      } finally {
        await writer.close();
      }
      await exclusion.refresh();
      expect([...exclusion.stableIdsFor("android")]).toEqual(["avd-slot"]);
    },
    WINDOWS_FILE_DB_TEST_TIMEOUT_MS,
  );

  test(
    "a file that exists but is not a readable registry fails closed",
    async () => {
      const dir = await getHarness().makeTempDbDir("am-slots-bad-");
      mkdirSync(join(dir, "registry"), { recursive: true });
      const dbPath = join(dir, "registry", "slots.sqlite");
      writeFileSync(dbPath, "this is not a sqlite database, just some bytes to fail the header");

      await expect(exclusionAt(dbPath).refresh()).rejects.toBeInstanceOf(
        ManagedSlotDiscoveryIncompleteError,
      );
    },
    WINDOWS_FILE_DB_TEST_TIMEOUT_MS,
  );
});
