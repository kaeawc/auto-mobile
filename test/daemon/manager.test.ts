import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import {
  DAEMON_PROCESS_TABLE_MAX_BUFFER_BYTES,
  createDefaultDaemonProcessFinder,
  daemonBuildIdentityStatusLines,
  DaemonManager,
  parseDaemonProcessTable,
  PsDaemonProcessFinder,
  runDaemonCommand,
  WindowsDaemonProcessFinder,
} from "../../src/daemon/manager";
import { DaemonLauncher } from "../../src/daemon/DaemonLauncher";
import type { BuildIdentity } from "../../src/daemon/buildIdentity";
import type { DaemonOptions, DaemonStatus } from "../../src/daemon/types";
import type {
  DaemonProcessFinder,
  DaemonProcessLivenessChecker,
  DaemonProcessSpawner,
  DaemonProcessRecord,
  ExtractionCleaner,
} from "../../src/daemon/manager";
import type { DaemonStateLike } from "../../src/daemon/daemonState";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import type { DaemonClientLike } from "../../src/daemon/client";
import { FakeTimer } from "../fakes/FakeTimer";

describe("daemonBuildIdentityStatusLines", () => {
  const client: BuildIdentity = {
    entryScript: "/wt/dist/src/index.js",
    buildId: "1111111111111111",
  };

  test("always reports the daemon's Build ID and Entry Script", () => {
    const status: DaemonStatus = {
      running: true,
      pid: 99,
      entryScript: "/wt/dist/src/index.js",
      buildId: "1111111111111111",
    };

    const lines = daemonBuildIdentityStatusLines(status, client);

    expect(lines).toContain("  Build ID: 1111111111111111");
    expect(lines).toContain("  Entry Script: /wt/dist/src/index.js");
  });

  test("falls back to 'unknown' for a legacy daemon and does not warn", () => {
    const status: DaemonStatus = { running: true, pid: 99 };

    const lines = daemonBuildIdentityStatusLines(status, client);

    expect(lines).toContain("  Build ID: unknown");
    expect(lines).toContain("  Entry Script: unknown");
    expect(lines.some(line => line.includes("WARNING"))).toBe(false);
  });

  test("warns and shows both builds when the daemon is a different build", () => {
    const status: DaemonStatus = {
      running: true,
      pid: 99,
      entryScript: "/main/dist/src/index.js",
      buildId: "2222222222222222",
    };

    const lines = daemonBuildIdentityStatusLines(status, client);
    const text = lines.join("\n");

    expect(text).toContain("WARNING");
    expect(text).toContain("2222222222222222");
    expect(text).toContain("/main/dist/src/index.js");
    expect(text).toContain("1111111111111111");
    expect(text).toContain("/wt/dist/src/index.js");
    expect(text).toContain("--daemon restart");
  });
});

describe("DaemonManager restart", () => {
  test("preserves PID-recorded options when no replacement options are requested", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const manager = new DaemonManager(undefined, undefined, timer);
    const recordedOptions: DaemonOptions = {
      debug: true,
      toolOutputsDir: "/tmp/automobile-artifacts",
      eventAllMarkers: ["@", "#"],
    };
    const statusSpy = spyOn(manager, "status").mockResolvedValue({
      running: true,
      options: recordedOptions,
    });
    const stopSpy = spyOn(manager, "stop").mockResolvedValue(undefined);
    const startSpy = spyOn(manager, "start").mockResolvedValue(undefined);

    await manager.restart();

    expect(statusSpy).toHaveBeenCalledTimes(1);
    expect(stopSpy).toHaveBeenCalledTimes(1);
    expect(startSpy).toHaveBeenCalledWith(recordedOptions);
  });
});

describe("DaemonManager stop", () => {
  function createManagerForStop(
    livePids: Set<number>,
    timer: FakeTimer,
    pidFilePath: string,
    socketPath: string,
    onLivenessCheck?: () => void,
  ): DaemonManager {
    const processFinder: DaemonProcessFinder & DaemonProcessLivenessChecker = {
      findDaemonProcesses: () => [],
      isProcessRunning: pid => {
        onLivenessCheck?.();
        return livePids.has(pid);
      },
    };
    return new DaemonManager(
      undefined,
      undefined,
      timer,
      join(tmpdir(), "unused-daemon-lock"),
      pidFilePath,
      socketPath,
      processFinder,
    );
  }

  function writeStopPidFile(pidFilePath: string, pid: number, socketPath: string): void {
    writeFileSync(pidFilePath, JSON.stringify({
      pid,
      socketPath,
      port: 3000,
      startedAt: 1,
      version: "test",
    }));
  }

  test("fails without cleanup when the daemon remains live after SIGKILL", async () => {
    const directory = mkdtempSync(join(tmpdir(), "daemon-manager-stop-stubborn-"));
    const pidFilePath = join(directory, "daemon.pid");
    const socketPath = join(directory, "daemon.sock");
    const pid = 4242;
    const livePids = new Set([pid]);
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    writeStopPidFile(pidFilePath, pid, socketPath);
    writeFileSync(socketPath, "socket");
    const manager = createManagerForStop(livePids, timer, pidFilePath, socketPath);
    const killSpy = spyOn(process, "kill").mockImplementation(() => true);

    try {
      await expect(manager.stop(1_000)).rejects.toThrow(
        "Daemon process 4242 did not exit after SIGKILL",
      );

      expect(killSpy.mock.calls.filter(([targetPid]) => targetPid === pid)).toEqual([
        [pid, "SIGTERM"],
        [pid, "SIGKILL"],
      ]);
      expect(existsSync(pidFilePath)).toBe(true);
      expect(existsSync(socketPath)).toBe(true);
    } finally {
      killSpy.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("cleans metadata after post-SIGKILL polling confirms exit", async () => {
    const directory = mkdtempSync(join(tmpdir(), "daemon-manager-stop-exit-"));
    const pidFilePath = join(directory, "daemon.pid");
    const socketPath = join(directory, "daemon.sock");
    const pid = 4243;
    const livePids = new Set([pid]);
    const timer = new FakeTimer();
    let livenessChecks = 0;
    timer.enableAutoAdvance();
    writeStopPidFile(pidFilePath, pid, socketPath);
    writeFileSync(socketPath, "socket");
    const manager = createManagerForStop(
      livePids,
      timer,
      pidFilePath,
      socketPath,
      () => { livenessChecks++; },
    );
    const killSpy = spyOn(process, "kill").mockImplementation((_targetPid, signal) => {
      if (signal === "SIGKILL") {
        livePids.delete(pid);
      }
      return true;
    });

    try {
      await expect(manager.stop(1_000)).resolves.toBeUndefined();

      expect(killSpy.mock.calls.filter(([targetPid]) => targetPid === pid)).toEqual([
        [pid, "SIGTERM"],
        [pid, "SIGKILL"],
      ]);
      expect(livenessChecks).toBeGreaterThan(12);
      expect(existsSync(pidFilePath)).toBe(false);
      expect(existsSync(socketPath)).toBe(false);
    } finally {
      killSpy.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("cleans metadata when the daemon exits at the post-SIGKILL deadline", async () => {
    const directory = mkdtempSync(join(tmpdir(), "daemon-manager-stop-deadline-"));
    const pidFilePath = join(directory, "daemon.pid");
    const socketPath = join(directory, "daemon.sock");
    const pid = 4244;
    const livePids = new Set([pid]);
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    writeStopPidFile(pidFilePath, pid, socketPath);
    writeFileSync(socketPath, "socket");
    const manager = createManagerForStop(livePids, timer, pidFilePath, socketPath);
    const killSpy = spyOn(process, "kill").mockImplementation((_targetPid, signal) => {
      if (signal === "SIGKILL") {
        timer.setTimeout(() => { livePids.delete(pid); }, 1_000);
      }
      return true;
    });

    try {
      await expect(manager.stop(1_000)).resolves.toBeUndefined();

      expect(killSpy.mock.calls.filter(([targetPid]) => targetPid === pid)).toEqual([
        [pid, "SIGTERM"],
        [pid, "SIGKILL"],
      ]);
      expect(existsSync(pidFilePath)).toBe(false);
      expect(existsSync(socketPath)).toBe(false);
    } finally {
      killSpy.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

class FakeDaemonClient implements DaemonClientLike {
  readonly readResourceCalls: string[] = [];
  readonly callToolCalls: Array<{ toolName: string; params: Record<string, any> }> = [];
  readonly callDaemonMethodCalls: Array<{ method: string; params: Record<string, any> }> = [];
  private readonly result: any;

  constructor(result: any) {
    this.result = result;
  }

  async connect(): Promise<void> {}

  async close(): Promise<void> {}

  async callTool(toolName: string, params: Record<string, any>): Promise<any> {
    this.callToolCalls.push({ toolName, params });
    return {};
  }

  async readResource(uri: string): Promise<any> {
    this.readResourceCalls.push(uri);
    return this.result;
  }

  async callDaemonMethod(method: string, params: Record<string, any>): Promise<any> {
    this.callDaemonMethodCalls.push({ method, params });
    return {};
  }
}

class FakeDaemonProcessFinder implements DaemonProcessFinder, DaemonProcessLivenessChecker {
  constructor(
    private readonly records: DaemonProcessRecord[],
    private readonly livePids: Set<number> = new Set(records.map(record => record.pid))
  ) {}

  findDaemonProcesses(): DaemonProcessRecord[] {
    return this.records;
  }

  isProcessRunning(pid: number): boolean {
    return this.livePids.has(pid);
  }
}

class FakeDaemonChildProcess extends EventEmitter {
  unref(): void {}

  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit("exit", code, signal);
  }
}

function neverReadyAfterExit(child: FakeDaemonChildProcess, code: number): Promise<boolean> {
  child.exit(code);
  return new Promise(() => {});
}

class FakeExtractionCleaner implements ExtractionCleaner {
  readonly entryScripts: string[] = [];

  async removeExtractionForEntryScript(entryScript: string): Promise<boolean> {
    this.entryScripts.push(entryScript);
    return true;
  }
}

describe("DaemonLauncher command resolution", () => {
  test("uses the current entry script when one is available", () => {
    const launch = new DaemonLauncher({
      entryScript: "/tmp/auto-mobile/dist/src/index.js",
      version: "1.2.3",
      processExecPath: process.execPath,
    }).resolveCommand();

    expect(launch).toEqual({
      command: process.execPath,
      args: ["/tmp/auto-mobile/dist/src/index.js", "--daemon-mode"],
    });
  });

  test("pins bunx fallback to the initiating package version", () => {
    const launch = new DaemonLauncher({
      entryScript: null,
      version: "1.2.3",
      environment: { PATH: "/tools" },
      platform: "linux",
      executableExists: path => path === "/tools/bunx",
    }).resolveCommand();

    expect(launch).toEqual({
      command: "/tools/bunx",
      args: ["-y", "@kaeawc/auto-mobile@1.2.3", "--daemon-mode"],
    });
  });

  test("rejects unknown versions instead of falling back to latest", () => {
    expect(() => new DaemonLauncher({
      entryScript: null,
      version: "unknown",
      environment: { PATH: "/tools" },
      executableExists: () => true,
    }).resolveCommand()).toThrow(
      "current package version is unknown"
    );
  });

  test("strips a dev git-SHA stamp so the bunx specifier is an installable release", () => {
    // A dev build reports e.g. "0.0.39+g1a2b3c4.dirty"; that is not an installable
    // npm tag, so the bunx fallback must pin the published release portion.
    const launch = new DaemonLauncher({
      entryScript: null,
      version: "0.0.39+g1a2b3c4d5e6f.dirty.abc123def456",
      environment: { PATH: "/tools" },
      platform: "linux",
      executableExists: () => true,
    }).resolveCommand();

    expect(launch).toEqual({
      command: "/tools/bunx",
      args: ["-y", "@kaeawc/auto-mobile@0.0.39", "--daemon-mode"],
    });
  });
});

describe("Daemon manager process detection", () => {
  // Tests that reach manager.start() open a daemon launch log; keep it inside the
  // per-test temp dir (set via AUTOMOBILE_DATA_DIR) rather than the real
  // `~/.auto-mobile/logs` default (see tempDir.resolveAutoMobileBaseDir).
  afterEach(() => {
    delete process.env.AUTOMOBILE_DATA_DIR;
  });

  test("parses daemon processes from ps pid ppid command output", () => {
    const records = parseDaemonProcessTable(`
      10     1 /usr/bin/unrelated --daemon-mode
      20     1 /bin/sh -c "bun /worktree/dist/src/index.js --daemon-mode"
      21    20 bun /worktree/dist/src/index.js --daemon-mode
      22     1 bun /worktree/dist/src/index.js
      30     1 bunx -y @kaeawc/auto-mobile@0.0.38 --daemon-mode
    `);

    expect(records).toEqual([
      {
        pid: 20,
        ppid: 1,
        command: `/bin/sh -c "bun /worktree/dist/src/index.js --daemon-mode"`,
      },
      {
        pid: 21,
        ppid: 20,
        command: "bun /worktree/dist/src/index.js --daemon-mode",
      },
      {
        pid: 30,
        ppid: 1,
        command: "bunx -y @kaeawc/auto-mobile@0.0.38 --daemon-mode",
      },
    ]);
  });

  test("uses an expanded buffer when reading the full process table", () => {
    const calls: Array<{
      command: string;
      options: { encoding: "utf-8"; maxBuffer: number };
    }> = [];
    const finder = new PsDaemonProcessFinder((command, options) => {
      calls.push({ command, options });
      return "20 1 bunx -y @kaeawc/auto-mobile@0.0.38 --daemon-mode";
    });

    expect(finder.findDaemonProcesses()).toEqual([
      {
        pid: 20,
        ppid: 1,
        command: "bunx -y @kaeawc/auto-mobile@0.0.38 --daemon-mode",
      },
    ]);
    expect(calls).toEqual([
      {
        command: "ps -eo pid=,ppid=,command=",
        options: {
          encoding: "utf-8",
          maxBuffer: DAEMON_PROCESS_TABLE_MAX_BUFFER_BYTES,
        },
      },
    ]);
    expect(DAEMON_PROCESS_TABLE_MAX_BUFFER_BYTES).toBeGreaterThan(1024 * 1024);
  });

  test("parses daemon processes from Windows PowerShell JSON output", () => {
    const finder = new WindowsDaemonProcessFinder(() => JSON.stringify([
      {
        ProcessId: 10,
        ParentProcessId: 1,
        CommandLine: "C:\\\\Windows\\\\System32\\\\cmd.exe /c unrelated --daemon-mode",
      },
      {
        ProcessId: 20,
        ParentProcessId: 1,
        CommandLine: "bunx -y @kaeawc/auto-mobile@0.0.38 --daemon-mode",
      },
      {
        ProcessId: 21,
        ParentProcessId: 20,
        CommandLine: "C:\\\\Program Files\\\\nodejs\\\\node.exe C:\\\\repo\\\\dist\\\\src\\\\index.js --daemon-mode",
      },
      {
        ProcessId: 22,
        ParentProcessId: 1,
        CommandLine: null,
      },
    ]));

    expect(finder.findDaemonProcesses()).toEqual([
      {
        pid: 20,
        ppid: 1,
        command: "bunx -y @kaeawc/auto-mobile@0.0.38 --daemon-mode",
      },
      {
        pid: 21,
        ppid: 20,
        command: "C:\\\\Program Files\\\\nodejs\\\\node.exe C:\\\\repo\\\\dist\\\\src\\\\index.js --daemon-mode",
      },
    ]);
  });

  test("uses a Windows-native process table command with the expanded buffer", () => {
    const calls: Array<{
      command: string;
      options: { encoding: "utf-8"; maxBuffer: number };
    }> = [];
    const finder = new WindowsDaemonProcessFinder((command, options) => {
      calls.push({ command, options });
      return JSON.stringify({
        ProcessId: 30,
        ParentProcessId: 1,
        CommandLine: "bunx -y @kaeawc/auto-mobile@0.0.38 --daemon-mode",
      });
    });

    expect(finder.findDaemonProcesses()).toEqual([
      {
        pid: 30,
        ppid: 1,
        command: "bunx -y @kaeawc/auto-mobile@0.0.38 --daemon-mode",
      },
    ]);
    expect(calls).toEqual([
      {
        command: "powershell.exe -NoProfile -NonInteractive -Command \"Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress\"",
        options: {
          encoding: "utf-8",
          maxBuffer: DAEMON_PROCESS_TABLE_MAX_BUFFER_BYTES,
        },
      },
    ]);
  });

  test("selects Windows process detection by platform", () => {
    expect(createDefaultDaemonProcessFinder("win32")).toBeInstanceOf(WindowsDaemonProcessFinder);
    expect(createDefaultDaemonProcessFinder("linux")).toBeInstanceOf(PsDaemonProcessFinder);
  });

  function managerWithProcesses(
    records: DaemonProcessRecord[],
    options: { livePids?: Set<number>; pidFilePath?: string } = {}
  ): DaemonManager {
    return new DaemonManager(
      undefined,
      undefined,
      undefined,
      undefined,
      options.pidFilePath,
      undefined,
      new FakeDaemonProcessFinder(records, options.livePids),
      undefined
    );
  }

  function writeDaemonPidFile(pidFilePath: string, pid: number): void {
    writeFileSync(pidFilePath, JSON.stringify({
      pid,
      socketPath: "/tmp/auto-mobile-test.sock",
      port: 3000,
      startedAt: 1,
      version: "test",
    }));
  }

  test("reports a shell-launched daemon once using the long-lived daemon child PID", () => {
    const manager = managerWithProcesses([
      {
        pid: 100,
        ppid: 1,
        command: `/bin/sh -c "${process.execPath} /tmp/auto-mobile/dist/src/index.js --daemon-mode"`,
      },
      {
        pid: 101,
        ppid: 100,
        command: `${process.execPath} /tmp/auto-mobile/dist/src/index.js --daemon-mode`,
      },
    ]);

    expect(manager.findAllDaemonProcesses()).toEqual([101]);
  });

  test("reports Windows shell-launched daemons once using the long-lived child PID", () => {
    const manager = managerWithProcesses([
      {
        pid: 100,
        ppid: 1,
        command: `C:\\\\Windows\\\\System32\\\\cmd.exe /d /s /c "${process.execPath} C:\\\\repo\\\\dist\\\\src\\\\index.js --daemon-mode"`,
      },
      {
        pid: 101,
        ppid: 100,
        command: `${process.execPath} C:\\\\repo\\\\dist\\\\src\\\\index.js --daemon-mode`,
      },
      {
        pid: 200,
        ppid: 1,
        command: `C:\\\\Windows\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe -NoProfile -Command "${process.execPath} C:\\\\repo\\\\dist\\\\src\\\\index.js --daemon-mode"`,
      },
      {
        pid: 201,
        ppid: 200,
        command: `${process.execPath} C:\\\\repo\\\\dist\\\\src\\\\index.js --daemon-mode`,
      },
    ]);

    expect(manager.findAllDaemonProcesses()).toEqual([101, 201]);
  });

  test("does not report the current daemon's shell wrapper as another daemon", () => {
    const manager = managerWithProcesses([
      {
        pid: 100,
        ppid: 1,
        command: `/bin/sh -c "${process.execPath} /tmp/auto-mobile/dist/src/index.js --daemon-mode"`,
      },
      {
        pid: process.pid,
        ppid: 100,
        command: `${process.execPath} /tmp/auto-mobile/dist/src/index.js --daemon-mode`,
      },
    ]);

    expect(manager.findAllDaemonProcesses()).toEqual([]);
  });

  test("filters the active daemon PID while preserving distinct live daemons", () => {
    const dir = mkdtempSync(join(tmpdir(), "daemon-manager-pid-file-test-"));
    const pidFilePath = join(dir, "daemon.pid");
    writeDaemonPidFile(pidFilePath, 201);
    const manager = managerWithProcesses([
      {
        pid: 200,
        ppid: 1,
        command: `/bin/sh -c "bun /worktree-a/dist/src/index.js --daemon-mode"`,
      },
      {
        pid: 201,
        ppid: 200,
        command: `bun /worktree-a/dist/src/index.js --daemon-mode`,
      },
      {
        pid: 300,
        ppid: 1,
        command: `/bin/sh -c "bun /worktree-b/dist/src/index.js --daemon-mode"`,
      },
      {
        pid: 301,
        ppid: 300,
        command: `bun /worktree-b/dist/src/index.js --daemon-mode`,
      },
    ], { livePids: new Set([201, 301]), pidFilePath });

    try {
      expect(manager.findOtherDaemonProcesses(201)).toEqual([301]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("excludes transient daemon-mode candidates that are gone by liveness re-check", () => {
    const dir = mkdtempSync(join(tmpdir(), "daemon-manager-transient-test-"));
    const pidFilePath = join(dir, "daemon.pid");
    writeDaemonPidFile(pidFilePath, 201);
    const manager = managerWithProcesses([
      {
        pid: 201,
        ppid: 200,
        command: `bun /worktree-a/dist/src/index.js --daemon-mode`,
      },
      {
        pid: 401,
        ppid: 1,
        command: `bun /worktree-b/dist/src/index.js --daemon-mode`,
      },
    ], { livePids: new Set([201]), pidFilePath });

    try {
      expect(manager.findOtherDaemonProcesses(201)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ignores daemon-mode candidates that are gone by liveness re-check", () => {
    const dir = mkdtempSync(join(tmpdir(), "daemon-manager-liveness-test-"));
    const pidFilePath = join(dir, "daemon.pid");
    writeDaemonPidFile(pidFilePath, 401);
    const manager = managerWithProcesses([
      {
        pid: 201,
        ppid: 200,
        command: `bun /worktree-a/dist/src/index.js --daemon-mode`,
      },
      {
        pid: 401,
        ppid: 1,
        command: `bun /worktree-a/dist/src/index.js --daemon-mode`,
      },
    ], { livePids: new Set([201]), pidFilePath });

    try {
      expect(manager.findOtherDaemonProcesses(201)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fails closed when the process table cannot be inspected", () => {
    const manager = new DaemonManager(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        findDaemonProcesses() {
          throw new Error("spawn ENOBUFS");
        },
      }
    );

    expect(() => manager.findAllDaemonProcesses()).toThrow("Failed to inspect daemon process table: spawn ENOBUFS");
  });

  test("start reuses a responsive live daemon when its PID record is unavailable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "daemon-manager-takeover-test-"));
    process.env.AUTOMOBILE_DATA_DIR = dir;
    const pidFilePath = join(dir, "daemon.pid");
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const killCalls: Array<{ pid: number; signal: NodeJS.Signals | number | undefined }> = [];
    let spawnCalls = 0;
    const processFinder = new FakeDaemonProcessFinder([
      {
        pid: 301,
        ppid: 1,
        command: `bun /worktree-b/dist/src/index.js --daemon-mode`,
      },
    ], new Set([301]));
    const processSpawner: DaemonProcessSpawner = {
      spawn: (_command: string, _args: string[], _options: SpawnOptions) => ({
        get unref() {
          spawnCalls++;
          return () => {};
        },
        once() { return this; },
        off() { return this; },
      }) as ChildProcess,
    };
    const killSpy = spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === 301) {
        killCalls.push({ pid, signal });
      }
      return true;
    }) as typeof process.kill);

    class TestDaemonManager extends DaemonManager {
      override async status(): Promise<any> {
        return { running: false };
      }

      override async waitForReady(_timeout: number): Promise<boolean> {
        return true;
      }
    }

    try {
      const manager = new TestDaemonManager(
        () => new FakeDaemonClient({}),
        undefined,
        fakeTimer,
        join(dir, "daemon.lock"),
        pidFilePath,
        join(dir, "daemon.sock"),
        processFinder,
        processSpawner
      );

      await manager.start();

      expect(killCalls).toEqual([]);
      expect(spawnCalls).toBe(0);
    } finally {
      killSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("start refuses to signal a live daemon that never becomes reachable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "daemon-manager-takeover-revalidate-test-"));
    process.env.AUTOMOBILE_DATA_DIR = dir;
    const pidFilePath = join(dir, "daemon.pid");
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const killCalls: Array<{ pid: number; signal: NodeJS.Signals | number | undefined }> = [];
    const processFinder: DaemonProcessFinder & DaemonProcessLivenessChecker = {
      findDaemonProcesses() {
        return [{
          pid: 301,
          ppid: 1,
          command: `bun /worktree-b/dist/src/index.js --daemon-mode`,
        }];
      },
      isProcessRunning(pid: number) {
        return pid === 301;
      },
    };
    const processSpawner: DaemonProcessSpawner = {
      spawn: () => {
        throw new Error("should not spawn while a live daemon exists");
      },
    };
    const killSpy = spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === 301) {
        killCalls.push({ pid, signal });
      }
      return true;
    }) as typeof process.kill);

    class TestDaemonManager extends DaemonManager {
      override async status(): Promise<any> {
        return { running: false };
      }

      override async waitForReady(_timeout: number): Promise<boolean> {
        return true;
      }
    }

    try {
      const manager = new TestDaemonManager(
        () => ({
          async connect() {
            throw new Error("connection refused");
          },
          async close() {},
          async callTool() {
            return {};
          },
          async readResource() {
            return {};
          },
          async callDaemonMethod() {
            return {};
          },
        }),
        undefined,
        fakeTimer,
        join(dir, "daemon.lock"),
        pidFilePath,
        join(dir, "daemon.sock"),
        processFinder,
        processSpawner
      );

      await expect(manager.start()).rejects.toThrow(
        "Refusing to terminate a live daemon during start"
      );

      expect(killCalls).toEqual([]);
    } finally {
      killSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("start takeover does not signal transient daemon-mode candidates that are gone by liveness re-check", async () => {
    const dir = mkdtempSync(join(tmpdir(), "daemon-manager-transient-takeover-test-"));
    process.env.AUTOMOBILE_DATA_DIR = dir;
    const pidFilePath = join(dir, "daemon.pid");
    writeDaemonPidFile(pidFilePath, 201);
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const killCalls: Array<{ pid: number; signal: NodeJS.Signals | number | undefined }> = [];
    const processFinder = new FakeDaemonProcessFinder([
      {
        pid: 401,
        ppid: 1,
        command: `bun /worktree-b/dist/src/index.js --daemon-mode`,
      },
    ], new Set());
    const processSpawner: DaemonProcessSpawner = {
      spawn: (_command: string, _args: string[], _options: SpawnOptions) => ({
        unref() {},
        once() { return this; },
        off() { return this; },
      }) as ChildProcess,
    };
    const killSpy = spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === 401) {
        killCalls.push({ pid, signal });
      }
      return true;
    }) as typeof process.kill);

    class TestDaemonManager extends DaemonManager {
      override async status(): Promise<any> {
        return { running: false };
      }

      override async waitForReady(_timeout: number): Promise<boolean> {
        return true;
      }
    }

    try {
      const manager = new TestDaemonManager(
        undefined,
        undefined,
        fakeTimer,
        join(dir, "daemon.lock"),
        pidFilePath,
        join(dir, "daemon.sock"),
        processFinder,
        processSpawner
      );

      await manager.start();

      expect(killCalls).toEqual([]);
    } finally {
      killSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("surfaces incomplete-extraction remediation when daemon exits with exit code 75", async () => {
    const dir = mkdtempSync(join(tmpdir(), "daemon-manager-incomplete-extraction-message-test-"));
    process.env.AUTOMOBILE_DATA_DIR = dir;
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const entryScript = join(
      dir,
      "bunx-extract",
      "node_modules",
      "@kaeawc",
      "auto-mobile",
      "dist",
      "src",
      "index.js"
    );
    const child = new FakeDaemonChildProcess();
    const processSpawner: DaemonProcessSpawner = {
      spawn: () => child as ChildProcess,
    };
    const cleaner = new FakeExtractionCleaner();

    class TestDaemonManager extends DaemonManager {
      override async status(): Promise<any> {
        return { running: false };
      }

      override async waitForReady(_timeout: number, signal?: AbortSignal): Promise<boolean> {
        await Promise.resolve();
        if (!signal?.aborted) {
          return neverReadyAfterExit(child, 75);
        }
        return false;
      }
    }

    try {
      const manager = new TestDaemonManager(
        undefined,
        undefined,
        fakeTimer,
        join(dir, "daemon.lock"),
        join(dir, "daemon.pid"),
        join(dir, "daemon.sock"),
        new FakeDaemonProcessFinder([]),
        processSpawner,
        cleaner,
        () => ({ command: process.execPath, args: [entryScript, "--daemon-mode"] })
      );

      await expect(manager.start()).rejects.toThrow("remove the incomplete extraction directory and re-run");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("removes an incomplete extraction and retries once after exit code 75", async () => {
    const dir = mkdtempSync(join(tmpdir(), "daemon-manager-incomplete-extraction-retry-test-"));
    process.env.AUTOMOBILE_DATA_DIR = dir;
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const entryScript = join(
      dir,
      "bunx-extract",
      "node_modules",
      "@kaeawc",
      "auto-mobile",
      "dist",
      "src",
      "index.js"
    );
    const children: FakeDaemonChildProcess[] = [];
    const spawnCalls: Array<{ command: string; args: string[] }> = [];
    const processSpawner: DaemonProcessSpawner = {
      spawn: (command: string, args: string[]) => {
        const child = new FakeDaemonChildProcess();
        children.push(child);
        spawnCalls.push({ command, args: [...args] });
        return child as ChildProcess;
      },
    };
    const cleaner = new FakeExtractionCleaner();
    let waitCalls = 0;

    class TestDaemonManager extends DaemonManager {
      override async status(): Promise<any> {
        return { running: false };
      }

      override async waitForReady(_timeout: number, signal?: AbortSignal): Promise<boolean> {
        waitCalls++;
        await Promise.resolve();
        if (waitCalls === 1 && !signal?.aborted) {
          return neverReadyAfterExit(children[0], 75);
        }
        return true;
      }
    }

    try {
      const manager = new TestDaemonManager(
        undefined,
        undefined,
        fakeTimer,
        join(dir, "daemon.lock"),
        join(dir, "daemon.pid"),
        join(dir, "daemon.sock"),
        new FakeDaemonProcessFinder([]),
        processSpawner,
        cleaner,
        () => ({ command: process.execPath, args: [entryScript, "--daemon-mode"] })
      );

      await manager.start({ port: 1234 });

      expect(children).toHaveLength(2);
      expect(spawnCalls[0].args).toContain(entryScript);
      expect(spawnCalls[0].args).toContain("--port");
      expect(spawnCalls[1].args).not.toContain(entryScript);
      expect(spawnCalls[1].args).toContain("--port");
      expect(cleaner.entryScripts).toEqual([entryScript]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("default extraction cleaner removes only the temporary extraction root", async () => {
    const dir = mkdtempSync(join(tmpdir(), "daemon-manager-default-extraction-cleaner-test-"));
    const dataDir = join(dir, "data");
    process.env.AUTOMOBILE_DATA_DIR = dataDir;
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const extractionRoot = join(dir, "bunx-extract");
    const packageDir = join(
      extractionRoot,
      "node_modules",
      "@kaeawc",
      "auto-mobile",
      "dist",
      "src"
    );
    mkdirSync(packageDir, { recursive: true });
    const entryScript = join(packageDir, "index.js");
    writeFileSync(entryScript, "");
    const children: FakeDaemonChildProcess[] = [];
    const spawnCalls: Array<{ command: string; args: string[] }> = [];
    const processSpawner: DaemonProcessSpawner = {
      spawn: (command: string, args: string[]) => {
        const child = new FakeDaemonChildProcess();
        children.push(child);
        spawnCalls.push({ command, args: [...args] });
        return child as ChildProcess;
      },
    };
    let waitCalls = 0;

    class TestDaemonManager extends DaemonManager {
      override async status(): Promise<any> {
        return { running: false };
      }

      override async waitForReady(_timeout: number, signal?: AbortSignal): Promise<boolean> {
        waitCalls++;
        await Promise.resolve();
        if (waitCalls === 1 && !signal?.aborted) {
          return neverReadyAfterExit(children[0], 75);
        }
        return true;
      }
    }

    try {
      const manager = new TestDaemonManager(
        undefined,
        undefined,
        fakeTimer,
        join(dataDir, "daemon.lock"),
        join(dataDir, "daemon.pid"),
        join(dataDir, "daemon.sock"),
        new FakeDaemonProcessFinder([]),
        processSpawner,
        undefined,
        () => ({ command: process.execPath, args: [entryScript, "--daemon-mode"] })
      );

      await manager.start();

      expect(children).toHaveLength(2);
      expect(spawnCalls[0].args).toContain(entryScript);
      expect(spawnCalls[1].args).not.toContain(entryScript);
      expect(existsSync(extractionRoot)).toBe(false);
      expect(existsSync(dataDir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("gives up with remediation when the retry exits with exit code 75 again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "daemon-manager-incomplete-extraction-give-up-test-"));
    process.env.AUTOMOBILE_DATA_DIR = dir;
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const entryScript = join(
      dir,
      "bunx-extract",
      "node_modules",
      "@kaeawc",
      "auto-mobile",
      "dist",
      "src",
      "index.js"
    );
    const children: FakeDaemonChildProcess[] = [];
    const processSpawner: DaemonProcessSpawner = {
      spawn: () => {
        const child = new FakeDaemonChildProcess();
        children.push(child);
        return child as ChildProcess;
      },
    };
    const cleaner = new FakeExtractionCleaner();

    class TestDaemonManager extends DaemonManager {
      override async status(): Promise<any> {
        return { running: false };
      }

      override async waitForReady(_timeout: number, signal?: AbortSignal): Promise<boolean> {
        await Promise.resolve();
        if (!signal?.aborted) {
          return neverReadyAfterExit(children[children.length - 1], 75);
        }
        return false;
      }
    }

    try {
      const manager = new TestDaemonManager(
        undefined,
        undefined,
        fakeTimer,
        join(dir, "daemon.lock"),
        join(dir, "daemon.pid"),
        join(dir, "daemon.sock"),
        new FakeDaemonProcessFinder([]),
        processSpawner,
        cleaner,
        () => ({ command: process.execPath, args: [entryScript, "--daemon-mode"] })
      );

      await expect(manager.start()).rejects.toThrow("remove the incomplete extraction directory and re-run");
      expect(children).toHaveLength(2);
      expect(cleaner.entryScripts).toEqual([entryScript]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("does not remove or retry for non-incomplete-extraction daemon exits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "daemon-manager-generic-exit-test-"));
    process.env.AUTOMOBILE_DATA_DIR = dir;
    const fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();
    const child = new FakeDaemonChildProcess();
    const processSpawner: DaemonProcessSpawner = {
      spawn: () => child as ChildProcess,
    };
    const cleaner = new FakeExtractionCleaner();

    class TestDaemonManager extends DaemonManager {
      override async status(): Promise<any> {
        return { running: false };
      }

      override async waitForReady(_timeout: number, signal?: AbortSignal): Promise<boolean> {
        await Promise.resolve();
        if (!signal?.aborted) {
          return neverReadyAfterExit(child, 1);
        }
        return false;
      }
    }

    try {
      const manager = new TestDaemonManager(
        undefined,
        undefined,
        fakeTimer,
        join(dir, "daemon.lock"),
        join(dir, "daemon.pid"),
        join(dir, "daemon.sock"),
        new FakeDaemonProcessFinder([]),
        processSpawner,
        cleaner,
        () => ({ command: process.execPath, args: [join(dir, "entry.js"), "--daemon-mode"] })
      );

      await expect(manager.start()).rejects.toThrow("Daemon subprocess exited before becoming ready (exit code 1)");
      expect(cleaner.entryScripts).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Daemon manager available-devices", () => {
  test("queries the booted devices resource when daemon is not initialized", async () => {
    const result = {
      contents: [
        {
          text: JSON.stringify({
            poolStatus: {
              idle: 2,
              assigned: 1,
              error: 0,
              total: 3,
              recoveryPolicy: { onLoss: true, maxAttempts: 2 },
            },
            devices: [{
              deviceId: "emulator-5554",
              platform: "android",
              recoveryEligibility: { eligible: true, action: "restart" },
            }],
          })
        }
      ]
    };
    const fakeClient = new FakeDaemonClient(result);
    const output: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...args) => {
      output.push(args.join(" "));
    });

    try {
      await runDaemonCommand("available-devices", [], {
        clientFactory: () => fakeClient,
        stateProvider: () => ({
          isInitialized: () => false,
          getDevicePool: () => {
            throw new Error("Device pool unavailable");
          },
          getSessionManager: () => {
            throw new Error("Session manager unavailable");
          },
          getDeviceSessionRegistry: () => {
            throw new Error("Device session registry unavailable");
          }
        } satisfies DaemonStateLike)
      });
    } finally {
      logSpy.mockRestore();
    }

    expect(fakeClient.readResourceCalls).toEqual(["automobile:devices/booted"]);
    expect(fakeClient.callToolCalls).toHaveLength(0);
    expect(output).toContain(JSON.stringify({
      availableDevices: 2,
      totalDevices: 3,
      assignedDevices: 1,
      errorDevices: 0,
      recoveryPolicy: { onLoss: true, maxAttempts: 2 },
      devices: [{
        deviceId: "emulator-5554",
        platform: "android",
        recoveryEligibility: { eligible: true, action: "restart" },
      }],
    }));
  });

  test("uses daemon state pool stats when initialized", async () => {
    const fakeClient = new FakeDaemonClient({});
    const output: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...args) => {
      output.push(args.join(" "));
    });

    const fakeState: DaemonStateLike = {
      isInitialized: () => true,
      getDevicePool: () => ({
        getStats: () => ({
          idle: 1,
          assigned: 2,
          error: 1,
          total: 4
        }),
        getRecoveryPolicy: () => ({ onLoss: false, maxAttempts: 2 }),
        getAllDevices: () => [{
          id: "physical-ios-device",
          platform: "ios",
        }],
        getRecoveryEligibility: () => ({ eligible: false, reason: "unsupported-platform" }),
      } as any),
      getSessionManager: () => ({
        getSession: () => null,
        releaseSession: async () => null
      } as any),
      getDeviceSessionRegistry: () => new DeviceSessionRegistry()
    };

    try {
      await runDaemonCommand("available-devices", [], {
        clientFactory: () => fakeClient,
        stateProvider: () => fakeState
      });
    } finally {
      logSpy.mockRestore();
    }

    expect(fakeClient.readResourceCalls).toHaveLength(0);
    expect(output).toContain(JSON.stringify({
      availableDevices: 1,
      totalDevices: 4,
      assignedDevices: 2,
      errorDevices: 1,
      recoveryPolicy: { onLoss: false, maxAttempts: 2 },
      devices: [{
        deviceId: "physical-ios-device",
        platform: "ios",
        recoveryEligibility: { eligible: false, reason: "unsupported-platform" },
      }],
    }));
  });
});
