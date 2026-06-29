import { afterEach, describe, expect, test } from "bun:test";
import path from "path";
import { DAEMON_LAUNCH_CWD_ENV } from "../../src/utils/workingDirectory";
import { resolveDatabasePathFromEnvironment } from "../../src/db/database";

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
});
