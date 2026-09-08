import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  cleanupDaemonFiles,
  cleanupDaemonFilesSync,
  clearDaemonLaunchLogOwnerTombstoneSync,
  daemonLaunchLogOwnerTombstonePath,
  isProcessRunning,
  listDaemonPidFilesSync,
  readDaemonOwnerForRetentionSync,
  readDaemonLaunchLogOwnerTombstoneSync,
} from "../../src/daemon/daemonFiles";
import { DEFAULT_PID_FILE_PATH } from "../../src/daemon/constants";
import type { PidFileData } from "../../src/daemon/types";

describe("daemon file cleanup", () => {
  const tempDirs: string[] = [];

  function createTempFiles(): { dir: string; socketPath: string; pidFilePath: string } {
    const dir = mkdtempSync(join(tmpdir(), "daemon-file-cleanup-test-"));
    tempDirs.push(dir);
    const socketPath = join(dir, "daemon.sock");
    const pidFilePath = join(dir, "daemon.pid");
    writeFileSync(socketPath, "");
    writeFileSync(
      pidFilePath,
      JSON.stringify({
        pid: 12345,
        socketPath,
        port: 3000,
        startedAt: 0,
        version: "test",
      } satisfies PidFileData),
    );
    return { dir, socketPath, pidFilePath };
  }

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  test("cleanupDaemonFiles removes configured socket and PID paths", async () => {
    const { socketPath, pidFilePath } = createTempFiles();

    await cleanupDaemonFiles({ pidFilePath, socketPaths: [socketPath] });

    expect(existsSync(socketPath)).toBe(false);
    expect(existsSync(pidFilePath)).toBe(false);
  });

  test("cleanupDaemonFilesSync removes configured socket and PID paths", () => {
    const { socketPath, pidFilePath } = createTempFiles();

    cleanupDaemonFilesSync({ pidFilePath, socketPaths: [socketPath] });

    expect(existsSync(socketPath)).toBe(false);
    expect(existsSync(pidFilePath)).toBe(false);
  });

  test("persists the launch-log owner before removing a PID record", () => {
    const { dir, socketPath, pidFilePath } = createTempFiles();
    const launchLogPath = join(dir, "daemon-launch-123.log");
    writeFileSync(
      pidFilePath,
      JSON.stringify({ pid: 12345, socketPath, launchLogPath } satisfies Partial<PidFileData>),
    );

    cleanupDaemonFilesSync({ pidFilePath, socketPaths: [socketPath] });

    expect(readDaemonLaunchLogOwnerTombstoneSync(launchLogPath)).toEqual({
      pid: 12345,
      launchLogPath,
    });
    expect(
      JSON.parse(readFileSync(daemonLaunchLogOwnerTombstonePath(launchLogPath), "utf-8")),
    ).toEqual({
      pid: 12345,
      launchLogPath,
    });
  });

  test("clears stale owner evidence before reusing a launch-log path", () => {
    const { dir } = createTempFiles();
    const launchLogPath = join(dir, "daemon-launch-123.log");
    writeFileSync(
      daemonLaunchLogOwnerTombstonePath(launchLogPath),
      JSON.stringify({ pid: 12345, launchLogPath }),
    );

    clearDaemonLaunchLogOwnerTombstoneSync(launchLogPath);

    expect(existsSync(daemonLaunchLogOwnerTombstonePath(launchLogPath))).toBe(false);
  });

  test("cleanupDaemonFilesSync skips cleanup when PID file belongs to another process", () => {
    const { socketPath, pidFilePath } = createTempFiles();

    cleanupDaemonFilesSync({ pidFilePath, socketPaths: [socketPath], expectedPid: 67890 });

    expect(existsSync(socketPath)).toBe(true);
    expect(existsSync(pidFilePath)).toBe(true);
  });

  // Issue #6232: a lock-less contender refused over a live sibling has written
  // its OWN early owner record (issue #2871), so `expectedPid` would authorize
  // deletion of the shared socket/PID files even though it never bound the socket.
  // `socketBindCommitted: false` must suppress ALL deletion so the live winner's
  // files survive the loser's exit (the #6140 brick, prevented here).
  test("cleanupDaemonFilesSync removes nothing when the socket bind was never committed, even for our own PID", () => {
    const { socketPath, pidFilePath } = createTempFiles();

    const removed = cleanupDaemonFilesSync({
      pidFilePath,
      socketPaths: [socketPath],
      expectedPid: 12345,
      socketBindCommitted: false,
    });

    expect(removed).toBe(false);
    expect(existsSync(socketPath)).toBe(true);
    expect(existsSync(pidFilePath)).toBe(true);
  });

  test("cleanupDaemonFiles removes nothing when the socket bind was never committed, even for our own PID", async () => {
    const { socketPath, pidFilePath } = createTempFiles();

    const removed = await cleanupDaemonFiles({
      pidFilePath,
      socketPaths: [socketPath],
      expectedPid: 12345,
      socketBindCommitted: false,
    });

    expect(removed).toBe(false);
    expect(existsSync(socketPath)).toBe(true);
    expect(existsSync(pidFilePath)).toBe(true);
  });

  test("cleanupDaemonFilesSync still cleans a committed bind's own files", () => {
    const { socketPath, pidFilePath } = createTempFiles();

    const removed = cleanupDaemonFilesSync({
      pidFilePath,
      socketPaths: [socketPath],
      expectedPid: 12345,
      socketBindCommitted: true,
    });

    expect(removed).toBe(true);
    expect(existsSync(socketPath)).toBe(false);
    expect(existsSync(pidFilePath)).toBe(false);
  });
});

describe("isProcessRunning", () => {
  // Issue #6260 (PRRT ft82g): `process.kill(pid, 0)` treats non-positive PIDs
  // specially — 0 signals the current process GROUP, -1 signals EVERY process
  // this user can signal — so both "succeed" without naming a real process. A
  // corrupt/stale lock recording one of these must never be reported as a
  // live owner (which would surface a `kill 0` / `kill -1` suggestion).
  test.each([0, -1, -100, 1.5, NaN])(
    "reports a non-positive/non-integer PID (%p) as not running without signaling it",
    (pid) => {
      expect(isProcessRunning(pid)).toBe(false);
    },
  );

  test("reports the current process as running (sanity check for a real positive PID)", () => {
    expect(isProcessRunning(process.pid)).toBe(true);
  });
});

describe("listDaemonPidFilesSync (cross-namespace enumeration, issue #6194)", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  function makeDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "daemon-pidfile-enum-test-"));
    tempDirs.push(dir);
    return dir;
  }

  test("returns the given pid file plus co-located sibling namespace pid files", () => {
    const dir = makeDir();
    const own = join(dir, "auto-mobile-daemon-1000.pid");
    const bench = join(dir, "auto-mobile-daemon-bench-abc.pid");
    writeFileSync(own, "{}");
    writeFileSync(bench, "{}");
    // Unrelated files in the same dir must be ignored.
    writeFileSync(join(dir, "daemon.log"), "x");
    writeFileSync(join(dir, "auto-mobile-daemon-1000.sock"), "x");

    const { pidFiles } = listDaemonPidFilesSync(own);
    expect(pidFiles).toContain(own);
    expect(pidFiles).toContain(bench);
    expect(pidFiles).not.toContain(join(dir, "daemon.log"));
    expect(pidFiles).not.toContain(join(dir, "auto-mobile-daemon-1000.sock"));
  });

  test("always includes the given pid file even when it does not match the sibling pattern", () => {
    const dir = makeDir();
    const own = join(dir, "daemon.pid"); // arbitrary non-default name
    // No file written on disk; enumeration must still include the requested path.
    const { pidFiles } = listDaemonPidFilesSync(own);
    expect(pidFiles).toContain(own);
  });

  test("degrades to just the given pid file, marked uncertain, when the directory is unreadable", () => {
    const missing = join(tmpdir(), `no-such-dir-${Date.now()}-${Math.random()}`, "daemon.pid");
    const result = listDaemonPidFilesSync(missing);
    expect(result.pidFiles).toEqual([missing]);
    // A failed scan could not enumerate co-located namespaces -> fail closed.
    expect(result.uncertain).toBe(true);
  });

  test("marks a custom (non-default) pid namespace uncertain even when its dir scans fine", () => {
    const dir = makeDir();
    const own = join(dir, "auto-mobile-daemon-1000.pid");
    writeFileSync(own, "{}");
    // The directory is readable, but a custom namespace may be shared through a
    // common AUTOMOBILE_LOG_DIR by peers whose pid files live in OTHER dirs this
    // scan never visits (issue #6194), so discovery is not exhaustive.
    expect(listDaemonPidFilesSync(own).uncertain).toBe(true);
  });

  test("is ALSO uncertain for the default pid namespace, even with a clean sibling scan", () => {
    // A peer can leave AUTOMOBILE_LOG_DIR at its default (sharing this log dir)
    // while relocating ONLY its pid file via AUTOMOBILE_DAEMON_PID_FILE_PATH to a
    // directory this scan never visits — invisible to a directory listing no
    // matter how "default" the scanning caller's own namespace is. A clean
    // default-dir scan can therefore never be treated as exhaustive (issue #6194).
    expect(listDaemonPidFilesSync(DEFAULT_PID_FILE_PATH).uncertain).toBe(true);
  });

  test("still discovers co-located sibling pid files even though the enumeration is uncertain", () => {
    // Uncertainty gates the pruner's fallback decision, not what gets discovered:
    // a sibling that IS visible must still be returned so its liveness can be
    // checked first (a discovered live peer short-circuits to "retain" without
    // needing the uncertain flag at all).
    const dir = makeDir();
    const own = join(dir, "auto-mobile-daemon-1000.pid");
    const bench = join(dir, "auto-mobile-daemon-bench-abc.pid");
    writeFileSync(own, "{}");
    writeFileSync(bench, "{}");

    const result = listDaemonPidFilesSync(own);
    expect(result.uncertain).toBe(true);
    expect(result.pidFiles).toContain(own);
    expect(result.pidFiles).toContain(bench);
  });
});

describe("readDaemonOwnerForRetentionSync (ambiguity vs absence, issue #6194)", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  function makeDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "daemon-pidfile-read-test-"));
    tempDirs.push(dir);
    return dir;
  }

  test("returns undefined for a confidently-absent pid file", () => {
    const missing = join(makeDir(), "daemon.pid");
    expect(readDaemonOwnerForRetentionSync(missing)).toBeUndefined();
  });

  test("preserves a well-formed PID file's explicit launch-log declaration", () => {
    const dir = makeDir();
    const pidFile = join(dir, "daemon.pid");
    writeFileSync(pidFile, JSON.stringify({ pid: 4321, launchLogPath: null }));
    expect(readDaemonOwnerForRetentionSync(pidFile)).toEqual({
      pid: 4321,
      launchLogPath: null,
    });
  });

  test("THROWS (does not swallow to undefined) on a present-but-malformed pid file", () => {
    const dir = makeDir();
    const pidFile = join(dir, "daemon.pid");
    writeFileSync(pidFile, "{ this is not json");
    // The pruner relies on this throw to fail closed and retain the launch log.
    expect(() => readDaemonOwnerForRetentionSync(pidFile)).toThrow();
  });

  test("THROWS on syntactically-valid JSON missing the pid field", () => {
    const dir = makeDir();
    const pidFile = join(dir, "daemon.pid");
    writeFileSync(pidFile, "{}");
    // Present but schema-invalid — ambiguous, not confidently absent.
    expect(() => readDaemonOwnerForRetentionSync(pidFile)).toThrow();
  });

  test("THROWS when pid is a non-numeric string", () => {
    const dir = makeDir();
    const pidFile = join(dir, "daemon.pid");
    writeFileSync(pidFile, JSON.stringify({ pid: "123" }));
    expect(() => readDaemonOwnerForRetentionSync(pidFile)).toThrow();
  });

  test("THROWS when pid is zero, negative, or non-integer", () => {
    const dir = makeDir();
    for (const badPid of [0, -1, 1.5]) {
      const pidFile = join(dir, `daemon-${badPid}.pid`);
      writeFileSync(pidFile, JSON.stringify({ pid: badPid }));
      expect(() => readDaemonOwnerForRetentionSync(pidFile)).toThrow();
    }
  });
});

describe("WebRTC stream socket path", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("uses the explicit WebRTC stream socket override", async () => {
    process.env.AUTOMOBILE_WEBRTC_STREAM_SOCKET_PATH = ".auto-mobile/test-webrtc.sock";
    const daemonFiles = await import(
      `../../src/daemon/daemonFiles.ts?webrtc-socket=${Date.now()}-${Math.random()}`
    );

    expect(daemonFiles.WEBRTC_STREAM_SOCKET_CONFIG.defaultPath).toBe(
      resolve(".auto-mobile/test-webrtc.sock"),
    );
  });
});
