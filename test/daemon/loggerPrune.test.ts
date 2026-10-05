import { describe, expect, test, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { mkdtempSync, writeFileSync, readdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pruneLogFiles, type LogRetentionNamespaceSource } from "../../src/utils/logPruner";
import {
  logRetentionNamespaces,
  registerLogRetentionNamespaceSource,
  resetLogRetentionNamespaceSourceForTesting,
  flushLogRetentionStartupSweepForTesting,
} from "../../src/utils/logger";
import * as processLiveness from "../../src/utils/processLiveness";
import { FakeTimer } from "../fakes/FakeTimer";

/**
 * Tests the REAL prune used by logger.ts (src/utils/logPruner.ts), which is
 * multi-process safe: it caps only the current process's own files (matched on
 * an exact PID boundary) and sweeps other processes' files only when their owner
 * has EXITED and the file is stale by mtime — never another live process's file.
 */
describe("pruneLogFiles", () => {
  const tempDirs: string[] = [];
  const dead = () => false; // no peer process is alive in these tests unless stated

  function createTempLogsDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "logger-prune-test-"));
    tempDirs.push(dir);
    return dir;
  }

  beforeEach(async () => {
    // The preload can start the real sweep before this suite loads. Reset only
    // cancels queued work; drain an in-flight directory read before swapping readers.
    await flushLogRetentionStartupSweepForTesting();
    resetLogRetentionNamespaceSourceForTesting();
  });

  afterEach(async () => {
    // Keep an unfinished sweep from consulting the next test's namespace source.
    await flushLogRetentionStartupSweepForTesting();
    resetLogRetentionNamespaceSourceForTesting();
    for (const dir of tempDirs) {
      try {
        const { rmSync } = require("node:fs");
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    tempDirs.length = 0;
  });

  function fakeNamespaceSource(): LogRetentionNamespaceSource {
    return {
      listDaemonPidFilesSync: mock(() => ({ pidFiles: ["peer.pid"], uncertain: false })),
      readPidFileDataSync: mock(() => ({ pid: 333 })),
      readDaemonOwnerForRetentionSync: mock(() => ({ pid: 333, launchLogPath: null })),
      readDaemonLaunchLogOwnerTombstoneSync: mock(() => undefined),
    };
  }

  function startupFixture(isProcessAlive: (pid: number) => boolean = dead) {
    const dir = createTempLogsDir();
    const timer = new FakeTimer();
    timer.setCurrentTime(1_800_000_000_000);
    const launchLog = join(dir, "daemon-launch-222.log");
    writeFileSync(launchLog, "three-day-old launch log");
    const staleTime = new Date(timer.now() - 3 * 24 * 60 * 60 * 1000);
    utimesSync(launchLog, staleTime, staleTime);
    const source = fakeNamespaceSource();
    source.readDaemonOwnerForRetentionSync = mock(() => ({ pid: 333, launchLogPath: launchLog }));
    const sweep = () =>
      pruneLogFiles({
        dir,
        ownPrefix: "stdio-111",
        maxOwnFiles: 10,
        abandonedMaxAgeMs: 24 * 60 * 60 * 1000,
        now: timer.now(),
        isProcessAlive,
        sleep: (ms) => timer.sleep(ms),
        ...logRetentionNamespaces,
      });
    const prune = mock(sweep);
    resetLogRetentionNamespaceSourceForTesting({ timer, prune });
    return { dir, timer, staleTime, source, prune, sweep };
  }

  test("startup keeps its zero-delay timer ref'd and prunes after registration", async () => {
    const { timer, source, prune } = startupFixture((pid) => pid === 333);
    const scheduleTimeout = timer.setTimeout.bind(timer);
    const cancelTimeout = timer.clearTimeout.bind(timer);
    const handles = new Map<NodeJS.Timeout, NodeJS.Timeout>();
    const unref = mock(function (this: NodeJS.Timeout) {
      return this;
    });
    spyOn(timer, "setTimeout").mockImplementation((callback, ms) => {
      const handle = { unref } as NodeJS.Timeout;
      handles.set(handle, scheduleTimeout(callback, ms));
      return handle;
    });
    spyOn(timer, "clearTimeout").mockImplementation((handle) => {
      cancelTimeout(handles.get(handle) ?? handle);
      handles.delete(handle);
    });
    resetLogRetentionNamespaceSourceForTesting({ timer, prune });

    expect(timer.getPendingTimeouts()).toEqual([0]);
    // Guard against a fast process exiting before the startup sweep starts.
    expect(unref).not.toHaveBeenCalled();
    expect(prune).not.toHaveBeenCalled();
    registerLogRetentionNamespaceSource(source);
    expect(prune).not.toHaveBeenCalled();
    expect(source.listDaemonPidFilesSync).not.toHaveBeenCalled();
    timer.advanceTime(0);
    await flushLogRetentionStartupSweepForTesting();
    expect(prune).toHaveBeenCalledTimes(1);
    expect(source.readDaemonOwnerForRetentionSync).toHaveBeenCalledWith("peer.pid");
    expect(unref).not.toHaveBeenCalled();
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("startup defers pruning until registration and applies live-owner readers", async () => {
    const { dir, timer, source, prune } = startupFixture((pid) => pid === 333);
    await flushLogRetentionStartupSweepForTesting();
    expect(prune).not.toHaveBeenCalled();
    expect(source.listDaemonPidFilesSync).not.toHaveBeenCalled();
    registerLogRetentionNamespaceSource(source);
    // Registration never discovers namespaces in the module-evaluation stack.
    expect(prune).not.toHaveBeenCalled();
    expect(source.listDaemonPidFilesSync).not.toHaveBeenCalled();
    timer.advanceTime(0);
    await flushLogRetentionStartupSweepForTesting();
    expect(prune).toHaveBeenCalledTimes(1);
    expect(source.readDaemonOwnerForRetentionSync).toHaveBeenCalledWith("peer.pid");
    expect(readdirSync(dir)).toContain("daemon-launch-222.log");
  });

  test("fallback before registration retains a launch log later identified as live", async () => {
    const { dir, timer, source } = startupFixture((pid) => pid === 333);
    timer.advanceTime(0);
    await flushLogRetentionStartupSweepForTesting();
    expect(source.readDaemonOwnerForRetentionSync).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toContain("daemon-launch-222.log");
    registerLogRetentionNamespaceSource(source);
    timer.advanceTime(0);
    await flushLogRetentionStartupSweepForTesting();
    expect(source.readDaemonOwnerForRetentionSync).toHaveBeenCalledWith("peer.pid");
    expect(readdirSync(dir)).toContain("daemon-launch-222.log");
  });

  test("late registration prunes a three-day-old launch log with a dead-owner PID record", async () => {
    const { dir, timer, source, prune } = startupFixture();
    timer.advanceTime(0);
    await flushLogRetentionStartupSweepForTesting();
    expect(readdirSync(dir)).toContain("daemon-launch-222.log");
    registerLogRetentionNamespaceSource(source);
    timer.advanceTime(0);
    await flushLogRetentionStartupSweepForTesting();
    expect(source.readDaemonOwnerForRetentionSync).toHaveBeenCalledWith("peer.pid");
    expect(readdirSync(dir)).not.toContain("daemon-launch-222.log");
    expect(prune).toHaveBeenCalledTimes(2); // fallback, then registered sweep
  });

  test("unregistered bounded fallback preserves own-file cap and stale-file retention", async () => {
    const { dir, timer, staleTime, prune } = startupFixture();
    for (let i = 0; i < 15; i++) {
      writeFileSync(join(dir, `stdio-111-${String(i).padStart(2, "0")}.log`), "backup");
    }
    writeFileSync(join(dir, "stdio-111.log"), "active");
    const stalePeerLog = join(dir, "stdio-444.log");
    writeFileSync(stalePeerLog, "abandoned");
    utimesSync(stalePeerLog, staleTime, staleTime);
    const recentPeerLog = join(dir, "stdio-555.log");
    writeFileSync(recentPeerLog, "recent");
    const recentTime = new Date(timer.now());
    utimesSync(recentPeerLog, recentTime, recentTime);
    expect(prune).not.toHaveBeenCalled();
    timer.advanceTime(0);
    await flushLogRetentionStartupSweepForTesting();
    const files = readdirSync(dir);
    expect(files.filter((file) => file.startsWith("stdio-111"))).toHaveLength(10);
    expect(files).toContain("stdio-111.log");
    expect(files).not.toContain("stdio-444.log");
    expect(files).toContain("stdio-555.log");
    expect(files).toContain("daemon-launch-222.log");
    expect(prune).toHaveBeenCalledTimes(1);
  });

  test("repeated registration replaces readers but runs exactly one startup sweep", async () => {
    const { timer, source, prune } = startupFixture();
    const replacement = fakeNamespaceSource();
    registerLogRetentionNamespaceSource(source);
    registerLogRetentionNamespaceSource(replacement);
    timer.advanceTime(0);
    await flushLogRetentionStartupSweepForTesting();
    expect(prune).toHaveBeenCalledTimes(1);
    expect(source.listDaemonPidFilesSync).not.toHaveBeenCalled();
    expect(replacement.listDaemonPidFilesSync).toHaveBeenCalledTimes(1);
    registerLogRetentionNamespaceSource(source);
    timer.advanceTime(0);
    await flushLogRetentionStartupSweepForTesting();
    expect(prune).toHaveBeenCalledTimes(1);
    expect(logRetentionNamespaces.readDaemonOwner("peer.pid")).toEqual(
      source.readDaemonOwnerForRetentionSync("peer.pid"),
    );
  });

  test("registration follows an in-flight fallback once instead of skipping or overlapping", async () => {
    const { dir, timer, source, prune, sweep } = startupFixture();
    const fallbackFinished = Promise.withResolvers<void>();
    const releaseFallback = Promise.withResolvers<void>();
    prune.mockImplementationOnce(async () => {
      await sweep();
      fallbackFinished.resolve();
      await releaseFallback.promise;
    });
    timer.advanceTime(0);
    await fallbackFinished.promise;
    expect(readdirSync(dir)).toContain("daemon-launch-222.log");
    registerLogRetentionNamespaceSource(source);
    registerLogRetentionNamespaceSource(source);
    timer.advanceTime(0);
    expect(prune).toHaveBeenCalledTimes(1);
    releaseFallback.resolve();
    await flushLogRetentionStartupSweepForTesting();
    expect(prune).toHaveBeenCalledTimes(2);
    expect(readdirSync(dir)).not.toContain("daemon-launch-222.log");
  });

  test("logger retention delegates enumeration, liveness, owners and tombstones to its source", () => {
    const source = fakeNamespaceSource();
    registerLogRetentionNamespaceSource(source);
    const alive = spyOn(processLiveness, "isProcessRunning").mockReturnValue(true);
    try {
      expect(logRetentionNamespaces.daemonPidFiles()).toEqual({
        pidFiles: ["peer.pid"],
        uncertain: false,
      });
      expect(logRetentionNamespaces.isDaemonRunning()).toBe(true);
      expect(source.readPidFileDataSync).toHaveBeenCalledWith("peer.pid");
      expect(alive).toHaveBeenCalledWith(333);
      expect(logRetentionNamespaces.readDaemonOwner("peer.pid")).toEqual({
        pid: 333,
        launchLogPath: null,
      });
      expect(
        logRetentionNamespaces.readDaemonLaunchLogOwnerTombstone("launch.log"),
      ).toBeUndefined();
      expect(source.readDaemonOwnerForRetentionSync).toHaveBeenCalledWith("peer.pid");
      expect(source.readDaemonLaunchLogOwnerTombstoneSync).toHaveBeenCalledWith("launch.log");
    } finally {
      alive.mockRestore();
    }
  });

  test("unregistered logger retention fails closed and retains stale launch logs", async () => {
    resetLogRetentionNamespaceSourceForTesting();
    expect(logRetentionNamespaces.isDaemonRunning()).toBe(true);
    expect(logRetentionNamespaces.daemonPidFiles()).toEqual({ pidFiles: [], uncertain: true });
    expect(() => logRetentionNamespaces.readDaemonOwner("peer.pid")).toThrow("not registered");
    expect(() => logRetentionNamespaces.readDaemonLaunchLogOwnerTombstone("launch.log")).toThrow(
      "not registered",
    );
    const dir = createTempLogsDir();
    writeFileSync(join(dir, "daemon-launch-222.log"), "held fd");
    await pruneLogFiles({
      dir,
      ownPrefix: "stdio-111",
      maxOwnFiles: 10,
      abandonedMaxAgeMs: 0,
      now: Date.now() + 1e9,
      isProcessAlive: dead,
      ...logRetentionNamespaces,
    });
    expect(readdirSync(dir)).toContain("daemon-launch-222.log");
  });

  test("registered logger retention preserves live owners and ambiguous reads", async () => {
    const dir = createTempLogsDir();
    const launchLog = join(dir, "daemon-launch-222.log");
    writeFileSync(launchLog, "held fd");
    const source = fakeNamespaceSource();
    source.readDaemonOwnerForRetentionSync = () => ({ pid: 333, launchLogPath: launchLog });
    registerLogRetentionNamespaceSource(source);
    const sweep = () =>
      pruneLogFiles({
        dir,
        ownPrefix: "stdio-111",
        maxOwnFiles: 10,
        abandonedMaxAgeMs: 0,
        now: Date.now() + 1e9,
        isProcessAlive: (pid) => pid === 333,
        ...logRetentionNamespaces,
      });
    await sweep();
    expect(readdirSync(dir)).toContain("daemon-launch-222.log");
    source.readDaemonOwnerForRetentionSync = () => {
      throw new Error("unreadable PID");
    };
    await sweep();
    expect(readdirSync(dir)).toContain("daemon-launch-222.log");
    source.readDaemonOwnerForRetentionSync = () => undefined;
    source.readDaemonLaunchLogOwnerTombstoneSync = () => ({ pid: 333, launchLogPath: launchLog });
    await sweep();
    expect(readdirSync(dir)).toContain("daemon-launch-222.log");
    source.readDaemonLaunchLogOwnerTombstoneSync = () => {
      throw new Error("unreadable owner");
    };
    await sweep();
    expect(readdirSync(dir)).toContain("daemon-launch-222.log");
    expect(() => logRetentionNamespaces.readDaemonLaunchLogOwnerTombstone(launchLog)).toThrow(
      "unreadable owner",
    );
  });

  test("caps this process's own files and preserves the active stdio-<pid>.log", async () => {
    const logsDir = createTempLogsDir();
    for (let i = 0; i < 15; i++) {
      writeFileSync(join(logsDir, `stdio-111-2026-04-01T${String(i).padStart(2, "0")}.log`), "x");
    }
    writeFileSync(join(logsDir, "stdio-111.log"), "active");

    await pruneLogFiles({
      dir: logsDir,
      ownPrefix: "stdio-111",
      maxOwnFiles: 10,
      abandonedMaxAgeMs: 1e12,
      isProcessAlive: dead,
    });

    const remaining = readdirSync(logsDir).filter((f) => f.endsWith(".log"));
    expect(remaining.length).toBe(10);
    // "stdio-111.log" sorts after "stdio-111-..." so the active file survives.
    expect(remaining).toContain("stdio-111.log");
  });

  test("matches own files on an exact PID boundary (stdio-12 does not claim stdio-123)", async () => {
    const logsDir = createTempLogsDir();
    // This process is pid 12; a peer is pid 123 (a prefix collision under startsWith).
    for (let i = 0; i < 15; i++) {
      writeFileSync(join(logsDir, `stdio-12-${String(i).padStart(2, "0")}.log`), "x");
    }
    writeFileSync(join(logsDir, "stdio-12.log"), "active");
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(logsDir, `stdio-123-${i}.log`), "peer");
    }

    // Peer 123 is alive → must be untouched; own cap trims only pid-12 files.
    await pruneLogFiles({
      dir: logsDir,
      ownPrefix: "stdio-12",
      maxOwnFiles: 10,
      abandonedMaxAgeMs: 1_000,
      now: Date.now() + 1e9,
      isProcessAlive: (pid) => pid === 123,
    });

    const remaining = readdirSync(logsDir);
    const peerFiles = remaining.filter((f) => f.startsWith("stdio-123"));
    const ownFiles = remaining.filter((f) => /^stdio-12(\.log|-)/.test(f));
    expect(peerFiles.length).toBe(5); // peer's files never claimed/deleted
    expect(ownFiles.length).toBe(10); // only own pid-12 files capped
  });

  test("never deletes a LIVE peer's log even when its mtime is stale", async () => {
    const logsDir = createTempLogsDir();
    writeFileSync(join(logsDir, "stdio-222.log"), "quiet but alive");

    await pruneLogFiles({
      dir: logsDir,
      ownPrefix: "stdio-111",
      maxOwnFiles: 10,
      abandonedMaxAgeMs: 1_000,
      now: Date.now() + 1e9, // far future → mtime looks ancient
      isProcessAlive: (pid) => pid === 222, // owner still running
    });

    expect(readdirSync(logsDir)).toContain("stdio-222.log");
  });

  test("sweeps an EXITED process's stale log", async () => {
    const logsDir = createTempLogsDir();
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(logsDir, `stdio-222-${i}.log`), "x");
    }

    await pruneLogFiles({
      dir: logsDir,
      ownPrefix: "stdio-111",
      maxOwnFiles: 10,
      abandonedMaxAgeMs: 1_000,
      now: Date.now() + 60_000,
      isProcessAlive: dead,
    });

    expect(readdirSync(logsDir).filter((f) => f.startsWith("stdio-222")).length).toBe(0);
  });

  test("keeps an exited process's RECENT log (mtime grace before sweeping)", async () => {
    const logsDir = createTempLogsDir();
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(logsDir, `stdio-222-${i}.log`), "x");
    }
    const baseNow = Date.now();

    await pruneLogFiles({
      dir: logsDir,
      ownPrefix: "stdio-111",
      maxOwnFiles: 10,
      abandonedMaxAgeMs: 60_000,
      now: baseNow,
      isProcessAlive: dead,
    });

    expect(readdirSync(logsDir).filter((f) => f.startsWith("stdio-222")).length).toBe(5);
  });

  test("preserves daemon logs when pruning from a stdio process", async () => {
    const logsDir = createTempLogsDir();
    writeFileSync(join(logsDir, "daemon.log"), "active daemon");
    writeFileSync(join(logsDir, "daemon-2026-04-01T00.log"), "rotated daemon");

    await pruneLogFiles({
      dir: logsDir,
      ownPrefix: "stdio-111",
      maxOwnFiles: 10,
      abandonedMaxAgeMs: 1_000,
      now: Date.now() + 1e9,
      isProcessAlive: dead,
    });

    const remaining = readdirSync(logsDir);
    expect(remaining).toContain("daemon.log");
    expect(remaining).toContain("daemon-2026-04-01T00.log");
  });

  test("caps daemon logs and preserves the active daemon.log", async () => {
    const logsDir = createTempLogsDir();
    for (let i = 0; i < 15; i++) {
      writeFileSync(join(logsDir, `daemon-2026-04-01T${String(i).padStart(2, "0")}.log`), "x");
    }
    writeFileSync(join(logsDir, "daemon.log"), "active");

    await pruneLogFiles({
      dir: logsDir,
      ownPrefix: "daemon",
      maxOwnFiles: 10,
      abandonedMaxAgeMs: 1e12,
      isProcessAlive: dead,
    });

    const remaining = readdirSync(logsDir).filter((f) => f.endsWith(".log"));
    expect(remaining.length).toBe(10);
    expect(remaining).toContain("daemon.log");
  });

  test("sweeps an exited manager's stale daemon-launch-<pid>.log (issue #2724)", async () => {
    const logsDir = createTempLogsDir();
    // Launch-capture log owned by a now-exited spawning manager (pid 222).
    writeFileSync(join(logsDir, "daemon-launch-222.log"), "old bootstrap output");

    await pruneLogFiles({
      dir: logsDir,
      ownPrefix: "stdio-111",
      maxOwnFiles: 10,
      abandonedMaxAgeMs: 1_000,
      now: Date.now() + 1e9, // far future → mtime looks ancient
      isProcessAlive: dead,
    });

    expect(readdirSync(logsDir)).not.toContain("daemon-launch-222.log");
  });

  test("never sweeps a LIVE manager's daemon-launch-<pid>.log even when stale", async () => {
    const logsDir = createTempLogsDir();
    writeFileSync(join(logsDir, "daemon-launch-222.log"), "in-flight bootstrap output");

    await pruneLogFiles({
      dir: logsDir,
      ownPrefix: "stdio-111",
      maxOwnFiles: 10,
      abandonedMaxAgeMs: 1_000,
      now: Date.now() + 1e9,
      isProcessAlive: (pid) => pid === 222, // spawning manager still running
    });

    expect(readdirSync(logsDir)).toContain("daemon-launch-222.log");
  });

  test("no-op when own count is at or below the cap", async () => {
    const logsDir = createTempLogsDir();
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(logsDir, `stdio-111-${i}.log`), "x");
    }

    await pruneLogFiles({
      dir: logsDir,
      ownPrefix: "stdio-111",
      maxOwnFiles: 10,
      abandonedMaxAgeMs: 1e12,
      isProcessAlive: dead,
    });

    expect(readdirSync(logsDir).filter((f) => f.endsWith(".log")).length).toBe(10);
  });

  test("no-op (no throw) when directory is empty or missing", async () => {
    const logsDir = createTempLogsDir();
    await pruneLogFiles({
      dir: logsDir,
      ownPrefix: "stdio-111",
      maxOwnFiles: 10,
      abandonedMaxAgeMs: 1000,
      isProcessAlive: dead,
    });
    expect(readdirSync(logsDir).length).toBe(0);

    await pruneLogFiles({
      dir: join(logsDir, "does-not-exist"),
      ownPrefix: "stdio-111",
      maxOwnFiles: 10,
      abandonedMaxAgeMs: 1000,
      isProcessAlive: dead,
    });
  });

  test("ignores non-log files", async () => {
    const logsDir = createTempLogsDir();
    for (let i = 0; i < 15; i++) {
      writeFileSync(join(logsDir, `stdio-111-${i}.log`), "x");
    }
    writeFileSync(join(logsDir, "config.json"), "not a log");
    writeFileSync(join(logsDir, "notes.txt"), "not a log");

    await pruneLogFiles({
      dir: logsDir,
      ownPrefix: "stdio-111",
      maxOwnFiles: 10,
      abandonedMaxAgeMs: 1e12,
      isProcessAlive: dead,
    });

    const allFiles = readdirSync(logsDir);
    expect(allFiles.filter((f) => f.endsWith(".log")).length).toBe(10);
    expect(allFiles).toContain("config.json");
    expect(allFiles).toContain("notes.txt");
  });
});
