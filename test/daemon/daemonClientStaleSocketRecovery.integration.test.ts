import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, platform } from "node:os";
import { DaemonClient } from "../../src/daemon/client";
import type { DaemonSocketReachabilityLike } from "../../src/daemon/daemonSocketReachability";
import type { PidFileData } from "../../src/daemon/types";

const isWindows = platform() === "win32";

describe("DaemonClient stale socket recovery", () => {
  const tempDirs: string[] = [];
  let server: Server | null = null;

  function createTempPaths(): { dir: string; socketPath: string; pidFilePath: string } {
    const dir = mkdtempSync(join(tmpdir(), "daemon-stale-socket-test-"));
    tempDirs.push(dir);
    return {
      dir,
      socketPath: join(dir, "daemon.sock"),
      pidFilePath: join(dir, "daemon.pid"),
    };
  }

  async function createClosedSocketFile(socketPath: string): Promise<void> {
    server = createServer();
    await new Promise<void>((resolve) => server!.listen(socketPath, resolve));
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }

  function writePidFile(pidFilePath: string, socketPath: string): void {
    const pidData: PidFileData = {
      pid: 12345,
      socketPath,
      port: 3000,
      startedAt: 0,
      version: "test",
    };
    writeFileSync(pidFilePath, JSON.stringify(pidData));
  }

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  (isWindows ? test.skip : test)(
    "isAvailable removes socket and PID files when the recorded daemon PID is dead",
    async () => {
      const { socketPath, pidFilePath } = createTempPaths();
      writeFileSync(socketPath, "stale socket placeholder");
      writePidFile(pidFilePath, socketPath);

      const available = await DaemonClient.isAvailable(socketPath, {
        pidFilePath,
        socketPaths: [socketPath],
        isProcessRunning: () => false,
      });

      expect(available).toBe(false);
      expect(existsSync(socketPath)).toBe(false);
      expect(existsSync(pidFilePath)).toBe(false);
    },
  );

  (isWindows ? test.skip : test)(
    "isAvailable leaves files intact when the recorded daemon PID is alive",
    async () => {
      const { socketPath, pidFilePath } = createTempPaths();
      writeFileSync(socketPath, "stale socket placeholder");
      writePidFile(pidFilePath, socketPath);

      const available = await DaemonClient.isAvailable(socketPath, {
        pidFilePath,
        socketPaths: [socketPath],
        isProcessRunning: () => true,
      });

      expect(available).toBe(false);
      expect(existsSync(socketPath)).toBe(true);
      expect(existsSync(pidFilePath)).toBe(true);
    },
  );

  (isWindows ? test.skip : test)(
    "connect cleans stale files and retries after a failed socket connection",
    async () => {
      const { socketPath, pidFilePath } = createTempPaths();
      await createClosedSocketFile(socketPath);
      writePidFile(pidFilePath, socketPath);

      const client = new DaemonClient(socketPath, 50, undefined, {
        pidFilePath,
        socketPaths: [socketPath],
        isProcessRunning: () => false,
      });

      await expect(client.connect()).rejects.toThrow("Daemon socket not found");
      expect(existsSync(socketPath)).toBe(false);
      expect(existsSync(pidFilePath)).toBe(false);
    },
  );
});

describe("DaemonClient stale socket recovery — winner-race reachability guard (#6140)", () => {
  const tempDirs: string[] = [];

  function createTempPaths(): { dir: string; socketPath: string; pidFilePath: string } {
    const dir = mkdtempSync(join(tmpdir(), "daemon-winner-race-test-"));
    tempDirs.push(dir);
    return {
      dir,
      socketPath: join(dir, "daemon.sock"),
      pidFilePath: join(dir, "daemon.pid"),
    };
  }

  function writePidFile(pidFilePath: string, socketPath: string): void {
    const pidData: PidFileData = {
      pid: 12345,
      socketPath,
      port: 3000,
      startedAt: 0,
      version: "test",
    };
    writeFileSync(pidFilePath, JSON.stringify(pidData));
  }

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  (isWindows ? test.skip : test)(
    "propagates the original error instead of unlinking when the reachability probe reports a live peer",
    async () => {
      const { socketPath, pidFilePath } = createTempPaths();
      // No listener at all: connectOnce's real attempt fails (ENOENT/ECONNREFUSED).
      writePidFile(pidFilePath, socketPath);

      let cleanupCalls = 0;
      class AlwaysReachable implements DaemonSocketReachabilityLike {
        async isReachable(): Promise<boolean> {
          return true;
        }
      }

      const client = new DaemonClient(socketPath, 50, undefined, {
        pidFilePath,
        socketPaths: [socketPath],
        // The recorded PID is dead — the OLD guard alone would consider this
        // stale and unlink.
        isProcessRunning: () => {
          cleanupCalls++;
          return false;
        },
        reachability: new AlwaysReachable(),
      });

      await expect(client.connect()).rejects.toThrow();
      // The reachability probe reporting "live" must short-circuit BEFORE the
      // dead-PID cleanup ever runs.
      expect(cleanupCalls).toBe(0);
      expect(existsSync(pidFilePath)).toBe(true);
    },
  );

  (isWindows ? test.skip : test)(
    "still cleans up and retries when the reachability probe reports nothing live",
    async () => {
      const { socketPath, pidFilePath } = createTempPaths();
      writeFileSync(socketPath, "stale socket placeholder");
      writePidFile(pidFilePath, socketPath);

      class NeverReachable implements DaemonSocketReachabilityLike {
        async isReachable(): Promise<boolean> {
          return false;
        }
      }

      const client = new DaemonClient(socketPath, 50, undefined, {
        pidFilePath,
        socketPaths: [socketPath],
        isProcessRunning: () => false,
        reachability: new NeverReachable(),
      });

      await expect(client.connect()).rejects.toThrow("Daemon socket not found");
      expect(existsSync(socketPath)).toBe(false);
      expect(existsSync(pidFilePath)).toBe(false);
    },
  );
});

describe("DaemonClient platform-aware connect (#6140)", () => {
  const tempDirs: string[] = [];

  function createTempPidPath(): string {
    const dir = mkdtempSync(join(tmpdir(), "daemon-client-platform-test-"));
    tempDirs.push(dir);
    return join(dir, "daemon.pid");
  }

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  test("does not gate connectOnce on existsSync when simulating win32 (named pipes have no filesystem entry)", async () => {
    // A path that does not exist on disk — modeling a Windows named pipe, which
    // never has a filesystem entry to begin with.
    const nonExistentSocketPath = join(
      tmpdir(),
      `daemon-client-win32-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`,
    );
    const pidFilePath = createTempPidPath(); // no PID file written: nothing to clean up

    const client = new DaemonClient(
      nonExistentSocketPath,
      100,
      undefined,
      { pidFilePath, socketPaths: [nonExistentSocketPath] },
      null,
      undefined,
      "win32",
    );

    const error: unknown = await client.connect().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    // The win32 branch skips the synchronous existsSync precheck entirely, so the
    // failure comes from the actual (failed) connection attempt, never from the
    // "Daemon socket not found" short-circuit that precheck would have produced.
    expect((error as Error).message).not.toContain("Daemon socket not found");
  });

  test("still throws the existsSync short-circuit off win32", async () => {
    const nonExistentSocketPath = join(
      tmpdir(),
      `daemon-client-posix-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`,
    );
    const pidFilePath = createTempPidPath();

    const client = new DaemonClient(nonExistentSocketPath, 100, undefined, {
      pidFilePath,
      socketPaths: [nonExistentSocketPath],
    });

    await expect(client.connect()).rejects.toThrow("Daemon socket not found");
  });
});
