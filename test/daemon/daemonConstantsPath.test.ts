import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DAEMON_LAUNCH_CWD_ENV } from "../../src/utils/workingDirectory";

describe("daemon state path constants", () => {
  const originalCwd = process.cwd();
  const originalEnv = { ...process.env };
  const tempDirs: string[] = [];

  function createTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  async function importFreshConstants() {
    return import(
      `../../src/daemon/constants.ts?daemon-state-path-test=${Date.now()}-${Math.random()}`
    );
  }

  afterEach(() => {
    process.chdir(originalCwd);
    process.env = { ...originalEnv };
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  test("resolves relative daemon state env paths from the direct launch cwd", async () => {
    const launchCwd = createTempDir("daemon-direct-launch-cwd-");
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
    const stableCwd = createTempDir("daemon-stable-cwd-");
    const launchCwd = createTempDir("daemon-recorded-launch-cwd-");
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
