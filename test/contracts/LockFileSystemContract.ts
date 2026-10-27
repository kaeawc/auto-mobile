import { describe, expect, test } from "bun:test";
import type { LockFileSystem } from "../../src/utils/lockFileSystem";

export interface LockFileSystemHandle {
  fileSystem: LockFileSystem;
  /** An existing, empty directory every scenario works inside. */
  root: string;
  dispose?: () => Promise<void> | void;
}

function errorCode(body: () => unknown): string | undefined {
  try {
    body();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code;
  }
  return undefined;
}

/**
 * Shared behavioural contract for {@link LockFileSystem} (#11868): the in-memory fake and the
 * node-backed filesystem run the same create/link/rename/list scenarios, so the lock protocol
 * tests that rely on the fake see the error codes and inode semantics of a real POSIX tree.
 */
export function runLockFileSystemContract(
  name: string,
  make: () => Promise<LockFileSystemHandle>,
): void {
  const withFs = async (body: (fs: LockFileSystem, root: string) => void): Promise<void> => {
    const handle = await make();
    try {
      body(handle.fileSystem, handle.root);
    } finally {
      await handle.dispose?.();
    }
  };

  describe(`LockFileSystem contract: ${name}`, () => {
    test("mkdir creates nested directories and is idempotent", () =>
      withFs((fs, root) => {
        fs.mkdir(`${root}/a/b`);
        fs.mkdir(`${root}/a/b`);
        expect(fs.exists(`${root}/a/b`)).toBe(true);
        expect(fs.list(`${root}/a`)).toEqual(["b"]);
      }));

    test("mkdir over an existing file fails with EEXIST", () =>
      withFs((fs, root) => {
        fs.writeFile(`${root}/f`, "x");
        expect(errorCode(() => fs.mkdir(`${root}/f`))).toBe("EEXIST");
      }));

    test("list returns entry names in sorted order", () =>
      withFs((fs, root) => {
        for (const entry of ["c", "a", "B", "e"]) {
          fs.writeFile(`${root}/${entry}`, entry);
        }
        fs.mkdir(`${root}/d`);
        expect(fs.list(root)).toEqual(["B", "a", "c", "d", "e"]);
      }));

    test("list reports ENOENT for a missing directory and ENOTDIR for a file", () =>
      withFs((fs, root) => {
        fs.writeFile(`${root}/f`, "x");
        expect(errorCode(() => fs.list(`${root}/missing`))).toBe("ENOENT");
        expect(errorCode(() => fs.list(`${root}/f`))).toBe("ENOTDIR");
      }));

    test("openExclusive creates an empty file and refuses an existing one", () =>
      withFs((fs, root) => {
        const fd = fs.openExclusive(`${root}/lock`);
        fs.close(fd);
        expect(fs.readText(`${root}/lock`)).toBe("");
        expect(errorCode(() => fs.openExclusive(`${root}/lock`))).toBe("EEXIST");
      }));

    test("openExclusive and writeFile report ENOENT when the parent is missing", () =>
      withFs((fs, root) => {
        expect(errorCode(() => fs.openExclusive(`${root}/nope/lock`))).toBe("ENOENT");
        expect(errorCode(() => fs.writeFile(`${root}/nope/lock`, "x"))).toBe("ENOENT");
      }));

    test("a descriptor write is visible after close", () =>
      withFs((fs, root) => {
        const fd = fs.openExclusive(`${root}/lock`);
        fs.write(fd, "owner-1");
        fs.close(fd);
        expect(fs.readText(`${root}/lock`)).toBe("owner-1");
      }));

    test("successive writes through one descriptor append", () =>
      withFs((fs, root) => {
        const fd = fs.openExclusive(`${root}/lock`);
        fs.write(fd, "ab");
        fs.write(fd, "cd");
        fs.close(fd);
        expect(fs.readText(`${root}/lock`)).toBe("abcd");
      }));

    test("write and close on an unknown descriptor fail with EBADF", () =>
      withFs((fs) => {
        expect(errorCode(() => fs.write(987_654, "x"))).toBe("EBADF");
        expect(errorCode(() => fs.close(987_654))).toBe("EBADF");
      }));

    test("writeFile is exclusive and leaves existing bytes untouched", () =>
      withFs((fs, root) => {
        fs.writeFile(`${root}/pub`, "first");
        expect(errorCode(() => fs.writeFile(`${root}/pub`, "second"))).toBe("EEXIST");
        expect(fs.readText(`${root}/pub`)).toBe("first");
      }));

    test("readText and stat report ENOENT for a missing file", () =>
      withFs((fs, root) => {
        expect(errorCode(() => fs.readText(`${root}/missing`))).toBe("ENOENT");
        expect(errorCode(() => fs.stat(`${root}/missing`))).toBe("ENOENT");
      }));

    test("stat reports a finite mtime and distinct inodes for distinct files", () =>
      withFs((fs, root) => {
        fs.writeFile(`${root}/a`, "a");
        fs.writeFile(`${root}/b`, "b");
        const a = fs.stat(`${root}/a`);
        expect(Number.isFinite(a.mtimeMs)).toBe(true);
        expect(a.ino).not.toBe(fs.stat(`${root}/b`).ino);
      }));

    test("rename keeps the inode and replaces an existing destination", () =>
      withFs((fs, root) => {
        fs.writeFile(`${root}/from`, "moved");
        fs.writeFile(`${root}/to`, "replaced");
        const { ino } = fs.stat(`${root}/from`);
        fs.rename(`${root}/from`, `${root}/to`);
        expect(fs.exists(`${root}/from`)).toBe(false);
        expect(fs.readText(`${root}/to`)).toBe("moved");
        expect(fs.stat(`${root}/to`).ino).toBe(ino);
      }));

    test("rename reports ENOENT for a missing source or destination directory", () =>
      withFs((fs, root) => {
        fs.writeFile(`${root}/f`, "x");
        expect(errorCode(() => fs.rename(`${root}/missing`, `${root}/x`))).toBe("ENOENT");
        expect(errorCode(() => fs.rename(`${root}/f`, `${root}/nope/x`))).toBe("ENOENT");
        expect(fs.readText(`${root}/f`)).toBe("x");
      }));

    test("link shares the inode and survives unlinking the source", () =>
      withFs((fs, root) => {
        fs.writeFile(`${root}/src`, "shared");
        fs.link(`${root}/src`, `${root}/dst`);
        expect(fs.stat(`${root}/dst`).ino).toBe(fs.stat(`${root}/src`).ino);
        fs.unlink(`${root}/src`);
        expect(fs.readText(`${root}/dst`)).toBe("shared");
      }));

    test("link fails with EEXIST for an existing destination and ENOENT for a missing source", () =>
      withFs((fs, root) => {
        fs.writeFile(`${root}/a`, "a");
        fs.writeFile(`${root}/b`, "b");
        expect(errorCode(() => fs.link(`${root}/a`, `${root}/b`))).toBe("EEXIST");
        expect(errorCode(() => fs.link(`${root}/missing`, `${root}/c`))).toBe("ENOENT");
        expect(errorCode(() => fs.link(`${root}/a`, `${root}/nope/c`))).toBe("ENOENT");
      }));

    test("unlink removes a file and reports ENOENT the second time", () =>
      withFs((fs, root) => {
        fs.writeFile(`${root}/f`, "x");
        fs.unlink(`${root}/f`);
        expect(fs.exists(`${root}/f`)).toBe(false);
        expect(errorCode(() => fs.unlink(`${root}/f`))).toBe("ENOENT");
      }));

    test("exists is true for files and directories and false otherwise", () =>
      withFs((fs, root) => {
        fs.writeFile(`${root}/f`, "x");
        expect(fs.exists(`${root}/f`)).toBe(true);
        expect(fs.exists(root)).toBe(true);
        expect(fs.exists(`${root}/missing`)).toBe(false);
      }));
  });
}
