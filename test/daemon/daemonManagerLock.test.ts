import { describe, expect, test, afterEach } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { DaemonManager } from "../../src/daemon/manager";
import { parseLockContent } from "../../src/utils/fileLock";
import { FakeTimer } from "../fakes/FakeTimer";

describe("DaemonManager file lock", () => {
  const tempDirs: string[] = [];

  function createTempLockPath(): string {
    const dir = mkdtempSync(join(tmpdir(), "daemon-lock-test-"));
    tempDirs.push(dir);
    // Keep any daemon launch log inside this test's temp tree, not the real
    // `~/.auto-mobile/logs` default (see tempDir.resolveAutoMobileBaseDir).
    process.env.AUTOMOBILE_DATA_DIR = dir;
    return join(dir, "daemon.lock");
  }

  afterEach(() => {
    for (const dir of tempDirs) {
      try {
        const { rmSync } = require("node:fs");
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    tempDirs.length = 0;
    delete process.env.AUTOMOBILE_DATA_DIR;
    delete process.env.AUTOMOBILE_LOG_DIR;
  });

  describe("acquireLock", () => {
    test("succeeds when no lock file exists", () => {
      const lockPath = createTempLockPath();
      const manager = new DaemonManager(undefined, undefined, new FakeTimer(), lockPath);

      expect(manager.acquireLock()).toBe(true);
      expect(existsSync(lockPath)).toBe(true);

      manager.releaseLock();
    });

    test("writes a per-instance owner token alongside the PID (#5904)", () => {
      const lockPath = createTempLockPath();
      const manager = new DaemonManager(undefined, undefined, new FakeTimer(), lockPath);

      expect(manager.acquireLock()).toBe(true);
      const { pid, token } = parseLockContent(readFileSync(lockPath, "utf-8").trim());
      // PID stays on line 1 (liveness readers are unaffected); the owner token is a
      // non-empty line-2 value used to tell replacement holders apart under PID reuse.
      expect(pid).toBe(process.pid);
      expect(token).toBeDefined();
      expect(token).not.toBe("");

      manager.releaseLock();
    });

    test("two managers in one process write distinct owner tokens (#5904)", () => {
      const lockPath = createTempLockPath();

      const first = new DaemonManager(undefined, undefined, new FakeTimer(), lockPath);
      expect(first.acquireLock()).toBe(true);
      const tokenA = parseLockContent(readFileSync(lockPath, "utf-8").trim()).token;
      first.releaseLock();

      const second = new DaemonManager(undefined, undefined, new FakeTimer(), lockPath);
      expect(second.acquireLock()).toBe(true);
      const tokenB = parseLockContent(readFileSync(lockPath, "utf-8").trim()).token;
      second.releaseLock();

      // Same process, same PID — only the per-instance token distinguishes the two
      // holders, which is what lets a same-PID replacement be re-arbitrated (#5904).
      expect(tokenA).toBeDefined();
      expect(tokenB).toBeDefined();
      expect(tokenA).not.toBe(tokenB);
    });

    test("fails when lock is held by a live process", () => {
      const lockPath = createTempLockPath();
      const manager = new DaemonManager(undefined, undefined, new FakeTimer(), lockPath);

      expect(manager.acquireLock()).toBe(true);

      const manager2 = new DaemonManager(undefined, undefined, new FakeTimer(), lockPath);
      expect(manager2.acquireLock()).toBe(false);

      manager.releaseLock();
    });

    test("cleans up stale lock from dead process", () => {
      const lockPath = createTempLockPath();
      writeFileSync(lockPath, "99999999");

      const manager = new DaemonManager(undefined, undefined, new FakeTimer(), lockPath);
      expect(manager.acquireLock()).toBe(true);
      expect(existsSync(lockPath)).toBe(true);

      manager.releaseLock();
    });

    test("treats invalid PID content as actively held (not stale)", () => {
      const lockPath = createTempLockPath();
      writeFileSync(lockPath, "not-a-pid");

      const manager = new DaemonManager(undefined, undefined, new FakeTimer(), lockPath);
      // NaN PID → treated as actively held to avoid race with concurrent writer
      expect(manager.acquireLock()).toBe(false);

      // Clean up
      const { unlinkSync } = require("node:fs");
      unlinkSync(lockPath);
    });

    test("treats empty lock file as actively held (writer still writing)", () => {
      const lockPath = createTempLockPath();
      writeFileSync(lockPath, "");

      const manager = new DaemonManager(undefined, undefined, new FakeTimer(), lockPath);
      // Empty → writer just created the file, hasn't written PID yet
      expect(manager.acquireLock()).toBe(false);

      // Clean up
      const { unlinkSync } = require("node:fs");
      unlinkSync(lockPath);
    });
  });

  describe("releaseLock", () => {
    test("removes the lock file", () => {
      const lockPath = createTempLockPath();
      const manager = new DaemonManager(undefined, undefined, new FakeTimer(), lockPath);

      manager.acquireLock();
      expect(existsSync(lockPath)).toBe(true);

      manager.releaseLock();
      expect(existsSync(lockPath)).toBe(false);
    });

    test("is safe when no lock file exists", () => {
      const lockPath = createTempLockPath();
      const manager = new DaemonManager(undefined, undefined, new FakeTimer(), lockPath);

      // Should not throw
      manager.releaseLock();
    });

    test("is idempotent", () => {
      const lockPath = createTempLockPath();
      const manager = new DaemonManager(undefined, undefined, new FakeTimer(), lockPath);

      manager.acquireLock();
      manager.releaseLock();
      manager.releaseLock(); // Should not throw
      expect(existsSync(lockPath)).toBe(false);
    });
  });

  describe("start() lock coordination", () => {
    test("waits for daemon when lock is held by another live process", async () => {
      const lockPath = createTempLockPath();
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();

      // Pre-acquire the lock (simulates another process holding it)
      writeFileSync(lockPath, String(process.pid));

      let waitForReadyCalled = false;

      class TestDaemonManager extends DaemonManager {
        override async waitForReady(_timeout: number): Promise<boolean> {
          waitForReadyCalled = true;
          return true; // Simulate daemon becoming ready
        }
        // Override to prevent real process spawning
        override findAllDaemonProcesses(): number[] {
          return [];
        }
      }

      const manager = new TestDaemonManager(undefined, undefined, fakeTimer, lockPath);

      await manager.start();

      expect(waitForReadyCalled).toBe(true);
      // Lock file should still exist (we didn't acquire it, so we don't release it)
      expect(existsSync(lockPath)).toBe(true);

      // Clean up
      const { unlinkSync } = require("node:fs");
      unlinkSync(lockPath);
    });

    test("waits through the cold-start budget and includes lock-holder diagnostics when startup fails", async () => {
      const lockPath = createTempLockPath();
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();

      const holderLogsDir = join(dirname(lockPath), "holder-logs");
      process.env.AUTOMOBILE_LOG_DIR = holderLogsDir;
      const holder = new DaemonManager(undefined, undefined, fakeTimer, lockPath);
      expect(holder.acquireLock()).toBe(true);
      mkdirSync(holderLogsDir, { recursive: true });
      writeFileSync(
        join(holderLogsDir, `daemon-launch-${process.pid}.log`),
        "Initializing CtrlProxy iOS for SIMULATOR-B\nrunner-health: connection refused\n",
      );

      process.env.AUTOMOBILE_LOG_DIR = join(dirname(lockPath), "follower-logs");
      const timeouts: number[] = [];

      class TestDaemonManager extends DaemonManager {
        override acquireLock(): boolean {
          return false;
        }
        override async waitForReady(timeout: number): Promise<boolean> {
          timeouts.push(timeout);
          return false; // Daemon never becomes ready
        }
        override findAllDaemonProcesses(): number[] {
          return [];
        }
      }

      const manager = new TestDaemonManager(undefined, undefined, fakeTimer, lockPath);

      await expect(manager.start()).rejects.toThrow(
        /Another process is starting the daemon but it failed to become ready[\s\S]*holder-logs[\s\S]*SIMULATOR-B/,
      );
      // The live holder is waited on once at the full cold-start budget; because it
      // stays the same live holder (not a replacement) the loop then stops. The
      // pre-failure readiness confirm is a direct non-destructive probe, not a
      // waitForReady call, so only the one budgeted wait is recorded (#5878).
      expect(timeouts).toEqual([30_000]);

      holder.releaseLock();
    });

    test("retains retry-holder diagnostics after the retry holder releases its lock", async () => {
      const lockPath = createTempLockPath();
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();
      const holderLogsDir = join(dirname(lockPath), "retry-holder-logs");
      let retryHolder: DaemonManager | undefined;
      let waitCount = 0;

      class TestDaemonManager extends DaemonManager {
        override acquireLock(): boolean {
          return false;
        }
        override async waitForReady(_timeout: number): Promise<boolean> {
          waitCount++;
          if (waitCount === 1) {
            process.env.AUTOMOBILE_LOG_DIR = holderLogsDir;
            retryHolder = new DaemonManager(undefined, undefined, fakeTimer, lockPath);
            expect(retryHolder.acquireLock()).toBe(true);
            mkdirSync(holderLogsDir, { recursive: true });
            writeFileSync(
              join(holderLogsDir, `daemon-launch-${process.pid}.log`),
              "Retry holder failed to start CtrlProxy\n",
            );
            return false;
          }

          retryHolder?.releaseLock();
          return false;
        }
        override findAllDaemonProcesses(): number[] {
          return [];
        }
      }

      const manager = new TestDaemonManager(undefined, undefined, fakeTimer, lockPath);

      await expect(manager.start()).rejects.toThrow(
        /Another process is starting the daemon but it failed to become ready[\s\S]*retry-holder-logs[\s\S]*Retry holder failed/,
      );
      // The initial holder wait plus one wait on the replacement retry holder; the
      // pre-failure confirm is a direct probe, not a waitForReady call (#5878).
      // Diagnostics are captured before the retry holder releases, so they survive
      // into the thrown error.
      expect(waitCount).toBe(2);
    });

    test("re-arbitrates for a same-PID replacement holder distinguished by owner token (#5904)", async () => {
      const lockPath = createTempLockPath();
      const socketPath = join(dirname(lockPath), "daemon.sock");
      const pidPath = join(dirname(lockPath), "daemon.pid");
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();

      // Initial holder: this process's PID with token A.
      writeFileSync(lockPath, `${process.pid}\ntoken-a`);
      let waitCount = 0;

      class TestDaemonManager extends DaemonManager {
        override acquireLock(): boolean {
          return false;
        }
        override async waitForReady(): Promise<boolean> {
          waitCount++;
          if (waitCount === 1) {
            // A replacement reclaims the lock with the SAME PID but a DIFFERENT token
            // (a different DaemonManager instance in this process). A PID-only identity
            // check would read this as the same stuck holder and stop after one wait.
            writeFileSync(lockPath, `${process.pid}\ntoken-b`);
          }
          return false;
        }
        override findAllDaemonProcesses(): number[] {
          return [];
        }
      }

      const manager = new TestDaemonManager(
        undefined,
        undefined,
        fakeTimer,
        lockPath,
        pidPath,
        socketPath,
      );

      await expect(manager.start()).rejects.toThrow();
      // Wait #1 on holder A, then the token-B replacement is recognized as a genuinely
      // new holder and waited on (#2); it then stays the same token-B holder so the
      // loop stops. Two waits, not the single wait a PID-only check would allow.
      expect(waitCount).toBe(2);
    });

    test("releases lock after successful start", async () => {
      const lockPath = createTempLockPath();
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();

      class TestDaemonManager extends DaemonManager {
        override findAllDaemonProcesses(): number[] {
          return [];
        }
        override async status(): Promise<any> {
          return { running: false };
        }
        override async waitForReady(_timeout: number): Promise<boolean> {
          return true;
        }
      }

      const manager = new TestDaemonManager(undefined, undefined, fakeTimer, lockPath);

      // start() will acquire the lock, try to run startUnlocked (which calls waitForReady
      // internally), and then release the lock. Since we can't fully mock startUnlocked
      // without accessing private methods, we verify the lock is released after start().
      // The actual start will fail because there's no real daemon binary, but the lock
      // should still be released via finally.
      try {
        await manager.start();
      } catch {
        // Expected — no real daemon to start
      }

      // Lock should be released regardless of success or failure
      expect(existsSync(lockPath)).toBe(false);
    });

    test("releases lock even when start throws", async () => {
      const lockPath = createTempLockPath();
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();

      class TestDaemonManager extends DaemonManager {
        override findAllDaemonProcesses(): number[] {
          return [];
        }
        override async status(): Promise<any> {
          throw new Error("simulated failure");
        }
      }

      const manager = new TestDaemonManager(undefined, undefined, fakeTimer, lockPath);

      await expect(manager.start()).rejects.toThrow("simulated failure");

      // Lock must be released even on error (finally block)
      expect(existsSync(lockPath)).toBe(false);
    });
  });
});
