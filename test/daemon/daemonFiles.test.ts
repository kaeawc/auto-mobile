import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  cleanupDaemonFiles,
  cleanupDaemonFilesSync,
  cleanupStaleDaemonFilesForDeadPidSync,
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

  test("cleanupStaleDaemonFilesForDeadPidSync only removes files for dead recorded PIDs", () => {
    const { socketPath, pidFilePath } = createTempFiles();

    const cleaned = cleanupStaleDaemonFilesForDeadPidSync({
      pidFilePath,
      socketPaths: [socketPath],
      isProcessRunning: () => false,
    });

    expect(cleaned).toBe(true);
    expect(existsSync(socketPath)).toBe(false);
    expect(existsSync(pidFilePath)).toBe(false);
  });

  test("cleanupStaleDaemonFilesForDeadPidSync leaves files for live recorded PIDs", () => {
    const { socketPath, pidFilePath } = createTempFiles();

    const cleaned = cleanupStaleDaemonFilesForDeadPidSync({
      pidFilePath,
      socketPaths: [socketPath],
      isProcessRunning: () => true,
    });

    expect(cleaned).toBe(false);
    expect(existsSync(socketPath)).toBe(true);
    expect(existsSync(pidFilePath)).toBe(true);
  });

  test("cleanupStaleDaemonFilesForDeadPidSync rechecks PID ownership before cleanup", () => {
    const { socketPath, pidFilePath } = createTempFiles();

    const cleaned = cleanupStaleDaemonFilesForDeadPidSync({
      pidFilePath,
      socketPaths: [socketPath],
      isProcessRunning: () => {
        writeFileSync(
          pidFilePath,
          JSON.stringify({
            pid: 67890,
            socketPath,
            port: 3000,
            startedAt: 0,
            version: "test",
          } satisfies PidFileData),
        );
        return false;
      },
    });

    expect(cleaned).toBe(false);
    expect(existsSync(socketPath)).toBe(true);
    expect(existsSync(pidFilePath)).toBe(true);
  });

  test("cleanupDaemonFilesSync skips cleanup when PID file belongs to another process", () => {
    const { socketPath, pidFilePath } = createTempFiles();

    cleanupDaemonFilesSync({ pidFilePath, socketPaths: [socketPath], expectedPid: 67890 });

    expect(existsSync(socketPath)).toBe(true);
    expect(existsSync(pidFilePath)).toBe(true);
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
