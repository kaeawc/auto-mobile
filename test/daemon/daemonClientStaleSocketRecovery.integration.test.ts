import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, platform } from "node:os";
import { DaemonClient } from "../../src/daemon/client";
import type { PidFileData } from "../../src/daemon/types";

const isWindows = platform() === "win32";

/**
 * Issue #6140 design change: `DaemonClient` no longer performs ANY client-side
 * destructive stale-socket recovery. `UnixSocketServer.start()`
 * (`src/daemon/socketServer.ts`) already unconditionally unlinks the socket path
 * before `listen()`, and that runs under `DaemonManager`'s `O_EXCL` startup lock
 * (`src/daemon/manager.ts`) — so stale-socket recovery already happens,
 * correctly, at daemon bind time under a lock. The client-side unlink this suite
 * used to cover had no lock to coordinate against: a concurrent startup winner
 * could bind a NEW socket at the same path between the client's "is this dead?"
 * check and its unlink, and the client would delete the winner's live socket —
 * the exact brick #6140 is about. Removing the client-side unlink makes that
 * brick impossible by construction and loses no auto-recovery: the next daemon
 * start reclaims a stale socket under its lock regardless.
 *
 * This suite asserts the invariant that replaces the old multi-layered
 * probe/holder/inode recovery machinery: `connect()` and `isAvailable()` NEVER
 * unlink the socket or PID file, even when the PID file names a confirmed-dead
 * process. `connect()` still surfaces a helpful diagnostic hint in that case.
 */
describe("DaemonClient never destructively recovers a stale socket (#6140)", () => {
  const tempDirs: string[] = [];

  function createTempPaths(): { dir: string; socketPath: string; pidFilePath: string } {
    const dir = mkdtempSync(join(tmpdir(), "daemon-stale-socket-test-"));
    tempDirs.push(dir);
    return {
      dir,
      socketPath: join(dir, "daemon.sock"),
      pidFilePath: join(dir, "daemon.pid"),
    };
  }

  function writePidFile(pidFilePath: string, socketPath: string, pid = 12345): void {
    const pidData: PidFileData = {
      pid,
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
    "isAvailable never touches the socket or PID file, regardless of PID-file state",
    async () => {
      const { socketPath, pidFilePath } = createTempPaths();
      // A non-socket regular file represents a stale socket a dead daemon left
      // behind.
      writeFileSync(socketPath, "stale socket placeholder");
      writePidFile(pidFilePath, socketPath);

      const available = await DaemonClient.isAvailable(socketPath);

      expect(available).toBe(false);
      expect(existsSync(socketPath)).toBe(true);
      expect(existsSync(pidFilePath)).toBe(true);
    },
  );

  (isWindows ? test.skip : test)(
    "connect() rejects without unlinking the socket or PID file when the recorded PID is dead",
    async () => {
      // No socket file: connectOnce's own existsSync precheck fails deterministically
      // (issue #6140 note: this deliberately avoids attempting a REAL connection to
      // a non-socket placeholder file — that failure path is delivered async via a
      // socket 'error' event, whose exact timing is not under this test's control;
      // the existsSync short-circuit is synchronous and gives every assertion below
      // a deterministic, non-flaky failure to work with).
      const { socketPath, pidFilePath } = createTempPaths();
      writePidFile(pidFilePath, socketPath);

      const client = new DaemonClient(socketPath, 100, undefined, {
        pidFilePath,
        isProcessRunning: () => false,
      });

      await expect(client.connect()).rejects.toThrow("Daemon socket not found");
      // The whole point of #6140: recovery is the daemon's lock-guarded bind-time
      // unlink, never the client's. The PID file must survive.
      expect(existsSync(pidFilePath)).toBe(true);
    },
  );

  (isWindows ? test.skip : test)(
    "connect() rejects without unlinking anything when the recorded PID is alive",
    async () => {
      const { socketPath, pidFilePath } = createTempPaths();
      writePidFile(pidFilePath, socketPath);

      const client = new DaemonClient(socketPath, 100, undefined, {
        pidFilePath,
        isProcessRunning: () => true,
      });

      await expect(client.connect()).rejects.toThrow("Daemon socket not found");
      expect(existsSync(pidFilePath)).toBe(true);
    },
  );

  (isWindows ? test.skip : test)(
    "connect() includes a stale-socket hint in the error when the recorded PID is confirmed dead",
    async () => {
      const { socketPath, pidFilePath } = createTempPaths();
      writePidFile(pidFilePath, socketPath, 54321);

      const client = new DaemonClient(socketPath, 100, undefined, {
        pidFilePath,
        isProcessRunning: () => false,
      });

      const error: unknown = await client.connect().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("54321");
      expect((error as Error).message.toLowerCase()).toContain("stale");
    },
  );

  (isWindows ? test.skip : test)(
    "connect() does not add a stale-socket hint when the recorded PID is still alive",
    async () => {
      const { socketPath, pidFilePath } = createTempPaths();
      writePidFile(pidFilePath, socketPath, 54321);

      const client = new DaemonClient(socketPath, 100, undefined, {
        pidFilePath,
        isProcessRunning: () => true,
      });

      const error: unknown = await client.connect().then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain("54321");
    },
  );

  (isWindows ? test.skip : test)(
    "connect() rejects without unlinking when there is no PID file at all",
    async () => {
      const { socketPath, pidFilePath } = createTempPaths();
      // No socket file, no PID file: the simplest "nothing here" case.

      const client = new DaemonClient(socketPath, 100, undefined, {
        pidFilePath,
        isProcessRunning: () => false,
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

  // Verifies the gate condition directly (via the private `socketPathObservable`
  // helper) rather than through a real end-to-end connect attempt: connecting to
  // a path that genuinely does not exist reaches the OS's own Unix-pipe-connect
  // error handling, whose async delivery timing is not reliably observable from
  // a bun:test test body (a real connect failure to an absent path can surface
  // as an unhandled error outside any Promise this test can await/catch,
  // independent of anything `connectOnce` does). Testing the pure boolean gate
  // exercises the exact same production logic deterministically.
  test("socketPathObservable treats a nonexistent path as observable when simulating win32 (named pipes have no filesystem entry)", () => {
    const nonExistentSocketPath = join(
      tmpdir(),
      `daemon-client-win32-test-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`,
    );

    const client = new DaemonClient(
      nonExistentSocketPath,
      100,
      undefined,
      {},
      null,
      undefined,
      "win32",
    );

    const internals = client as unknown as { socketPathObservable(): boolean };
    expect(internals.socketPathObservable()).toBe(true);
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
      });

      await expect(client.connect()).rejects.toThrow("Daemon socket not found");
    },
  );
});
