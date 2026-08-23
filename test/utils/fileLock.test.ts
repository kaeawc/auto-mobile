import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import {
  formatLockContent,
  parseLockContent,
  releaseExclusiveLock,
  tryAcquireExclusiveLock,
} from "../../src/utils/fileLock";

describe("fileLock primitive", () => {
  let dir: string;
  let lockPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "file-lock-"));
    lockPath = join(dir, "thing.lock");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("acquires on a fresh path and writes the owner pid", () => {
    expect(tryAcquireExclusiveLock(lockPath, { pid: 100, isProcessRunning: () => true })).toBe(
      true,
    );
    expect(readFileSync(lockPath, "utf-8").trim()).toBe("100");
  });

  test("fails when a different live holder owns it", () => {
    writeFileSync(lockPath, "9999");
    expect(tryAcquireExclusiveLock(lockPath, { pid: 100, isProcessRunning: () => true })).toBe(
      false,
    );
    expect(readFileSync(lockPath, "utf-8").trim()).toBe("9999");
  });

  test("treats an empty lock file as held (writer mid-write)", () => {
    writeFileSync(lockPath, "");
    expect(tryAcquireExclusiveLock(lockPath, { pid: 100, isProcessRunning: () => true })).toBe(
      false,
    );
  });

  test("surfaces a genuine IO error instead of reporting contention (#3623)", () => {
    // Make an intermediate path component a regular file so the lock's parent can't
    // be created: mkdirSync fails with a non-EEXIST errno (ENOTDIR), i.e. a real IO
    // error rather than lock contention. The old uniform catch swallowed this as
    // `return false`, disguising it as "another holder owns the lock".
    const filePath = join(dir, "not-a-dir");
    writeFileSync(filePath, "x");
    const badLockPath = join(filePath, "sub", "child.lock");

    expect(() =>
      tryAcquireExclusiveLock(badLockPath, { pid: 100, isProcessRunning: () => true }),
    ).toThrow(/Failed to create exclusive lock file/);
  });

  test("treats an unreadable PID as held", () => {
    writeFileSync(lockPath, "not-a-pid");
    expect(tryAcquireExclusiveLock(lockPath, { pid: 100, isProcessRunning: () => true })).toBe(
      false,
    );
  });

  test("reclaims a lock left by a dead holder", () => {
    writeFileSync(lockPath, "9999");
    expect(tryAcquireExclusiveLock(lockPath, { pid: 100, isProcessRunning: () => false })).toBe(
      true,
    );
    expect(readFileSync(lockPath, "utf-8").trim()).toBe("100");
  });

  test("reclaim leaves no stray .reclaim marker behind", () => {
    writeFileSync(lockPath, "9999");
    expect(tryAcquireExclusiveLock(lockPath, { pid: 100, isProcessRunning: () => false })).toBe(
      true,
    );

    const lockName = basename(lockPath);
    const strays = readdirSync(dir).filter((name) => name !== lockName);
    expect(strays).toEqual([]);
  });

  test("a stale reclaim marker from a crashed reclaim does not block a later reclaim", () => {
    // A prior reclaim by pid 100 crashed after the rename but before removing its
    // marker. A fresh reclaim by the same pid must still succeed (rename overwrites).
    writeFileSync(`${lockPath}.100.reclaim`, "9999");
    writeFileSync(lockPath, "9999");

    expect(tryAcquireExclusiveLock(lockPath, { pid: 100, isProcessRunning: () => false })).toBe(
      true,
    );
    expect(readFileSync(lockPath, "utf-8").trim()).toBe("100");
    expect(existsSync(`${lockPath}.100.reclaim`)).toBe(false);
  });

  test("own live PID is held by default but reclaimed under reclaimOwnPid", () => {
    writeFileSync(lockPath, "100");

    // Default (daemon coordinator): a same-PID probe reads as held.
    expect(tryAcquireExclusiveLock(lockPath, { pid: 100, isProcessRunning: () => true })).toBe(
      false,
    );

    // reclaimOwnPid (migration singleton): a leaked own-PID lock is reclaimed.
    expect(
      tryAcquireExclusiveLock(lockPath, {
        pid: 100,
        isProcessRunning: () => true,
        reclaimOwnPid: true,
      }),
    ).toBe(true);
    expect(readFileSync(lockPath, "utf-8").trim()).toBe("100");
  });

  describe("ownerToken distinguishes a live in-flight run from a stale recycled-PID leak (#2947)", () => {
    test("writes the owner token beneath the pid when provided", () => {
      expect(
        tryAcquireExclusiveLock(lockPath, {
          pid: 100,
          isProcessRunning: () => true,
          ownerToken: "tok-A",
        }),
      ).toBe(true);
      // PID stays parseable as the first line so the daemon liveness reader and
      // releaseExclusiveLock (parseInt) keep working; the token trails on line 2.
      const content = readFileSync(lockPath, "utf-8");
      expect(content.split("\n")[0]).toBe("100");
      expect(content).toContain("tok-A");
      expect(Number.parseInt(content, 10)).toBe(100);
    });

    test("a same-PID lock bearing OUR token is a live in-flight run → held, not stolen", () => {
      // Gen-0 (this same process instance) holds the lock. An in-process same-path
      // reopen (gen-1) must NOT reclaim it under reclaimOwnPid — that would let two
      // migrators run migrateToLatest() on the same DB file (#2947).
      writeFileSync(lockPath, "100\ntok-A");
      expect(
        tryAcquireExclusiveLock(lockPath, {
          pid: 100,
          isProcessRunning: () => true,
          reclaimOwnPid: true,
          ownerToken: "tok-A",
        }),
      ).toBe(false);
      expect(readFileSync(lockPath, "utf-8")).toBe("100\ntok-A");
    });

    test("a same-PID lock bearing a DIFFERENT token is a crashed-incarnation leak → reclaimed (#2794 preserved)", () => {
      // A prior incarnation crashed holding the lock and the OS recycled its PID;
      // its token differs from ours, so reclaim it immediately instead of hanging.
      writeFileSync(lockPath, "100\ntok-OLD");
      expect(
        tryAcquireExclusiveLock(lockPath, {
          pid: 100,
          isProcessRunning: () => true,
          reclaimOwnPid: true,
          ownerToken: "tok-A",
        }),
      ).toBe(true);
      expect(readFileSync(lockPath, "utf-8").split("\n")[0]).toBe("100");
    });

    test("a same-PID lock with NO token (legacy incarnation) is reclaimed under reclaimOwnPid", () => {
      // A lock left by a pre-token incarnation carries only the pid; treat it as a
      // recycled-PID leak so the #2794 stale-reclaim behavior is unchanged.
      writeFileSync(lockPath, "100");
      expect(
        tryAcquireExclusiveLock(lockPath, {
          pid: 100,
          isProcessRunning: () => true,
          reclaimOwnPid: true,
          ownerToken: "tok-A",
        }),
      ).toBe(true);
    });

    test("a same-PID lock whose owner is DEAD is reclaimed even when the token matches", () => {
      // A matching token normally means a live in-flight sibling to wait for, but a
      // dead owner has no live run — the liveness check wins, so it is reclaimed.
      // (Unreachable in production, where our own live PID is always alive and a
      // dead incarnation had a different token; pins the predicate branch anyway.)
      writeFileSync(lockPath, "100\ntok-A");
      expect(
        tryAcquireExclusiveLock(lockPath, {
          pid: 100,
          isProcessRunning: () => false,
          reclaimOwnPid: true,
          ownerToken: "tok-A",
        }),
      ).toBe(true);
      expect(readFileSync(lockPath, "utf-8").split("\n")[0]).toBe("100");
    });

    test("without reclaimOwnPid, our token on a live same-PID lock still reads as held (daemon default)", () => {
      writeFileSync(lockPath, "100\ntok-A");
      expect(
        tryAcquireExclusiveLock(lockPath, {
          pid: 100,
          isProcessRunning: () => true,
          ownerToken: "tok-A",
        }),
      ).toBe(false);
    });

    test("release honors a pid+token lock (parseInt reads the pid line)", () => {
      writeFileSync(lockPath, "100\ntok-A");
      releaseExclusiveLock(lockPath, 100);
      expect(existsSync(lockPath)).toBe(false);
    });
  });

  describe("incarnation-aware release (#3006 follow-up 1)", () => {
    test("releases a matching pid+token lock when the token is supplied", () => {
      writeFileSync(lockPath, "100\ntok-A");
      releaseExclusiveLock(lockPath, 100, "tok-A");
      expect(existsSync(lockPath)).toBe(false);
    });

    test("does NOT delete a same-PID lock bearing a DIFFERENT token (recycled-PID incarnation)", () => {
      // Another incarnation recycled our PID and wrote its own token; a PID-only
      // release would wrongly delete its live lock. The token guard leaves it.
      writeFileSync(lockPath, "100\ntok-OTHER");
      releaseExclusiveLock(lockPath, 100, "tok-A");
      expect(existsSync(lockPath)).toBe(true);
      expect(readFileSync(lockPath, "utf-8")).toBe("100\ntok-OTHER");
    });

    test("releases a tokenless legacy lock on a PID match even when a token is supplied", () => {
      // A pre-token incarnation wrote only the PID; treat it as ours (PID match)
      // so a token-aware release stays backward compatible.
      writeFileSync(lockPath, "100");
      releaseExclusiveLock(lockPath, 100, "tok-A");
      expect(existsSync(lockPath)).toBe(false);
    });

    test("PID-only release (no token) deletes any same-PID lock (daemon behavior unchanged)", () => {
      writeFileSync(lockPath, "100\ntok-A");
      releaseExclusiveLock(lockPath, 100);
      expect(existsSync(lockPath)).toBe(false);
    });
  });

  describe("lock content format helpers (#3006 follow-up 2)", () => {
    test("formatLockContent keeps the PID a bare integer on line 1", () => {
      expect(formatLockContent(100)).toBe("100");
      expect(formatLockContent(100, "tok-A")).toBe("100\ntok-A");
      expect(formatLockContent(100, undefined, "holder-log-path")).toBe("100\n\nholder-log-path");
      expect(Number.parseInt(formatLockContent(100, "tok-A"), 10)).toBe(100);
    });

    test("parseLockContent round-trips formatLockContent", () => {
      expect(parseLockContent(formatLockContent(100))).toEqual({ pid: 100, token: undefined });
      expect(parseLockContent(formatLockContent(100, "tok-A"))).toEqual({
        pid: 100,
        token: "tok-A",
      });
      expect(parseLockContent(formatLockContent(100, undefined, "holder-log-path"))).toEqual({
        pid: 100,
        token: undefined,
        metadata: "holder-log-path",
      });
    });

    test("parseLockContent reports NaN for an unreadable PID line", () => {
      expect(parseLockContent("not-a-pid").pid).toBeNaN();
    });
  });

  describe("releaseExclusiveLock (compare-and-delete)", () => {
    test("removes the file when it holds our pid", () => {
      writeFileSync(lockPath, "100");
      releaseExclusiveLock(lockPath, 100);
      expect(existsSync(lockPath)).toBe(false);
    });

    test("does not delete a lock owned by a different pid", () => {
      writeFileSync(lockPath, "200");
      releaseExclusiveLock(lockPath, 100);
      expect(existsSync(lockPath)).toBe(true);
      expect(readFileSync(lockPath, "utf-8").trim()).toBe("200");
    });

    test("is inert when no lock file exists", () => {
      releaseExclusiveLock(lockPath, 100);
      expect(existsSync(lockPath)).toBe(false);
    });
  });
});
