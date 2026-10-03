import { describe, expect, test, afterEach, mock, spyOn } from "bun:test";
import { mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pruneLogFiles, type LogRetentionNamespaceSource } from "../../src/utils/logPruner";
import {
  logRetentionNamespaces,
  registerLogRetentionNamespaceSource,
  resetLogRetentionNamespaceSourceForTesting,
} from "../../src/utils/logger";
import * as processLiveness from "../../src/utils/processLiveness";

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

  afterEach(() => {
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
