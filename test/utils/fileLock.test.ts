import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { releaseExclusiveLock, tryAcquireExclusiveLock } from "../../src/utils/fileLock";

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
    expect(tryAcquireExclusiveLock(lockPath, { pid: 100, isProcessRunning: () => true })).toBe(true);
    expect(readFileSync(lockPath, "utf-8").trim()).toBe("100");
  });

  test("fails when a different live holder owns it", () => {
    writeFileSync(lockPath, "9999");
    expect(tryAcquireExclusiveLock(lockPath, { pid: 100, isProcessRunning: () => true })).toBe(false);
    expect(readFileSync(lockPath, "utf-8").trim()).toBe("9999");
  });

  test("treats an empty lock file as held (writer mid-write)", () => {
    writeFileSync(lockPath, "");
    expect(tryAcquireExclusiveLock(lockPath, { pid: 100, isProcessRunning: () => true })).toBe(false);
  });

  test("treats an unreadable PID as held", () => {
    writeFileSync(lockPath, "not-a-pid");
    expect(tryAcquireExclusiveLock(lockPath, { pid: 100, isProcessRunning: () => true })).toBe(false);
  });

  test("reclaims a lock left by a dead holder", () => {
    writeFileSync(lockPath, "9999");
    expect(tryAcquireExclusiveLock(lockPath, { pid: 100, isProcessRunning: () => false })).toBe(true);
    expect(readFileSync(lockPath, "utf-8").trim()).toBe("100");
  });

  test("own live PID is held by default but reclaimed under reclaimOwnPid", () => {
    writeFileSync(lockPath, "100");

    // Default (daemon coordinator): a same-PID probe reads as held.
    expect(tryAcquireExclusiveLock(lockPath, { pid: 100, isProcessRunning: () => true })).toBe(false);

    // reclaimOwnPid (migration singleton): a leaked own-PID lock is reclaimed.
    expect(
      tryAcquireExclusiveLock(lockPath, { pid: 100, isProcessRunning: () => true, reclaimOwnPid: true })
    ).toBe(true);
    expect(readFileSync(lockPath, "utf-8").trim()).toBe("100");
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
