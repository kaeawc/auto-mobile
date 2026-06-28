import { afterEach, describe, expect, test } from "bun:test";
import path from "path";
import { resolveMigrationFolder } from "../../src/db/migrator";
import { DAEMON_LAUNCH_CWD_ENV } from "../../src/utils/workingDirectory";

describe("migration path resolution", () => {
  const originalLaunchCwd = process.env[DAEMON_LAUNCH_CWD_ENV];
  const originalMigrationsDir = process.env.AUTOMOBILE_MIGRATIONS_DIR;
  const originalLegacyMigrationsDir = process.env.AUTO_MOBILE_MIGRATIONS_DIR;

  afterEach(() => {
    if (originalLaunchCwd === undefined) {
      delete process.env[DAEMON_LAUNCH_CWD_ENV];
    } else {
      process.env[DAEMON_LAUNCH_CWD_ENV] = originalLaunchCwd;
    }
    if (originalMigrationsDir === undefined) {
      delete process.env.AUTOMOBILE_MIGRATIONS_DIR;
    } else {
      process.env.AUTOMOBILE_MIGRATIONS_DIR = originalMigrationsDir;
    }
    if (originalLegacyMigrationsDir === undefined) {
      delete process.env.AUTO_MOBILE_MIGRATIONS_DIR;
    } else {
      process.env.AUTO_MOBILE_MIGRATIONS_DIR = originalLegacyMigrationsDir;
    }
  });

  test("resolves relative AUTOMOBILE_MIGRATIONS_DIR from daemon launch cwd", () => {
    const launchCwd = path.resolve("/project/auto-mobile");
    process.env[DAEMON_LAUNCH_CWD_ENV] = launchCwd;
    process.env.AUTOMOBILE_MIGRATIONS_DIR = path.join("src", "db", "migrations");

    expect(resolveMigrationFolder()).toBe(path.join(launchCwd, "src", "db", "migrations"));
  });

  test("resolves relative legacy AUTO_MOBILE_MIGRATIONS_DIR from daemon launch cwd", () => {
    const launchCwd = path.resolve("/project/auto-mobile");
    process.env[DAEMON_LAUNCH_CWD_ENV] = launchCwd;
    process.env.AUTO_MOBILE_MIGRATIONS_DIR = path.join("dist", "db", "migrations");

    expect(resolveMigrationFolder()).toBe(path.join(launchCwd, "dist", "db", "migrations"));
  });
});
