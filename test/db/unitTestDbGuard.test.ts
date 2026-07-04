import { afterEach, describe, expect, test } from "bun:test";
import path from "path";
import os from "os";
import { UNIT_TEST_DB_GUARD_ENV } from "../../src/db/database";
import { IN_MEMORY_DB_OPT_IN_ENV } from "../../src/db/migrationLock";
import { ActionableError } from "../../src/models/ActionableError";
import { importFreshDatabaseModule } from "./freshDatabaseModule";

/**
 * Unit tests for the real-DB guard (issue #3067).
 *
 * The guard is armed process-wide by the bun test preload
 * (`test/setup/unitTestDbGuard.ts`), so `process.env[UNIT_TEST_DB_GUARD_ENV]`
 * is already "1" here. These tests import a FRESH copy of `src/db/database.ts`
 * per case (its resolved-path cache is a module global) and drive it purely via
 * env: no real DB is ever opened because every resolve either throws or targets
 * an explicit override.
 */
describe("unit-test real-DB guard (issue #3067)", () => {
  const trackedKeys = [
    UNIT_TEST_DB_GUARD_ENV,
    IN_MEMORY_DB_OPT_IN_ENV,
    "AUTOMOBILE_DB_PATH",
    "AUTO_MOBILE_DB_PATH",
    "AUTOMOBILE_DB_DIR",
    "AUTO_MOBILE_DB_DIR",
  ];
  const saved = new Map<string, string | undefined>(
    trackedKeys.map(key => [key, process.env[key]])
  );

  function setEnv(key: string, value: string | undefined): void {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  function clearOverrides(): void {
    setEnv("AUTOMOBILE_DB_PATH", undefined);
    setEnv("AUTO_MOBILE_DB_PATH", undefined);
    setEnv("AUTOMOBILE_DB_DIR", undefined);
    setEnv("AUTO_MOBILE_DB_DIR", undefined);
    setEnv(IN_MEMORY_DB_OPT_IN_ENV, undefined);
  }

  afterEach(() => {
    for (const key of trackedKeys) {
      setEnv(key, saved.get(key));
    }
  });

  // Each case needs a fresh module instance so the cached `resolvedDbPath` from a
  // prior case does not mask the env we set here. Use the single canonical
  // primitive (freshDatabaseModule.ts) — its collision-proof monotonic cache-bust
  // key replaces this suite's old ad-hoc `Date.now()-Math.random()` import (which
  // the repo bans as a randomness source) and keeps the raw cache-busted import in
  // exactly one place (enforced by fileBackedDbAntiPattern.test.ts, issue #3081).

  test("getDatabasePath() throws an ActionableError on the default real path when armed", async () => {
    setEnv(UNIT_TEST_DB_GUARD_ENV, "1");
    clearOverrides();
    const db = await importFreshDatabaseModule();

    let thrown: unknown;
    try {
      db.getDatabasePath();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ActionableError);
    const message = (thrown as Error).message;
    // Names the real path and the required remediation so the failure is actionable.
    expect(message).toContain(path.join(os.homedir(), ".auto-mobile", "auto-mobile.db"));
    expect(message).toContain("createTestDatabase");
  });

  test("allows the `:memory:` sentinel without throwing", async () => {
    setEnv(UNIT_TEST_DB_GUARD_ENV, "1");
    clearOverrides();
    setEnv("AUTOMOBILE_DB_PATH", ":memory:");
    // `:memory:` via the real singleton also needs the #3065 production opt-in,
    // which the guard's own `:memory:` opt-out branch relies on being present.
    setEnv(IN_MEMORY_DB_OPT_IN_ENV, "1");
    const db = await importFreshDatabaseModule();

    expect(db.getDatabasePath()).toBe(":memory:");
  });

  test("allows an explicit AUTOMOBILE_DB_DIR override without throwing", async () => {
    setEnv(UNIT_TEST_DB_GUARD_ENV, "1");
    clearOverrides();
    const tempDir = path.join(os.tmpdir(), "auto-mobile-guard-test");
    setEnv("AUTOMOBILE_DB_DIR", tempDir);
    const db = await importFreshDatabaseModule();

    expect(db.getDatabasePath()).toBe(path.join(tempDir, "auto-mobile.db"));
  });

  test("allows the legacy AUTO_MOBILE_DB_DIR alias override without throwing", async () => {
    setEnv(UNIT_TEST_DB_GUARD_ENV, "1");
    clearOverrides();
    const tempDir = path.join(os.tmpdir(), "auto-mobile-guard-test-legacy");
    setEnv("AUTO_MOBILE_DB_DIR", tempDir);
    const db = await importFreshDatabaseModule();

    expect(db.getDatabasePath()).toBe(path.join(tempDir, "auto-mobile.db"));
  });

  test("an empty-string override is NOT an override — still throws on the default path", async () => {
    setEnv(UNIT_TEST_DB_GUARD_ENV, "1");
    clearOverrides();
    setEnv("AUTOMOBILE_DB_DIR", "");
    const db = await importFreshDatabaseModule();

    expect(() => db.getDatabasePath()).toThrow(ActionableError);
  });

  test("allows an explicit AUTOMOBILE_DB_PATH override without throwing", async () => {
    setEnv(UNIT_TEST_DB_GUARD_ENV, "1");
    clearOverrides();
    const dbPath = path.join(os.tmpdir(), "auto-mobile-guard-test", "explicit.db");
    setEnv("AUTOMOBILE_DB_PATH", dbPath);
    const db = await importFreshDatabaseModule();

    expect(db.getDatabasePath()).toBe(dbPath);
  });

  test("is inert (no throw) when the guard flag is not set — production safety", async () => {
    setEnv(UNIT_TEST_DB_GUARD_ENV, undefined);
    clearOverrides();
    const db = await importFreshDatabaseModule();

    // Resolves the default real path silently, exactly like production.
    expect(db.getDatabasePath()).toBe(
      path.join(os.homedir(), ".auto-mobile", "auto-mobile.db")
    );
  });
});
