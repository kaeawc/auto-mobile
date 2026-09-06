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

  // The caller can abort WHILE the reachability probe from the fix above is
  // in flight. The pre-await `!signal?.aborted` check cannot see an abort that
  // happens during the awaited call, so the abort must be rechecked immediately
  // after it resolves — otherwise connect() would ignore the cancellation and
  // proceed to the dead-PID cleanup/retry anyway.
  (isWindows ? test.skip : test)(
    "bails without stale-socket cleanup when aborted while the reachability probe is pending",
    async () => {
      const { socketPath, pidFilePath } = createTempPaths();
      // No listener: connectOnce's real attempt fails quickly (ENOENT/ECONNREFUSED).
      writePidFile(pidFilePath, socketPath);

      class PendingReachability implements DaemonSocketReachabilityLike {
        calls = 0;
        private resolvers: Array<(value: boolean) => void> = [];
        isReachable(): Promise<boolean> {
          this.calls++;
          return new Promise((resolve) => {
            this.resolvers.push(resolve);
          });
        }
        resolveNext(value: boolean): void {
          this.resolvers.shift()?.(value);
        }
      }
      const reachability = new PendingReachability();

      let cleanupCalls = 0;
      const controller = new AbortController();
      const client = new DaemonClient(socketPath, 500, undefined, {
        pidFilePath,
        socketPaths: [socketPath],
        isProcessRunning: () => {
          cleanupCalls++;
          return false;
        },
        reachability,
      });

      const connectPromise = client.connect(500, controller.signal);

      // Wait until connect() has entered the recovery probe (deterministic:
      // poll the fake's call counter rather than a fixed sleep).
      while (reachability.calls === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      // Abort WHILE the probe is still pending, then let it resolve.
      controller.abort();
      reachability.resolveNext(false);

      await expect(connectPromise).rejects.toThrow();
      // The abort must be rechecked after the probe settles: cleanup (and any
      // retried connectOnce) must never run once the caller has cancelled.
      expect(cleanupCalls).toBe(0);
      expect(existsSync(pidFilePath)).toBe(true);
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

  // Asserts the DEFAULT (unoverridden) platform still gates on existsSync, which
  // only holds when this host's real platform is not win32 — on the Windows
  // host-integration runner `platform()` genuinely IS "win32", so the gate this
  // test checks for would not apply and connectOnce would instead attempt (and
  // fail) a real connection rather than short-circuiting on the missing path.
  (isWindows ? test.skip : test)(
    "still throws the existsSync short-circuit off win32",
    async () => {
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
    },
  );
});
