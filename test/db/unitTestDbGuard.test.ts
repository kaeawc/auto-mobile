import { afterEach, describe, expect, test } from "bun:test";
import path from "path";
import os from "os";
import { UNIT_TEST_DB_GUARD_ENV } from "../../src/db/database";
import { IN_MEMORY_DB_OPT_IN_ENV } from "../../src/db/migrationLock";
import { ActionableError } from "../../src/models/ActionableError";
import { importFreshDatabaseModule } from "./freshDatabaseModule";

/**
 * Unit tests for the real-DB guard (issues #3067 / #3140).
 *
 * As of #3140 the guard is ARMED BY DEFAULT under a bun-test context
 * (`NODE_ENV === "test"`, which `bun test` sets automatically) rather than only
 * when the preload has set {@link UNIT_TEST_DB_GUARD_ENV}. The explicit env flag
 * is retained as an OR'd belt-and-suspenders force-arm for the rare
 * `NODE_ENV=production bun test` case (bun does not override an explicitly-set
 * NODE_ENV). These tests import a FRESH copy of `src/db/database.ts` per case
 * (its resolved-path cache is a module global) and drive it purely via env: no
 * real DB is ever opened because every resolve either throws or targets an
 * explicit override.
 */
describe("unit-test real-DB guard (issues #3067 / #3140)", () => {
  const DEFAULT_DB_PATH = path.join(os.homedir(), ".auto-mobile", "auto-mobile.db");

  const trackedKeys = [
    "NODE_ENV",
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

  /**
   * Put the process into a genuine bun-test context (armed by default) with NO
   * explicit force-arm flag, so a resolve exercises the #3140 arm-by-default path
   * rather than the legacy env-flag path.
   */
  function armViaBunTestContext(): void {
    setEnv("NODE_ENV", "test");
    setEnv(UNIT_TEST_DB_GUARD_ENV, undefined);
    clearOverrides();
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

  describe("arm-by-default under a bun-test context (issue #3140)", () => {
    test("throws on the default real path when NODE_ENV=test even with the force-arm flag UNSET", async () => {
      // The core #3140 behavior: no preload / no explicit flag, yet `bun test`'s
      // ambient NODE_ENV=test arms the guard on its own.
      armViaBunTestContext();
      const db = await importFreshDatabaseModule();

      let thrown: unknown;
      try {
        db.getDatabasePath();
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(ActionableError);
      const message = (thrown as Error).message;
      expect(message).toContain(DEFAULT_DB_PATH);
      expect(message).toContain("createTestDatabase");
    });

    test("bun-test context still respects the opt-outs (AUTOMOBILE_DB_DIR override)", async () => {
      armViaBunTestContext();
      const tempDir = path.join(os.tmpdir(), "auto-mobile-guard-3140-armdefault");
      setEnv("AUTOMOBILE_DB_DIR", tempDir);
      const db = await importFreshDatabaseModule();

      expect(db.getDatabasePath()).toBe(path.join(tempDir, "auto-mobile.db"));
    });

    test("bun-test context still respects the `:memory:` opt-out", async () => {
      armViaBunTestContext();
      setEnv("AUTOMOBILE_DB_PATH", ":memory:");
      setEnv(IN_MEMORY_DB_OPT_IN_ENV, "1");
      const db = await importFreshDatabaseModule();

      expect(db.getDatabasePath()).toBe(":memory:");
    });
  });

  describe("explicit force-arm flag (belt-and-suspenders, issue #3140)", () => {
    test("arms even when NODE_ENV is not a bun-test value (e.g. NODE_ENV=production bun test)", async () => {
      // bun does NOT override an explicitly-set NODE_ENV, so `NODE_ENV=production
      // bun test` would slip past the arm-by-default path; the preload's flag is
      // the retained fallback that keeps such a run guarded.
      setEnv("NODE_ENV", "production");
      setEnv(UNIT_TEST_DB_GUARD_ENV, "1");
      clearOverrides();
      const db = await importFreshDatabaseModule();

      expect(() => db.getDatabasePath()).toThrow(ActionableError);
    });
  });

  describe("production safety: inert when neither arming signal is present (issue #3140)", () => {
    test("resolves the default real path with no throw when NODE_ENV is non-test and the flag is unset", async () => {
      // Simulates the real daemon: no bun-test context, no force-arm flag.
      setEnv("NODE_ENV", "production");
      setEnv(UNIT_TEST_DB_GUARD_ENV, undefined);
      clearOverrides();
      const db = await importFreshDatabaseModule();

      expect(db.getDatabasePath()).toBe(DEFAULT_DB_PATH);
    });

    test("resolves the default real path with no throw when NODE_ENV is unset and the flag is unset", async () => {
      // A directly-launched daemon under `bun run` has no NODE_ENV at all.
      setEnv("NODE_ENV", undefined);
      setEnv(UNIT_TEST_DB_GUARD_ENV, undefined);
      clearOverrides();
      const db = await importFreshDatabaseModule();

      expect(db.getDatabasePath()).toBe(DEFAULT_DB_PATH);
    });
  });

  describe("shared opt-out surface (issue #3067)", () => {
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
      expect(message).toContain(DEFAULT_DB_PATH);
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
  });
});
