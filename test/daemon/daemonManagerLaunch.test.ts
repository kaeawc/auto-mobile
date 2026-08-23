import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { PassThrough } from "node:stream";
import {
  DaemonManager,
  relayDaemonStderr,
  type DaemonProcessSpawner,
} from "../../src/daemon/manager";
import { FakeTimer } from "../fakes/FakeTimer";
import { DAEMON_LAUNCH_CWD_ENV } from "../../src/utils/workingDirectory";
import { TOOL_OUTPUTS_DIR_ENV, TOOL_OUTPUTS_DIR_FLAG } from "../../src/utils/toolOutputArtifacts";
import { EVENT_ALL_MARKERS_ENV, EVENT_ALL_MARKERS_FLAG } from "../../src/utils/eventAllMarkers";

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
    delete process.env.AUTOMOBILE_LOG_DIR;
    delete process.env.AUTOMOBILE_LOG_FORMAT;
    delete process.env.AUTOMOBILE_LOG_SINK;
    delete process.env[EVENT_ALL_MARKERS_ENV];
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  test("relays piped daemon stderr without sharing the host descriptor", () => {
    const daemonStderr = new PassThrough();
    const writes: string[] = [];
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);

    try {
      relayDaemonStderr({ stderr: daemonStderr } as ChildProcess);
      daemonStderr.write("daemon structured record\n");
    } finally {
      stderrSpy.mockRestore();
      daemonStderr.end();
    }

    expect(writes).toEqual(["daemon structured record\n"]);
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

  test("pipes stderr without a launch capture when structured stderr logging is enabled", async () => {
    const stateDir = createTempDir("daemon-launch-state-");
    process.env.AUTOMOBILE_DATA_DIR = stateDir;
    process.env.AUTOMOBILE_LOG_FORMAT = "json";
    process.env.AUTOMOBILE_LOG_SINK = "stderr";

    let capturedStdio: SpawnOptions["stdio"];
    const processSpawner: DaemonProcessSpawner = {
      spawn: (_command: string, _args: string[], options: SpawnOptions) => {
        capturedStdio = options.stdio;
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

    expect(capturedStdio).toEqual(["ignore", "ignore", "pipe"]);
  });

  test("writes the daemon launch log to AUTOMOBILE_LOG_DIR without moving data paths", async () => {
    const stateDir = createTempDir("daemon-launch-state-");
    const dataDir = createTempDir("daemon-data-dir-");
    const logDir = join(createTempDir("daemon-log-dir-"), "logs");
    process.env.AUTOMOBILE_DATA_DIR = dataDir;
    process.env.AUTOMOBILE_LOG_DIR = logDir;

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

    expect(existsSync(logDir)).toBe(true);
    expect(readdirSync(logDir).some(name => name.startsWith("daemon-launch"))).toBe(true);
    expect(existsSync(join(dataDir, "logs"))).toBe(false);
    expect(capturedOptions?.env?.AUTOMOBILE_LOG_DIR).toBe(logDir);
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

  test("passes tool outputs directory option to the daemon child env to preserve spaces", async () => {
    const stateDir = createTempDir("daemon-launch-state-");
    process.env.AUTOMOBILE_DATA_DIR = stateDir;

    let capturedArgs: string[] | undefined;
    let capturedEnv: NodeJS.ProcessEnv | undefined;
    const processSpawner: DaemonProcessSpawner = {
      spawn: (_command: string, args: string[], options: SpawnOptions) => {
        capturedArgs = args;
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

    const toolOutputsDir = "/tmp/auto mobile artifacts";
    await manager.start({ toolOutputsDir });

    expect(capturedArgs).not.toContain(TOOL_OUTPUTS_DIR_FLAG);
    expect(capturedEnv![TOOL_OUTPUTS_DIR_ENV]).toBe(toolOutputsDir);
  });

  test("serializes explicit empty event-all marker override so daemon env fallback stays disabled", async () => {
    const stateDir = createTempDir("daemon-launch-state-");
    process.env.AUTOMOBILE_DATA_DIR = stateDir;
    process.env[EVENT_ALL_MARKERS_ENV] = "@";

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

    await manager.start({ eventAllMarkers: [], eventAllMarkersCliOverride: true });

    expect(capturedArgs).toContain(`${EVENT_ALL_MARKERS_FLAG}=`);
    expect(capturedArgs).not.toContain(EVENT_ALL_MARKERS_FLAG);
  });

  test("does not serialize absent event-all marker config as an empty override", async () => {
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

    await manager.start({ eventAllMarkers: [] });

    expect(capturedArgs).not.toContain(`${EVENT_ALL_MARKERS_FLAG}=`);
    expect(capturedArgs).not.toContain(EVENT_ALL_MARKERS_FLAG);
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
