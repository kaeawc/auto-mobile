import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  cleanupDaemonFiles,
  cleanupDaemonFilesSync,
  isProcessRunning,
  listDaemonPidFilesSync,
} from "../../src/daemon/daemonFiles";
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

  test("cleanupDaemonFilesSync skips cleanup when PID file belongs to another process", () => {
    const { socketPath, pidFilePath } = createTempFiles();

    cleanupDaemonFilesSync({ pidFilePath, socketPaths: [socketPath], expectedPid: 67890 });

    expect(existsSync(socketPath)).toBe(true);
    expect(existsSync(pidFilePath)).toBe(true);
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

    const found = listDaemonPidFilesSync(own);
    expect(found).toContain(own);
    expect(found).toContain(bench);
    expect(found).not.toContain(join(dir, "daemon.log"));
    expect(found).not.toContain(join(dir, "auto-mobile-daemon-1000.sock"));
  });

  test("always includes the given pid file even when it does not match the sibling pattern", () => {
    const dir = makeDir();
    const own = join(dir, "daemon.pid"); // arbitrary non-default name
    // No file written on disk; enumeration must still include the requested path.
    const found = listDaemonPidFilesSync(own);
    expect(found).toContain(own);
  });

  test("degrades to just the given pid file when the directory is unreadable", () => {
    const missing = join(tmpdir(), `no-such-dir-${Date.now()}-${Math.random()}`, "daemon.pid");
    expect(listDaemonPidFilesSync(missing)).toEqual([missing]);
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
