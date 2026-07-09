import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { DaemonManager, type DaemonProcessSpawner } from "../../src/daemon/manager";
import { FakeTimer } from "../fakes/FakeTimer";
import { DAEMON_LAUNCH_CWD_ENV } from "../../src/utils/workingDirectory";

describe("DaemonManager launch", () => {
  const tempDirs: string[] = [];
  const originalCwd = process.cwd();

  function createTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    process.chdir(originalCwd);
    delete process.env[DAEMON_LAUNCH_CWD_ENV];
    delete process.env.AUTOMOBILE_DATA_DIR;
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  test("writes the daemon launch log under the stable data dir, not an ephemeral mkdtemp", async () => {
    const stateDir = createTempDir("daemon-launch-state-");
    const dataDir = createTempDir("daemon-data-dir-");
    process.env.AUTOMOBILE_DATA_DIR = dataDir;

    const processSpawner: DaemonProcessSpawner = {
      spawn: (_command: string, _args: string[], _options: SpawnOptions) => {
        return {
          unref() {},
          once() { return this; },
          off() { return this; },
        } as ChildProcess;
      }
    };

    let statusCallCount = 0;
    class TestDaemonManager extends DaemonManager {
      override findAllDaemonProcesses(): number[] { return []; }
      override async status(): Promise<any> {
        statusCallCount++;
        return statusCallCount === 1
          ? { running: false }
          : { running: true, pid: 1234, port: 31847, socketPath: join(stateDir, "daemon.sock") };
      }
      override async waitForReady(_timeout: number): Promise<boolean> {
        return true;
      }
    }

    const manager = new TestDaemonManager(
      undefined,
      undefined,
      new FakeTimer(),
      join(stateDir, "daemon.lock"),
      join(stateDir, "daemon.pid"),
      join(stateDir, "daemon.sock"),
      undefined,
      processSpawner
    );

    await manager.start();

    const logsDir = join(dataDir, "logs");
    expect(existsSync(logsDir)).toBe(true);
    const launchLogs = readdirSync(logsDir).filter(name => name.startsWith("daemon-launch"));
    expect(launchLogs.length).toBeGreaterThan(0);
  });

  test("spawns detached daemon from a stable cwd instead of inheriting the spawner cwd", async () => {
    const spawnerCwd = createTempDir("daemon-spawner-cwd-");
    const stateDir = createTempDir("daemon-launch-state-");
    process.chdir(spawnerCwd);
    // Keep the daemon launch log inside this test's temp tree, not the real
    // `~/.auto-mobile/logs` default (see tempDir.resolveAutoMobileBaseDir).
    process.env.AUTOMOBILE_DATA_DIR = spawnerCwd;

    let capturedOptions: SpawnOptions | undefined;
    const processSpawner: DaemonProcessSpawner = {
      spawn: (_command: string, _args: string[], options: SpawnOptions) => {
        capturedOptions = options;
        return {
          unref() {},
          once() { return this; },
          off() { return this; },
        } as ChildProcess;
      }
    };

    let statusCallCount = 0;
    class TestDaemonManager extends DaemonManager {
      override findAllDaemonProcesses(): number[] { return []; }
      override async status(): Promise<any> {
        statusCallCount++;
        return statusCallCount === 1
          ? { running: false }
          : { running: true, pid: 1234, port: 31847, socketPath: join(stateDir, "daemon.sock") };
      }
      override async waitForReady(_timeout: number): Promise<boolean> {
        return true;
      }
    }

    const manager = new TestDaemonManager(
      undefined,
      undefined,
      new FakeTimer(),
      join(stateDir, "daemon.lock"),
      join(stateDir, "daemon.pid"),
      join(stateDir, "daemon.sock"),
      undefined,
      processSpawner
    );

    await manager.start();

    expect(capturedOptions?.cwd).toBeString();
    expect(capturedOptions?.cwd).not.toBe(spawnerCwd);
    expect(existsSync(capturedOptions!.cwd as string)).toBe(true);
  });

  test("passes original launch cwd to the daemon for relative user paths", async () => {
    const spawnerCwd = createTempDir("daemon-spawner-cwd-");
    const stateDir = createTempDir("daemon-launch-state-");
    process.chdir(spawnerCwd);
    // Keep the daemon launch log inside this test's temp tree, not the real
    // `~/.auto-mobile/logs` default (see tempDir.resolveAutoMobileBaseDir).
    process.env.AUTOMOBILE_DATA_DIR = spawnerCwd;

    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const processSpawner: DaemonProcessSpawner = {
      spawn: (_command: string, _args: string[], options: SpawnOptions) => {
        capturedEnv = options.env;
        return {
          unref() {},
          once() { return this; },
          off() { return this; },
        } as ChildProcess;
      }
    };

    let statusCallCount = 0;
    class TestDaemonManager extends DaemonManager {
      override findAllDaemonProcesses(): number[] { return []; }
      override async status(): Promise<any> {
        statusCallCount++;
        return statusCallCount === 1
          ? { running: false }
          : { running: true, pid: 1234, port: 31847, socketPath: join(stateDir, "daemon.sock") };
      }
      override async waitForReady(_timeout: number): Promise<boolean> {
        return true;
      }
    }

    const manager = new TestDaemonManager(
      undefined,
      undefined,
      new FakeTimer(),
      join(stateDir, "daemon.lock"),
      join(stateDir, "daemon.pid"),
      join(stateDir, "daemon.sock"),
      undefined,
      processSpawner
    );

    await manager.start();

    expect(realpathSync(capturedEnv![DAEMON_LAUNCH_CWD_ENV]!)).toBe(realpathSync(spawnerCwd));
  });

  test("passes tool outputs directory option to the daemon child args", async () => {
    const stateDir = createTempDir("daemon-launch-state-");
    process.env.AUTOMOBILE_DATA_DIR = stateDir;

    let capturedArgs: string[] | undefined;
    const processSpawner: DaemonProcessSpawner = {
      spawn: (_command: string, args: string[], _options: SpawnOptions) => {
        capturedArgs = args;
        return {
          unref() {},
          once() { return this; },
          off() { return this; },
        } as ChildProcess;
      }
    };

    let statusCallCount = 0;
    class TestDaemonManager extends DaemonManager {
      override findAllDaemonProcesses(): number[] { return []; }
      override async status(): Promise<any> {
        statusCallCount++;
        return statusCallCount === 1
          ? { running: false }
          : { running: true, pid: 1234, port: 31847, socketPath: join(stateDir, "daemon.sock") };
      }
      override async waitForReady(_timeout: number): Promise<boolean> {
        return true;
      }
    }

    const manager = new TestDaemonManager(
      undefined,
      undefined,
      new FakeTimer(),
      join(stateDir, "daemon.lock"),
      join(stateDir, "daemon.pid"),
      join(stateDir, "daemon.sock"),
      undefined,
      processSpawner
    );

    await manager.start({ toolOutputsDir: "/tmp/auto-mobile-artifacts" });

    expect(capturedArgs).toContain("--tool-outputs-dir");
    expect(capturedArgs).toContain("/tmp/auto-mobile-artifacts");
  });

  test("resolves relative daemon state paths before changing daemon cwd", async () => {
    const spawnerCwd = createTempDir("daemon-spawner-cwd-");
    process.chdir(spawnerCwd);
    // Keep the daemon launch log inside this test's temp tree, not the real
    // `~/.auto-mobile/logs` default (see tempDir.resolveAutoMobileBaseDir).
    process.env.AUTOMOBILE_DATA_DIR = spawnerCwd;
    const canonicalSpawnerCwd = realpathSync(spawnerCwd);
    const expectedLockPath = resolve(canonicalSpawnerCwd, ".auto-mobile", "daemon.lock");
    const expectedPidPath = resolve(canonicalSpawnerCwd, ".auto-mobile", "daemon.pid");
    const expectedSocketPath = resolve(canonicalSpawnerCwd, ".auto-mobile", "daemon.sock");

    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const processSpawner: DaemonProcessSpawner = {
      spawn: (_command: string, _args: string[], options: SpawnOptions) => {
        capturedEnv = options.env;
        return {
          unref() {},
          once() { return this; },
          off() { return this; },
        } as ChildProcess;
      }
    };

    let statusCallCount = 0;
    class TestDaemonManager extends DaemonManager {
      override findAllDaemonProcesses(): number[] { return []; }
      override async status(): Promise<any> {
        statusCallCount++;
        return statusCallCount === 1
          ? { running: false }
          : { running: true, pid: 1234, port: 31847, socketPath: expectedSocketPath };
      }
      override async waitForReady(_timeout: number): Promise<boolean> {
        return true;
      }
    }

    const manager = new TestDaemonManager(
      undefined,
      undefined,
      new FakeTimer(),
      join(".auto-mobile", "daemon.lock"),
      join(".auto-mobile", "daemon.pid"),
      join(".auto-mobile", "daemon.sock"),
      undefined,
      processSpawner
    );

    await manager.start();

    expect(capturedEnv!.AUTOMOBILE_DAEMON_LOCK_FILE_PATH).toBe(expectedLockPath);
    expect(capturedEnv!.AUTOMOBILE_DAEMON_PID_FILE_PATH).toBe(expectedPidPath);
    expect(capturedEnv!.AUTOMOBILE_DAEMON_SOCKET_PATH).toBe(expectedSocketPath);
  });
});
