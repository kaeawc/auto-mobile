import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RegistryBindingExclusion } from "../../../../src/daemon/sessionBroker/provisioning/exclusion";
import { BindingDiscoveryIncompleteError } from "../../../../src/daemon/sessionBroker/provisioning/refusal";
import {
  openSqliteBindingRegistry,
  bindingRegistryFileExists,
} from "../../../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import { FakeTimer } from "../../../fakes/FakeTimer";
import {
  bindFileBackedDbHarness,
  WINDOWS_FILE_DB_TEST_TIMEOUT_MS,
} from "../../../db/withFileBackedDb";
import { assignBindingDevice } from "./bindingFixtures";

// The real SQLite registry file: absent → empty and not created by reading; corrupt → fail closed;
// created by a writer → picked up.

describe("binding registry file absence (real SQLite)", () => {
  const getHarness = bindFileBackedDbHarness();

  function exclusionAt(dbPath: string) {
    const timer = new FakeTimer();
    return new RegistryBindingExclusion(
      () => openSqliteBindingRegistry({ dbPath, timer }),
      timer,
      () => bindingRegistryFileExists(dbPath),
    );
  }

  test(
    "an absent file reads as empty and is not created; a writer's file is then read",
    async () => {
      const dir = join(await getHarness().makeTempDbDir("am-bindings-abs-"), "registry");
      const dbPath = join(dir, "slots.sqlite");
      const exclusion = exclusionAt(dbPath);

      await exclusion.refresh();
      expect(exclusion.stableIdsFor("android").size).toBe(0);
      expect(existsSync(dir)).toBe(false);

      const writer = await openSqliteBindingRegistry({ dbPath });
      try {
        await assignBindingDevice(writer, "android", "avd-binding");
      } finally {
        await writer.close();
      }
      await exclusion.refresh();
      expect([...exclusion.stableIdsFor("android")]).toEqual(["avd-binding"]);
    },
    WINDOWS_FILE_DB_TEST_TIMEOUT_MS,
  );

  test(
    "a file that exists but is not a readable registry fails closed",
    async () => {
      const dir = await getHarness().makeTempDbDir("am-bindings-bad-");
      mkdirSync(join(dir, "registry"), { recursive: true });
      const dbPath = join(dir, "registry", "slots.sqlite");
      writeFileSync(dbPath, "this is not a sqlite database, just some bytes to fail the header");

      await expect(exclusionAt(dbPath).refresh()).rejects.toBeInstanceOf(
        BindingDiscoveryIncompleteError,
      );
    },
    WINDOWS_FILE_DB_TEST_TIMEOUT_MS,
  );
});
