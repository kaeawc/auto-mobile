import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DaemonSocketReachability,
  type DaemonSocketConnectAttempt,
} from "../../src/daemon/daemonSocketReachability";
import { cleanupStaleDaemonFilesForDeadPidSync } from "../../src/daemon/daemonFiles";
import type { PidFileData } from "../../src/daemon/types";

describe("DaemonSocketReachability", () => {
  const tempDirs: string[] = [];
  const servers: Server[] = [];

  function createTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "daemon-reachability-test-"));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    await Promise.all(
      servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    servers.length = 0;
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  test("attempts the connection on Windows even though the named pipe has no filesystem entry (#6103 #1)", async () => {
    let connectCalls = 0;
    const connectAttempt: DaemonSocketConnectAttempt = async () => {
      connectCalls++;
      return true;
    };
    const reachability = new DaemonSocketReachability({
      platform: "win32",
      // A named pipe never has a filesystem entry, so existsSync is always false.
      existsSyncFn: () => false,
      connectAttempt,
    });

    await expect(reachability.isReachable("\\\\.\\pipe\\auto-mobile", 500)).resolves.toBe(true);
    // The FS gate must be bypassed on Windows — the connection is what decides.
    expect(connectCalls).toBe(1);
  });

  test("skips the connect on POSIX when the socket path is missing", async () => {
    let connectCalls = 0;
    const connectAttempt: DaemonSocketConnectAttempt = async () => {
      connectCalls++;
      return true;
    };
    const reachability = new DaemonSocketReachability({
      platform: "linux",
      existsSyncFn: () => false,
      connectAttempt,
    });

    await expect(reachability.isReachable("/tmp/missing.sock", 500)).resolves.toBe(false);
    // A missing Unix socket must not be hammered with a connect attempt.
    expect(connectCalls).toBe(0);
  });

  test("reports reachable on POSIX when the socket exists and the connect succeeds", async () => {
    const reachability = new DaemonSocketReachability({
      platform: "linux",
      existsSyncFn: () => true,
      connectAttempt: async () => true,
    });

    await expect(reachability.isReachable("/tmp/present.sock", 500)).resolves.toBe(true);
  });

  test("returns false without attempting a connect when the budget is non-positive", async () => {
    let connectCalls = 0;
    const reachability = new DaemonSocketReachability({
      platform: "linux",
      existsSyncFn: () => true,
      connectAttempt: async () => {
        connectCalls++;
        return true;
      },
    });

    await expect(reachability.isReachable("/tmp/present.sock", 0)).resolves.toBe(false);
    expect(connectCalls).toBe(0);
  });

  test("never unlinks the socket file on a refused connection, unlike the cleanup-capable primitive it replaced (#6103 #2)", async () => {
    const dir = createTempDir();
    const socketPath = join(dir, "peer.sock");
    const pidPath = join(dir, "daemon.pid");
    // A stale socket inode is present but nothing is listening (a race winner that
    // bound then died), and the PID file records a now-dead process.
    writeFileSync(socketPath, "stale socket placeholder");
    const pidData: PidFileData = {
      pid: 2147483646,
      socketPath,
      port: 0,
      startedAt: 0,
      version: "test",
    };
    writeFileSync(pidPath, JSON.stringify(pidData), { mode: 0o600 });

    // Observation-only probe: the connection is refused, but the socket file is left
    // completely untouched. The probe has no filesystem-mutating code path at all.
    const reachability = new DaemonSocketReachability({
      platform: "linux",
      existsSyncFn: () => true,
      connectAttempt: async () => false,
    });
    await expect(reachability.isReachable(socketPath, 500)).resolves.toBe(false);
    expect(existsSync(socketPath)).toBe(true);

    // Contrast — the danger this replaces: the cleanup-capable recovery primitive the
    // rejoin used to reach (via DaemonClient.connect) DELETES that same live-race
    // endpoint on a dead-PID record. If the probe were implemented via that path, the
    // assertion above would go red.
    const unlinked = cleanupStaleDaemonFilesForDeadPidSync({
      pidFilePath: pidPath,
      socketPaths: [socketPath],
      isProcessRunning: () => false,
    });
    expect(unlinked).toBe(true);
    expect(existsSync(socketPath)).toBe(false);
  });

  // Gated off Windows: net.Server.listen(path) there is a named pipe, not a filesystem
  // socket inode, so this real-connect happy path cannot be set up the same way.
  test.skipIf(process.platform === "win32")(
    "reports reachable through a real connection to a listening socket",
    async () => {
      const dir = createTempDir();
      const socketPath = join(dir, "listening.sock");
      const server = createServer();
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));

      // Default (real) connect attempt against a genuinely listening socket.
      const reachability = new DaemonSocketReachability({ platform: process.platform });
      await expect(reachability.isReachable(socketPath, 500)).resolves.toBe(true);
      expect(existsSync(socketPath)).toBe(true);
    },
  );
});
