import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { formatLockContent, tryAcquireExclusiveLock } from "../../src/utils/fileLock";
import { nodeLockFileSystem } from "../../src/utils/lockFileSystem";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { useScratchRoot } from "../helpers/scratchRoot";

describe("node lock filesystem contracts on every OS", () => {
  const scratch = useScratchRoot("file-lock-real-fs-");

  test("link refuses an existing destination with EEXIST and publishes into a free name", () => {
    const dir = scratch.next();
    const src = join(dir, "src");
    const dest = join(dir, "dest");
    writeFileSync(src, "source bytes");
    writeFileSync(dest, "destination bytes");
    expect(() => nodeLockFileSystem.link(src, dest)).toThrow(
      expect.objectContaining({ code: "EEXIST" }),
    );
    expect(readFileSync(dest, "utf8")).toBe("destination bytes");
    expect(existsSync(src)).toBe(true);
    expect(readFileSync(src, "utf8")).toBe("source bytes");
    const free = join(dir, "free");
    nodeLockFileSystem.link(src, free);
    expect(readFileSync(free, "utf8")).toBe("source bytes");
  });

  test.each(["openExclusive", "writeFile"] as const)(
    "%s refuses an existing name with EEXIST",
    (operation) => {
      const path = join(scratch.next(), "existing");
      writeFileSync(path, "existing bytes");
      const create = () => {
        if (operation === "writeFile") {
          nodeLockFileSystem.writeFile(path, "replacement");
        } else {
          // Close even if an implementation regression unexpectedly opens the existing file.
          const fd = nodeLockFileSystem.openExclusive(path);
          nodeLockFileSystem.close(fd);
        }
      };
      expect(create).toThrow(expect.objectContaining({ code: "EEXIST" }));
      expect(readFileSync(path, "utf8")).toBe("existing bytes");
    },
  );

  test("stat reports the exact inode and the number mtimeMs statSync reports", () => {
    const path = join(scratch.next(), "file");
    writeFileSync(path, "bytes");
    const stat = nodeLockFileSystem.stat(path);
    expect(stat.ino).toBe(statSync(path, { bigint: true }).ino);
    expect(stat.mtimeMs).toBe(statSync(path).mtimeMs);
  });

  test("stat is stable for unchanged files, hard links and renames", () => {
    const dir = scratch.next();
    const src = join(dir, "src");
    const linked = join(dir, "linked");
    const renamed = join(dir, "renamed");
    writeFileSync(src, "source bytes");
    const before = nodeLockFileSystem.stat(src);
    expect(nodeLockFileSystem.stat(src)).toEqual(before);
    nodeLockFileSystem.link(src, linked);
    expect(nodeLockFileSystem.stat(linked).ino).toBe(before.ino);
    nodeLockFileSystem.rename(src, renamed);
    expect(nodeLockFileSystem.stat(renamed)).toEqual(before);
    // Never require different files to have distinct rounded JS-number NTFS inode IDs.
  });

  test("rename replaces an existing destination and removes the tmp name", () => {
    const dir = scratch.next();
    const tmp = join(dir, "tmp");
    const dest = join(dir, "existing");
    writeFileSync(tmp, "tmp bytes");
    writeFileSync(dest, "old bytes");
    nodeLockFileSystem.rename(tmp, dest);
    expect(readFileSync(dest, "utf8")).toBe("tmp bytes");
    expect(existsSync(tmp)).toBe(false);
  });

  test("list returns directory entry names including subdirectories", () => {
    const dir = scratch.next();
    writeFileSync(join(dir, "file"), "bytes");
    mkdirSync(join(dir, "subdir"));
    expect(nodeLockFileSystem.list(dir).sort()).toEqual(["file", "subdir"]);
  });

  test("reclaim with a foreign open descriptor either succeeds exactly or retains stale bytes", () => {
    const dir = scratch.next();
    const lock = join(dir, "resource.lock");
    const stale = "99\nstale\nopaque  \n";
    const own = formatLockContent(101, "mine", "metadata");
    writeFileSync(lock, stale);
    const fd = openSync(lock, "r");
    try {
      let result: boolean | undefined;
      expect(() => {
        result = tryAcquireExclusiveLock(lock, {
          pid: 101,
          ownerToken: "mine",
          metadata: "metadata",
          isProcessRunning: () => false,
          idGenerator: new FakeIdGenerator(),
        });
      }).not.toThrow();
      if (result === true) {
        expect(readFileSync(lock, "utf8")).toBe(own);
      } else {
        expect(result).toBe(false);
        expect(readFileSync(lock, "utf8")).toBe(stale);
      }
    } finally {
      closeSync(fd);
    }
    expect(nodeLockFileSystem.list(dir)).toEqual(["resource.lock"]);
  });

  test("in-place supersession of a dead slot-zero guard completes without litter", () => {
    const dir = scratch.next();
    const lock = join(dir, "resource.lock");
    const stale = "99\nstale\nopaque  \n";
    writeFileSync(lock, stale);
    const { ino, mtimeMs } = nodeLockFileSystem.stat(lock);
    const hash = createHash("sha256").update(stale).digest("hex").slice(0, 32);
    const guard = `${lock}.reclaim.${Number(ino)}.${mtimeMs}.${hash}.0`;
    writeFileSync(guard, "98\ndead-guard");
    expect(
      tryAcquireExclusiveLock(lock, {
        pid: 101,
        ownerToken: "mine",
        metadata: "metadata",
        isProcessRunning: () => false,
        idGenerator: new FakeIdGenerator(),
      }),
    ).toBe(true);
    expect(readFileSync(lock, "utf8")).toBe(formatLockContent(101, "mine", "metadata"));
    expect(nodeLockFileSystem.list(dir)).toEqual(["resource.lock"]);
  });
});
