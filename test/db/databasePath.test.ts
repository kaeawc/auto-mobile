import { afterEach, describe, expect, test } from "bun:test";
import path from "path";
import { DAEMON_LAUNCH_CWD_ENV } from "../../src/utils/workingDirectory";
import { resolveDatabasePathFromEnvironment } from "../../src/db/database";
import { IN_MEMORY_DB_OPT_IN_ENV } from "../../src/db/migrationLock";
import { ActionableError } from "../../src/models/ActionableError";

describe("database path resolution", () => {
  const originalLaunchCwd = process.env[DAEMON_LAUNCH_CWD_ENV];

  afterEach(() => {
    if (originalLaunchCwd === undefined) {
      delete process.env[DAEMON_LAUNCH_CWD_ENV];
    } else {
      process.env[DAEMON_LAUNCH_CWD_ENV] = originalLaunchCwd;
    }
  });

  test("resolves relative AUTOMOBILE_DB_DIR from daemon launch cwd", () => {
    const launchCwd = path.resolve("/project/auto-mobile");
    process.env[DAEMON_LAUNCH_CWD_ENV] = launchCwd;

    expect(resolveDatabasePathFromEnvironment({
      AUTOMOBILE_DB_DIR: ".automobile-db",
    })).toBe(path.join(launchCwd, ".automobile-db", "auto-mobile.db"));
  });

  test("resolves relative AUTOMOBILE_DB_PATH from daemon launch cwd", () => {
    const launchCwd = path.resolve("/project/auto-mobile");
    process.env[DAEMON_LAUNCH_CWD_ENV] = launchCwd;

    expect(resolveDatabasePathFromEnvironment({
      AUTOMOBILE_DB_PATH: ".state/session.db",
    })).toBe(path.join(launchCwd, ".state", "session.db"));
  });

  test("leaves absolute AUTOMOBILE_DB_PATH unchanged", () => {
    const dbPath = path.resolve("/tmp/auto-mobile.db");
    process.env[DAEMON_LAUNCH_CWD_ENV] = path.resolve("/project/auto-mobile");

    expect(resolveDatabasePathFromEnvironment({
      AUTOMOBILE_DB_PATH: dbPath,
    })).toBe(dbPath);
  });

  test("passes the `:memory:` sentinel through un-resolved when opted in (issue #3047)", () => {
    // A `:memory:` DB is not a filesystem path: routing it through the
    // daemon-launch-cwd resolver would `path.resolve(":memory:")` into a bogus
    // absolute path (and later create a `:memory:.migrate.lock` file). With the
    // explicit test opt-in set, it must be returned verbatim even with a daemon
    // launch cwd set.
    process.env[DAEMON_LAUNCH_CWD_ENV] = path.resolve("/project/auto-mobile");

    expect(resolveDatabasePathFromEnvironment({
      AUTOMOBILE_DB_PATH: ":memory:",
      [IN_MEMORY_DB_OPT_IN_ENV]: "1",
    })).toBe(":memory:");
  });

  test("passes the `:memory:` sentinel through the legacy AUTO_MOBILE_DB_PATH alias when opted in", () => {
    process.env[DAEMON_LAUNCH_CWD_ENV] = path.resolve("/project/auto-mobile");

    expect(resolveDatabasePathFromEnvironment({
      AUTO_MOBILE_DB_PATH: ":memory:",
      [IN_MEMORY_DB_OPT_IN_ENV]: "true",
    })).toBe(":memory:");
  });

  describe("guards production `:memory:` misuse (issue #3065)", () => {
    test("rejects `AUTOMOBILE_DB_PATH=:memory:` without the opt-in flag", () => {
      // Without the opt-in, `:memory:` on a real daemon yields a
      // migrated-but-empty app connection (migrations run on a separate private
      // in-memory DB), so the first schema-dependent query fails with
      // `no such table`. Fail fast and legibly instead.
      expect(() =>
        resolveDatabasePathFromEnvironment({ AUTOMOBILE_DB_PATH: ":memory:" })
      ).toThrow(ActionableError);
    });

    test("rejects the legacy `AUTO_MOBILE_DB_PATH=:memory:` alias without the opt-in flag", () => {
      expect(() =>
        resolveDatabasePathFromEnvironment({ AUTO_MOBILE_DB_PATH: ":memory:" })
      ).toThrow(ActionableError);
    });

    test("rejects `:memory:` when the opt-in flag is present but false-ish", () => {
      for (const value of ["", "0", "false"]) {
        expect(() =>
          resolveDatabasePathFromEnvironment({
            AUTOMOBILE_DB_PATH: ":memory:",
            [IN_MEMORY_DB_OPT_IN_ENV]: value,
          })
        ).toThrow(ActionableError);
      }
    });

    test("the error message is actionable: names the env vars and the fix", () => {
      let caught: unknown;
      try {
        resolveDatabasePathFromEnvironment({ AUTOMOBILE_DB_PATH: ":memory:" });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ActionableError);
      const message = (caught as Error).message;
      // Points at the misused path, the real cause, the opt-in flag, and the fix.
      expect(message).toContain(":memory:");
      expect(message).toContain("AUTOMOBILE_DB_PATH");
      expect(message).toContain(IN_MEMORY_DB_OPT_IN_ENV);
    });

    test("does not affect real file paths regardless of the opt-in flag", () => {
      const dbPath = path.resolve("/tmp/auto-mobile.db");
      // Flag absent.
      expect(resolveDatabasePathFromEnvironment({ AUTOMOBILE_DB_PATH: dbPath })).toBe(dbPath);
      // Flag present — must not change a real-file resolution.
      expect(
        resolveDatabasePathFromEnvironment({
          AUTOMOBILE_DB_PATH: dbPath,
          [IN_MEMORY_DB_OPT_IN_ENV]: "1",
        })
      ).toBe(dbPath);
    });
  });
});
