import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { FileMigrationLock, NoOpMigrationLock } from "../../src/db/migrationLock";
import { ActionableError } from "../../src/models/ActionableError";
import { FakeTimer } from "../fakes/FakeTimer";

/** Let queued microtasks (busy-wait loop continuations) run. */
async function flush(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
}

describe("FileMigrationLock", () => {
  let dir: string;
  let lockPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "migration-lock-"));
    lockPath = join(dir, "auto-mobile.db.migrate.lock");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("acquire creates the lock file with the owner pid; release removes it", async () => {
    const timer = new FakeTimer();
    const lock = new FileMigrationLock(lockPath, {
      timer,
      pid: 4242,
      isProcessRunning: () => true,
    });

    await lock.acquire();

    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf-8").trim()).toBe("4242");

    await lock.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  test("single-opener path acquires immediately without sleeping", async () => {
    const timer = new FakeTimer();
    const lock = new FileMigrationLock(lockPath, { timer, pid: 1 });

    await lock.acquire();

    expect(timer.getSleepCallCount()).toBe(0);
    await lock.release();
  });

  test("busy-waits while a live holder owns the lock, then acquires after release", async () => {
    const timer = new FakeTimer();
    // Simulate another live process holding the lock.
    writeFileSync(lockPath, "9999");
    const lock = new FileMigrationLock(lockPath, {
      timer,
      pid: 4242,
      pollIntervalMs: 100,
      isProcessRunning: pid => pid === 9999, // the holder is alive
    });

    let acquired = false;
    const pending = lock.acquire().then(() => {
      acquired = true;
    });

    // First attempt fails (held by live process) -> parks on sleep.
    await flush();
    expect(acquired).toBe(false);
    expect(timer.getPendingSleepCount()).toBe(1);

    // Holder still alive after a poll -> keeps waiting.
    timer.advanceTime(100);
    await flush();
    expect(acquired).toBe(false);

    // Holder releases; next poll reclaims the lock.
    rmSync(lockPath);
    timer.advanceTime(100);
    await flush();
    await pending;

    expect(acquired).toBe(true);
    expect(readFileSync(lockPath, "utf-8").trim()).toBe("4242");
    await lock.release();
  });

  test("reclaims a lock left by our own recycled PID without waiting", async () => {
    // A supervisor restarts a crashed process and the OS recycles its PID, so a
    // leaked lock bears our own now-live PID. Since the migration run is a
    // per-process singleton, this must be reclaimed, not waited out for 60s.
    const timer = new FakeTimer();
    writeFileSync(lockPath, "4242");
    const lock = new FileMigrationLock(lockPath, {
      timer,
      pid: 4242,
      isProcessRunning: () => true, // our own PID is (of course) alive
    });

    await lock.acquire();

    expect(timer.getSleepCallCount()).toBe(0);
    expect(readFileSync(lockPath, "utf-8").trim()).toBe("4242");
    await lock.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  test("release does not delete a lock owned by a different opener", async () => {
    const timer = new FakeTimer();
    // A different live opener owns the lock.
    writeFileSync(lockPath, "9999");
    const lock = new FileMigrationLock(lockPath, {
      timer,
      pid: 4242,
      isProcessRunning: () => true,
    });

    // We never acquired it; release must be a no-op that leaves the file intact.
    await lock.release();

    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf-8").trim()).toBe("9999");
  });

  test("release is inert when the lock was never acquired", async () => {
    const lock = new FileMigrationLock(lockPath, { timer: new FakeTimer(), pid: 4242 });
    await lock.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  test("reclaims a stale lock left by a dead holder without waiting", async () => {
    const timer = new FakeTimer();
    // Stale lock from a dead process.
    writeFileSync(lockPath, "9999");
    const lock = new FileMigrationLock(lockPath, {
      timer,
      pid: 4242,
      isProcessRunning: () => false, // holder is dead
    });

    await lock.acquire();

    expect(timer.getSleepCallCount()).toBe(0);
    expect(readFileSync(lockPath, "utf-8").trim()).toBe("4242");
    await lock.release();
  });

  test("throws an ActionableError after the timeout ceiling when the holder stays alive", async () => {
    const timer = new FakeTimer();
    writeFileSync(lockPath, "9999");
    const lock = new FileMigrationLock(lockPath, {
      timer,
      pid: 4242,
      pollIntervalMs: 100,
      timeoutMs: 250,
      isProcessRunning: () => true, // never releases
    });

    let rejection: unknown;
    const pending = lock.acquire().catch(error => {
      rejection = error;
    });

    // Drive past the ceiling.
    for (let i = 0; i < 5; i++) {
      timer.advanceTime(100);
      await flush();
    }
    await pending;

    expect(rejection).toBeInstanceOf(ActionableError);
    const message = (rejection as Error).message;
    expect(message).toContain("AUTOMOBILE_DB_PATH");
    expect(message).toContain(lockPath);
    expect(message).toContain("migration lock");
    // Lock owned by the live holder must remain untouched.
    expect(readFileSync(lockPath, "utf-8").trim()).toBe("9999");
  });

  test("does not let two openers both win on a dead-PID reclaim race (atomic wx)", async () => {
    const timer = new FakeTimer();
    // Both processes see the same dead-PID stale lock.
    writeFileSync(lockPath, "9999");

    const lockA = new FileMigrationLock(lockPath, {
      timer,
      pid: 100,
      pollIntervalMs: 50,
      timeoutMs: 1000,
      isProcessRunning: pid => pid !== 9999, // 9999 dead, everyone else alive
    });
    const lockB = new FileMigrationLock(lockPath, {
      timer,
      pid: 200,
      pollIntervalMs: 50,
      timeoutMs: 1000,
      isProcessRunning: pid => pid !== 9999,
    });

    // A reclaims the stale lock first.
    await lockA.acquire();
    const owner = readFileSync(lockPath, "utf-8").trim();
    expect(owner).toBe("100");

    // B must NOT be able to steal it while A (pid 100) is alive.
    let bAcquired = false;
    const bPending = lockB.acquire().then(() => {
      bAcquired = true;
    });
    await flush();
    timer.advanceTime(50);
    await flush();
    expect(bAcquired).toBe(false);
    expect(readFileSync(lockPath, "utf-8").trim()).toBe("100");

    // Once A releases, B acquires cleanly.
    await lockA.release();
    timer.advanceTime(50);
    await flush();
    await bPending;
    expect(bAcquired).toBe(true);
    expect(readFileSync(lockPath, "utf-8").trim()).toBe("200");
    await lockB.release();
  });
});

describe("NoOpMigrationLock", () => {
  test("acquire and release are inert", async () => {
    const lock = new NoOpMigrationLock();
    await lock.acquire();
    await lock.release();
    expect(true).toBe(true);
  });
});
