import { describe, expect, test } from "bun:test";
import { mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import {
  FsSocketInodeProbe,
  sameSocketInode,
  type SocketInodeIdentity,
} from "../../src/daemon/socketInodeProbe";

const isWindows = platform() === "win32";

describe("sameSocketInode", () => {
  test("matches identical {dev, ino}", () => {
    const a: SocketInodeIdentity = { dev: 1, ino: 42 };
    const b: SocketInodeIdentity = { dev: 1, ino: 42 };
    expect(sameSocketInode(a, b)).toBe(true);
  });

  test("does not match a different ino on the same dev", () => {
    const a: SocketInodeIdentity = { dev: 1, ino: 42 };
    const b: SocketInodeIdentity = { dev: 1, ino: 43 };
    expect(sameSocketInode(a, b)).toBe(false);
  });

  test("does not match a different dev with the same ino", () => {
    const a: SocketInodeIdentity = { dev: 1, ino: 42 };
    const b: SocketInodeIdentity = { dev: 2, ino: 42 };
    expect(sameSocketInode(a, b)).toBe(false);
  });

  test("treats consistently-absent (undefined on both sides) as a match", () => {
    expect(sameSocketInode(undefined, undefined)).toBe(true);
  });

  test("does not match when the path appeared between the two stats", () => {
    expect(sameSocketInode(undefined, { dev: 1, ino: 42 })).toBe(false);
  });

  test("does not match when the path disappeared between the two stats", () => {
    expect(sameSocketInode({ dev: 1, ino: 42 }, undefined)).toBe(false);
  });
});

describe("FsSocketInodeProbe", () => {
  const tempDirs: string[] = [];

  function createTempFile(): string {
    const dir = mkdtempSync(join(tmpdir(), "socket-inode-probe-test-"));
    tempDirs.push(dir);
    const filePath = join(dir, "daemon.sock");
    writeFileSync(filePath, "placeholder");
    return filePath;
  }

  function cleanup(): void {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  }

  test("returns the same identity for two stats of an unchanged file", () => {
    const filePath = createTempFile();
    try {
      const probe = new FsSocketInodeProbe();
      const first = probe.statSocket(filePath);
      const second = probe.statSocket(filePath);

      expect(first).toBeDefined();
      expect(sameSocketInode(first, second)).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("returns undefined for a path that does not exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "socket-inode-probe-missing-test-"));
    try {
      const probe = new FsSocketInodeProbe();
      expect(probe.statSocket(join(dir, "does-not-exist.sock"))).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // inode numbers are not meaningful on Windows the same way; this specifically
  // exercises unlink-then-recreate producing a different POSIX inode.
  (isWindows ? test.skip : test)(
    "detects a different inode after the path is unlinked and recreated (a winner replacing the socket)",
    async () => {
      const filePath = createTempFile();
      try {
        const probe = new FsSocketInodeProbe();
        const before = probe.statSocket(filePath);

        unlinkSync(filePath);
        writeFileSync(filePath, "a different file at the same path");

        const after = probe.statSocket(filePath);
        expect(before).toBeDefined();
        expect(after).toBeDefined();
        expect(sameSocketInode(before, after)).toBe(false);
      } finally {
        cleanup();
      }
    },
  );

  (isWindows ? test.skip : test)(
    "does not falsely flag a rename-in-place of the SAME inode as changed",
    async () => {
      const filePath = createTempFile();
      const renamedPath = `${filePath}.renamed`;
      try {
        const probe = new FsSocketInodeProbe();
        const before = probe.statSocket(filePath);

        renameSync(filePath, renamedPath);

        const after = probe.statSocket(renamedPath);
        expect(sameSocketInode(before, after)).toBe(true);
      } finally {
        rmSync(renamedPath, { force: true });
        cleanup();
      }
    },
  );
});
