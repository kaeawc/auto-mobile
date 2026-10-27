import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { useScratchRoot } from "../helpers/scratchRoot";
import { DAEMON_LAUNCH_CWD_ENV } from "../../src/utils/workingDirectory";

describe("daemon state path constants", () => {
  const originalCwd = process.cwd();
  const originalEnv = { ...process.env };
  const scratch = useScratchRoot("daemon-constants-path-");

  function createTempDir(): string {
    return scratch.next();
  }

  async function importFreshConstants() {
    return import(
      `../../src/daemon/wire/constants.ts?daemon-state-path-test=${Date.now()}-${Math.random()}`
    );
  }

  beforeAll(async () => {
    const warmupDir = mkdtempSync(join(tmpdir(), "daemon-constants-warmup-"));
    try {
      // Warm the first import from outside the checkout, as the tests do.
      process.chdir(warmupDir);
      delete process.env[DAEMON_LAUNCH_CWD_ENV];
      process.env.AUTOMOBILE_DAEMON_SOCKET_PATH = join(warmupDir, "daemon.sock");
      process.env.AUTOMOBILE_DAEMON_PID_FILE_PATH = join(warmupDir, "daemon.pid");
      process.env.AUTOMOBILE_DAEMON_LOCK_FILE_PATH = join(warmupDir, "daemon.lock");
      process.env.AUTOMOBILE_LOG_DIR = join(warmupDir, "logs");
      process.env.AUTOMOBILE_DATA_DIR = join(warmupDir, "data");
      await importFreshConstants();
    } finally {
      process.chdir(originalCwd);
      process.env = { ...originalEnv };
      rmSync(warmupDir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.env = { ...originalEnv };
  });

  test("resolves relative daemon state env paths from the direct launch cwd", async () => {
    const launchCwd = createTempDir();
    process.chdir(launchCwd);
    delete process.env[DAEMON_LAUNCH_CWD_ENV];
    process.env.AUTOMOBILE_DAEMON_SOCKET_PATH = join(".auto-mobile", "daemon.sock");
    process.env.AUTOMOBILE_DAEMON_PID_FILE_PATH = join(".auto-mobile", "daemon.pid");
    process.env.AUTOMOBILE_DAEMON_LOCK_FILE_PATH = join(".auto-mobile", "daemon.lock");

    const constants = await importFreshConstants();
    const canonicalLaunchCwd = realpathSync(launchCwd);

    expect(constants.SOCKET_PATH).toBe(resolve(canonicalLaunchCwd, ".auto-mobile", "daemon.sock"));
    expect(constants.PID_FILE_PATH).toBe(resolve(canonicalLaunchCwd, ".auto-mobile", "daemon.pid"));
    expect(constants.LOCK_FILE_PATH).toBe(
      resolve(canonicalLaunchCwd, ".auto-mobile", "daemon.lock"),
    );
  });

  test("resolves relative daemon state env paths from the recorded launch cwd", async () => {
    const stableCwd = createTempDir();
    const launchCwd = createTempDir();
    process.chdir(stableCwd);
    process.env[DAEMON_LAUNCH_CWD_ENV] = launchCwd;
    process.env.AUTOMOBILE_DAEMON_SOCKET_PATH = join(".auto-mobile", "daemon.sock");
    process.env.AUTOMOBILE_DAEMON_PID_FILE_PATH = join(".auto-mobile", "daemon.pid");
    process.env.AUTOMOBILE_DAEMON_LOCK_FILE_PATH = join(".auto-mobile", "daemon.lock");

    const constants = await importFreshConstants();

    expect(constants.SOCKET_PATH).toBe(resolve(launchCwd, ".auto-mobile", "daemon.sock"));
    expect(constants.PID_FILE_PATH).toBe(resolve(launchCwd, ".auto-mobile", "daemon.pid"));
    expect(constants.LOCK_FILE_PATH).toBe(resolve(launchCwd, ".auto-mobile", "daemon.lock"));
  });
});
