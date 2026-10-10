import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "fs";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import {
  formatLockContent,
  parseLockContent,
  readExclusiveLockContent,
  releaseExclusiveLock,
  takeOverExclusiveLock,
  tryAcquireExclusiveLock,
  unreadableLockAgeMs,
  UNREADABLE_LOCK_GRACE_MS,
} from "../../src/utils/fileLock";
import { logger } from "../../src/utils/logger";

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

  describe("a torn (empty or unparsable) lock file", () => {
    const writtenAt = 1_000;
    const clockAt = (nowMs: number) => ({ nowMs: () => nowMs, mtimeMs: () => writtenAt });

    test.each([
      ["empty", ""],
      ["unparsable", "garbage\n"],
    ])(
      "an %s lock is held while younger than the grace and reclaimed once older",
      (_name, body) => {
        writeFileSync(lockPath, body);
        const young = clockAt(writtenAt + UNREADABLE_LOCK_GRACE_MS - 1);
        expect(unreadableLockAgeMs(lockPath, young)).toBe(UNREADABLE_LOCK_GRACE_MS - 1);
        expect(tryAcquireExclusiveLock(lockPath, { pid: 7, ...young })).toBe(false);
        expect(readFileSync(lockPath, "utf-8")).toBe(body);

        const old = clockAt(writtenAt + UNREADABLE_LOCK_GRACE_MS);
        expect(tryAcquireExclusiveLock(lockPath, { pid: 7, ...old })).toBe(true);
        expect(readExclusiveLockContent(lockPath)?.pid).toBe(7);
        expect(readdirSync(dir)).toEqual(["thing.lock"]);
      },
    );

    test("a readable lock or a missing file has no unreadable age", () => {
      expect(unreadableLockAgeMs(lockPath, clockAt(9_999_999))).toBeUndefined();
      writeFileSync(lockPath, formatLockContent(5));
      expect(unreadableLockAgeMs(lockPath, clockAt(9_999_999))).toBeUndefined();
    });

    test("a fresh unreadable file displaced by the reclaim rename is restored", () => {
      writeFileSync(lockPath, "");
      // The first age check sees a stale file; by the marker check a peer's fresh empty file
      // has replaced it, so the rename moved the peer's file and it must be put back.
      const mtimes = [0, writtenAt + UNREADABLE_LOCK_GRACE_MS];
      const racing = {
        nowMs: () => writtenAt + UNREADABLE_LOCK_GRACE_MS,
        mtimeMs: () => mtimes.shift(),
      };
      expect(tryAcquireExclusiveLock(lockPath, { pid: 7, ...racing })).toBe(false);
      expect(readdirSync(dir)).toEqual(["thing.lock"]);
      expect(readFileSync(lockPath, "utf-8")).toBe("");
    });
  });

  test("takes over a live owner's lock only while it still holds the observed instance (#10497)", () => {
    expect(tryAcquireExclusiveLock(lockPath, { pid: 100, ownerToken: "old", metadata: "m" })).toBe(
      true,
    );
    const observed = readExclusiveLockContent(lockPath)!;
    expect(observed).toEqual({ pid: 100, token: "old", metadata: "m" });

    expect(takeOverExclusiveLock(lockPath, { pid: 100, token: "other" }, { pid: 200 })).toBe(false);
    expect(
      takeOverExclusiveLock(lockPath, observed, { pid: 200, ownerToken: "new", metadata: "n" }),
    ).toBe(true);
    expect(readExclusiveLockContent(lockPath)).toEqual({ pid: 200, token: "new", metadata: "n" });
    // The displaced owner's release must not delete the new owner's lock.
    releaseExclusiveLock(lockPath, 100, "old");
    expect(readExclusiveLockContent(lockPath)?.pid).toBe(200);
  });

  test("release never deletes a lock taken over between its ownership read and its delete (#10497)", () => {
    expect(tryAcquireExclusiveLock(lockPath, { pid: 100, ownerToken: "old" })).toBe(true);
    const realRead = fs.readFileSync;
    let swapped = false;
    const readSpy = spyOn(fs, "readFileSync").mockImplementation(((
      path: fs.PathOrFileDescriptor,
      options?: unknown,
    ) => {
      const content = realRead(path, options as BufferEncoding);
      if (!swapped && path === lockPath) {
        // A taker replaces the file right after the releaser read "ours".
        swapped = true;
        writeFileSync(lockPath, formatLockContent(200, "taker"));
      }
      return content;
    }) as typeof fs.readFileSync);
    try {
      releaseExclusiveLock(lockPath, 100, "old");
    } finally {
      readSpy.mockRestore();
    }
    expect(swapped).toBe(true);
    expect(readExclusiveLockContent(lockPath)).toEqual({ pid: 200, token: "taker" });
    expect(readdirSync(dir)).toEqual([basename(lockPath)]);
  });

  test("release removes its own lock and leaves no marker behind", () => {
    expect(tryAcquireExclusiveLock(lockPath, { pid: 100, ownerToken: "mine" })).toBe(true);
    releaseExclusiveLock(lockPath, 100, "mine");
    expect(readdirSync(dir)).toEqual([]);
  });

  test("reads no lock content for a missing lock file", () => {
    expect(readExclusiveLockContent(lockPath)).toBeUndefined();
  });

  test("acquires on a fresh path and writes the owner pid", () => {
    expect(tryAcquireExclusiveLock(lockPath, { pid: 100, isProcessRunning: () => true })).toBe(
      true,
    );
    expect(readFileSync(lockPath, "utf-8").trim()).toBe("100");
  });

  test("fresh acquire and release preserve pid and token ownership", () => {
    const ids = new CountingIdGenerator("lock");
    const ownerToken = ids.next();
    const otherToken = ids.next();
    expect(tryAcquireExclusiveLock(lockPath, { pid: 100, ownerToken })).toBe(true);
    expect(parseLockContent(readFileSync(lockPath, "utf-8"))).toEqual({
      pid: 100,
      token: ownerToken,
    });

    releaseExclusiveLock(lockPath, 200, ownerToken);
    releaseExclusiveLock(lockPath, 100, otherToken);
    expect(readFileSync(lockPath, "utf-8")).toBe(formatLockContent(100, ownerToken));

    releaseExclusiveLock(lockPath, 100, ownerToken);
    expect(existsSync(lockPath)).toBe(false);
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
    const ids = new CountingIdGenerator("lock");
    const staleToken = ids.next();
    const newToken = ids.next();
    writeFileSync(lockPath, formatLockContent(9999, staleToken));
    expect(
      tryAcquireExclusiveLock(lockPath, {
        pid: 100,
        ownerToken: newToken,
        isProcessRunning: () => false,
      }),
    ).toBe(true);
    expect(parseLockContent(readFileSync(lockPath, "utf-8").trim())).toEqual({
      pid: 100,
      token: newToken,
    });
  });

  test.each([200, 9999])(
    "does not steal a fresh lock created by PID %d during the stale-owner liveness check",
    (competingPid) => {
      const ids = new CountingIdGenerator("lock");
      const staleToken = ids.next();
      const competingToken = ids.next();
      const callerToken = ids.next();
      writeFileSync(lockPath, formatLockContent(9999, staleToken));

      expect(
        tryAcquireExclusiveLock(lockPath, {
          pid: 100,
          ownerToken: callerToken,
          isProcessRunning: (checkedPid) => {
            expect(checkedPid).toBe(9999);
            expect(
              tryAcquireExclusiveLock(lockPath, {
                pid: competingPid,
                ownerToken: competingToken,
                isProcessRunning: () => false,
              }),
            ).toBe(true);
            return false;
          },
        }),
      ).toBe(false);
      expect(parseLockContent(readFileSync(lockPath, "utf-8").trim())).toEqual({
        pid: competingPid,
        token: competingToken,
      });
      expect(readdirSync(dir)).toEqual([basename(lockPath)]);
    },
  );

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

    // Issue #6260 (PRRT ft82g): PID 0 signals the current process GROUP and
    // PID -1 signals EVERY process a user can signal to `process.kill`, so
    // both "succeed" as a liveness probe without naming a real process. A
    // corrupt/stale lock containing one must never be treated as a live
    // owner, or a caller could surface a `kill 0` / `kill -1` suggestion.
    test.each([0, -1, -100])("parseLockContent reports NaN for a non-positive PID (%d)", (pid) => {
      expect(parseLockContent(formatLockContent(pid)).pid).toBeNaN();
    });
  });

  describe("releaseExclusiveLock (compare-and-delete)", () => {
    test("warns without throwing when unlink fails unexpectedly", () => {
      expect(tryAcquireExclusiveLock(lockPath, { pid: 100 })).toBe(true);
      const unlinkError = Object.assign(new Error("permission denied"), { code: "EPERM" });
      const unlinkSpy = spyOn(fs, "unlinkSync").mockImplementation(() => {
        throw unlinkError;
      });
      const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});

      try {
        expect(() => releaseExclusiveLock(lockPath, 100)).not.toThrow();
        expect(warnSpy).toHaveBeenCalledWith(
          `src/utils/fileLock.ts: failed to release exclusive lock at ${lockPath}: permission denied`,
        );
        expect(unlinkSpy).toHaveBeenCalledTimes(1);
      } finally {
        unlinkSpy.mockRestore();
        warnSpy.mockRestore();
      }
      expect(existsSync(lockPath)).toBe(true);
    });

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
