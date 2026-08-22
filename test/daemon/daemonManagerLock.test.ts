import { describe, expect, test, afterEach } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { DaemonManager } from "../../src/daemon/manager";
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
      } catch { /* ignore */ }
    }
    tempDirs.length = 0;
    delete process.env.AUTOMOBILE_DATA_DIR;
  });

  describe("acquireLock", () => {
    test("succeeds when no lock file exists", () => {
      const lockPath = createTempLockPath();
      const manager = new DaemonManager(undefined, undefined, new FakeTimer(), lockPath);

      expect(manager.acquireLock()).toBe(true);
      expect(existsSync(lockPath)).toBe(true);

      manager.releaseLock();
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
        override findAllDaemonProcesses(): number[] { return []; }
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

      const lockHolderPid = 424_242;
      writeFileSync(lockPath, String(lockHolderPid));
      const logsDir = join(dirname(lockPath), "logs");
      mkdirSync(logsDir, { recursive: true });
      writeFileSync(
        join(logsDir, `daemon-launch-${lockHolderPid}.log`),
        "Initializing CtrlProxy iOS for SIMULATOR-B\nrunner-health: connection refused\n",
      );
      const timeouts: number[] = [];

      class TestDaemonManager extends DaemonManager {
        override acquireLock(): boolean {
          return false;
        }
        override async waitForReady(timeout: number): Promise<boolean> {
          timeouts.push(timeout);
          return false; // Daemon never becomes ready
        }
        override findAllDaemonProcesses(): number[] { return []; }
      }

      const manager = new TestDaemonManager(undefined, undefined, fakeTimer, lockPath);

      await expect(manager.start()).rejects.toThrow(
        /Another process is starting the daemon but it failed to become ready[\s\S]*daemon-launch-424242\.log[\s\S]*SIMULATOR-B/
      );
      expect(timeouts).toEqual([30_000, 30_000]);

      // Clean up
      const { unlinkSync } = require("node:fs");
      unlinkSync(lockPath);
    });

    test("releases lock after successful start", async () => {
      const lockPath = createTempLockPath();
      const fakeTimer = new FakeTimer();
      fakeTimer.enableAutoAdvance();

      class TestDaemonManager extends DaemonManager {
        override findAllDaemonProcesses(): number[] { return []; }
        override async status(): Promise<any> { return { running: false }; }
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
        override findAllDaemonProcesses(): number[] { return []; }
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
