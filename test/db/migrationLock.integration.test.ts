import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  FileMigrationLock,
  IN_MEMORY_DATABASE_PATH,
  IN_MEMORY_DB_OPT_IN_ENV,
  NoOpMigrationLock,
  isInMemoryDatabaseOptInEnabled,
  isInMemoryDatabasePath,
  migrationLockPathFor,
  selectMigrationLock,
} from "../../src/db/migrationLock";
import { ActionableError } from "../../src/models/ActionableError";
import { FakeTimer } from "../fakes/FakeTimer";

/** Let queued microtasks (busy-wait loop continuations) run. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** The pid line of a lock file — the token (if any) trails on line 2 (#2947). */
function lockPid(path: string): string {
  return readFileSync(path, "utf-8").split("\n")[0];
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
    expect(lockPid(lockPath)).toBe("4242");

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
      isProcessRunning: (pid) => pid === 9999, // the holder is alive
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
    expect(lockPid(lockPath)).toBe("4242");
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
    expect(lockPid(lockPath)).toBe("4242");
    await lock.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  test("does NOT steal a same-PID lock still held by a live in-flight run of THIS process (#2947)", async () => {
    // Gen-0 of this process instance holds the lock (its own PID + our process
    // token). An in-process same-path reopen (gen-1) must WAIT for gen-0 to
    // release rather than reclaim under reclaimOwnPid — otherwise two migrators
    // enter migrateToLatest() on one DB file (the #2794 collision this lock exists
    // to prevent).
    const timer = new FakeTimer();
    writeFileSync(lockPath, "4242\nprocess-token-A");
    const lock = new FileMigrationLock(lockPath, {
      timer,
      pid: 4242,
      pollIntervalMs: 100,
      isProcessRunning: () => true, // gen-0 (our process) is alive
      ownerToken: "process-token-A", // same instance token as the held lock
    });

    let acquired = false;
    const pending = lock.acquire().then(() => {
      acquired = true;
    });

    // First attempt sees a live same-token holder -> parks on sleep, does NOT steal.
    await flush();
    expect(acquired).toBe(false);
    expect(timer.getPendingSleepCount()).toBe(1);
    expect(lockPid(lockPath)).toBe("4242");

    // It must STAY parked across further poll cycles while the same-token holder is
    // still live — never reclaim after N polls.
    for (let cycle = 0; cycle < 3; cycle += 1) {
      timer.advanceTime(100);
      await flush();
      expect(acquired).toBe(false);
      expect(lockPid(lockPath)).toBe("4242");
    }

    // Gen-0 releases; gen-1 then acquires cleanly on the next poll.
    rmSync(lockPath);
    timer.advanceTime(100);
    await flush();
    await pending;
    expect(acquired).toBe(true);
    expect(lockPid(lockPath)).toBe("4242");
    await lock.release();
  });

  test("reclaims a same-PID lock from a crashed prior incarnation (different token) without waiting (#2947/#2794)", async () => {
    // A crashed prior incarnation held the lock and the OS recycled its PID; its
    // process token differs from ours, so this is a genuine stale leak — reclaim it
    // immediately instead of hanging for the full timeout.
    const timer = new FakeTimer();
    writeFileSync(lockPath, "4242\nprocess-token-OLD");
    const lock = new FileMigrationLock(lockPath, {
      timer,
      pid: 4242,
      isProcessRunning: () => true,
      ownerToken: "process-token-A",
    });

    await lock.acquire();

    expect(timer.getSleepCallCount()).toBe(0);
    expect(lockPid(lockPath)).toBe("4242");
    await lock.release();
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

  test("release is incarnation-aware: leaves a same-PID lock from another token (#3006)", async () => {
    // A recycled-PID incarnation holds the lock with a DIFFERENT token. A PID-only
    // release would wrongly delete it; the token guard leaves it intact.
    writeFileSync(lockPath, "4242\ntok-OTHER");
    const lock = new FileMigrationLock(lockPath, {
      timer: new FakeTimer(),
      pid: 4242,
      ownerToken: "tok-MINE",
    });

    await lock.release();

    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf-8")).toBe("4242\ntok-OTHER");
  });

  test("release removes our own pid+token lock (#3006)", async () => {
    const lock = new FileMigrationLock(lockPath, {
      timer: new FakeTimer(),
      pid: 4242,
      isProcessRunning: () => true,
      ownerToken: "tok-MINE",
    });
    await lock.acquire();
    expect(existsSync(lockPath)).toBe(true);

    await lock.release();
    expect(existsSync(lockPath)).toBe(false);
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
    expect(lockPid(lockPath)).toBe("4242");
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
    const pending = lock.acquire().catch((error) => {
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
      isProcessRunning: (pid) => pid !== 9999, // 9999 dead, everyone else alive
    });
    const lockB = new FileMigrationLock(lockPath, {
      timer,
      pid: 200,
      pollIntervalMs: 50,
      timeoutMs: 1000,
      isProcessRunning: (pid) => pid !== 9999,
    });

    // A reclaims the stale lock first.
    await lockA.acquire();
    expect(lockPid(lockPath)).toBe("100");

    // B must NOT be able to steal it while A (pid 100) is alive.
    let bAcquired = false;
    const bPending = lockB.acquire().then(() => {
      bAcquired = true;
    });
    await flush();
    timer.advanceTime(50);
    await flush();
    expect(bAcquired).toBe(false);
    expect(lockPid(lockPath)).toBe("100");

    // Once A releases, B acquires cleanly.
    await lockA.release();
    timer.advanceTime(50);
    await flush();
    await bPending;
    expect(bAcquired).toBe(true);
    expect(lockPid(lockPath)).toBe("200");
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

describe("isInMemoryDatabasePath", () => {
  test("recognizes the `:memory:` sentinel", () => {
    expect(isInMemoryDatabasePath(IN_MEMORY_DATABASE_PATH)).toBe(true);
    expect(isInMemoryDatabasePath(":memory:")).toBe(true);
  });

  test("rejects real file paths", () => {
    expect(isInMemoryDatabasePath("/tmp/auto-mobile.db")).toBe(false);
    expect(isInMemoryDatabasePath("auto-mobile.db")).toBe(false);
    // A `file::memory:?cache=shared` URI is deliberately NOT treated as the
    // sentinel: it was rejected in favor of plain `:memory:` (issue #3047), so
    // it must fall through to the file-lock branch rather than silently no-op.
    expect(isInMemoryDatabasePath("file::memory:?cache=shared")).toBe(false);
  });
});

describe("selectMigrationLock", () => {
  test("selects a NoOpMigrationLock for the `:memory:` sentinel", () => {
    // A `:memory:` DB is private per connection, has no file to guard, and
    // `:memory:.migrate.lock` would be a bogus file — so it must NOT get a
    // FileMigrationLock (issue #3047).
    expect(selectMigrationLock(IN_MEMORY_DATABASE_PATH)).toBeInstanceOf(NoOpMigrationLock);
  });

  test("selects a FileMigrationLock for a real DB path", () => {
    const dbPath = join(tmpdir(), "auto-mobile-createlock", "auto-mobile.db");
    expect(selectMigrationLock(dbPath)).toBeInstanceOf(FileMigrationLock);
  });
});

describe("isInMemoryDatabaseOptInEnabled", () => {
  test("is disabled when the opt-in env var is absent", () => {
    expect(isInMemoryDatabaseOptInEnabled({})).toBe(false);
  });

  test("recognizes the truthy opt-in values (case/whitespace-insensitive)", () => {
    // Only 1/true/yes are accepted, after trim().toLowerCase().
    for (const value of ["1", "true", "TRUE", "yes", "  Yes  ", "\t1\n"]) {
      expect(isInMemoryDatabaseOptInEnabled({ [IN_MEMORY_DB_OPT_IN_ENV]: value })).toBe(true);
    }
  });

  test("treats empty/false-ish values as disabled (fail-safe: no silent opt-in)", () => {
    // "on"/"On" is NOT an accepted token (only 1/true/yes), so it stays disabled;
    // whitespace-only and arbitrary strings are disabled too.
    for (const value of ["", "0", "false", "no", "off", "nope", "on", "On", "maybe", "   "]) {
      expect(isInMemoryDatabaseOptInEnabled({ [IN_MEMORY_DB_OPT_IN_ENV]: value })).toBe(false);
    }
  });
});

describe("migrationLockPathFor", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "migration-lock-path-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("appends .migrate.lock to the canonicalized DB path", () => {
    const dbPath = join(dir, "auto-mobile.db");
    // `dir` itself may be under a symlinked tmp root (e.g. macOS /var → /private/var),
    // so compare against the canonicalized directory rather than the raw path.
    const expected = `${join(realpathSync(dir), "auto-mobile.db")}.migrate.lock`;
    expect(migrationLockPathFor(dbPath)).toBe(expected);
  });

  // Symlinks require elevation on Windows; the canonicalization is a POSIX-alias fix.
  test.skipIf(process.platform === "win32")(
    "resolves symlinked directory aliases to the same lock path",
    () => {
      const realDir = join(dir, "real");
      const linkDir = join(dir, "link");
      mkdirSync(realDir, { recursive: true });
      symlinkSync(realDir, linkDir);

      const viaReal = migrationLockPathFor(join(realDir, "auto-mobile.db"));
      const viaLink = migrationLockPathFor(join(linkDir, "auto-mobile.db"));

      // Two aliases for the same directory must derive the SAME lock file so the
      // openers actually contend.
      expect(viaLink).toBe(viaReal);
    },
  );

  test.skipIf(process.platform === "win32")(
    "resolves a symlinked DB file to the same lock path as its real path",
    () => {
      const realDb = join(dir, "auto-mobile.db");
      const aliasDb = join(dir, "alias.db");
      writeFileSync(realDb, ""); // the DB file exists; alias is a symlink to it
      symlinkSync(realDb, aliasDb);

      const viaReal = migrationLockPathFor(realDb);
      const viaAlias = migrationLockPathFor(aliasDb);

      // A symlinked DB file itself must derive the SAME lock as its real path.
      expect(viaAlias).toBe(viaReal);
      expect(viaReal).toBe(`${realpathSync(realDb)}.migrate.lock`);
    },
  );
});
