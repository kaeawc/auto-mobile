import { describe, expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ActionableError } from "../../src/models/ActionableError";
import {
  releaseExclusiveLock,
  takeOverExclusiveLock,
  tryAcquireExclusiveLock,
} from "../../src/utils/fileLock";
import { logger } from "../../src/utils/logger";
import { FakeLockFileSystem } from "../fakes/FakeLockFileSystem";
import { useScratchRoot } from "../helpers/scratchRoot";

const options = { pid: 101, isProcessRunning: () => false };

function expectCreateError(acquire: () => boolean, code: string): void {
  let caught: unknown;
  try {
    acquire();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ActionableError);
  expect(caught).toMatchObject({
    message: expect.stringMatching(/^Failed to create exclusive lock file at/),
    cause: expect.objectContaining({ code }),
  });
}

describe("exclusive lock error-class parity: fake filesystem", () => {
  test("occupied parent reports held, takeover fails and release is a no-op without warnings", () => {
    const fs = new FakeLockFileSystem();
    fs.seed("/parent", "occupied");
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect(tryAcquireExclusiveLock("/parent/lock", { ...options, fileSystem: fs })).toBe(false);
      expect(
        takeOverExclusiveLock(
          "/parent/lock",
          { pid: 99, token: undefined },
          { ...options, fileSystem: fs },
        ),
      ).toBe(false);
      expect(() => releaseExclusiveLock("/parent/lock", 101, undefined, fs)).not.toThrow();
      expect(fs.paths()).toEqual(["/parent"]);
      expect(fs.readText("/parent")).toBe("occupied");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("file ancestor remains an actionable ENOTDIR error", () => {
    const fs = new FakeLockFileSystem();
    fs.seed("/ancestor", "occupied");
    expectCreateError(
      () => tryAcquireExclusiveLock("/ancestor/parent/lock", { ...options, fileSystem: fs }),
      "ENOTDIR",
    );
    expect(fs.paths()).toEqual(["/ancestor"]);
  });
});

describe("exclusive lock error-class parity: real filesystem", () => {
  const scratch = useScratchRoot("file-lock-error-parity-");

  test.each(["parent", "grandparent"])("file at %s follows the platform mkdir error", (kind) => {
    const root = scratch.next();
    const file = join(root, "occupied");
    writeFileSync(file, "occupied");
    const parent = kind === "parent" ? file : join(file, "parent");
    const lock = join(parent, "lock");
    let code: string | undefined;
    try {
      mkdirSync(parent, { recursive: true });
    } catch (error) {
      code = (error as NodeJS.ErrnoException).code;
    }
    if (!code) {
      throw new Error("Expected raw recursive mkdir to refuse a file path component");
    }
    if (code === "EEXIST") {
      expect(tryAcquireExclusiveLock(lock, options)).toBe(false);
    } else {
      expectCreateError(() => tryAcquireExclusiveLock(lock, options), code);
    }
    expect(existsSync(lock)).toBe(false);
    expect(readFileSync(file, "utf8")).toBe("occupied");
    expect(readdirSync(root)).toEqual(["occupied"]);
  });

  test("missing parent and grandparent are created", () => {
    const root = scratch.next();
    const lock = join(root, "grandparent", "parent", "lock");
    expect(tryAcquireExclusiveLock(lock, options)).toBe(true);
    expect(readFileSync(lock, "utf8")).toBe("101");
    expect(readdirSync(join(root, "grandparent", "parent"))).toEqual(["lock"]);
  });

  test("directory at lock path reports held", () => {
    const root = scratch.next();
    const lock = join(root, "lock");
    mkdirSync(lock);
    expect(tryAcquireExclusiveLock(lock, options)).toBe(false);
    expect(statSync(lock).isDirectory()).toBe(true);
    expect(readdirSync(root)).toEqual(["lock"]);
  });

  const skipPermissions = process.platform === "win32" || process.getuid?.() === 0;

  test.skipIf(skipPermissions)("0500 directory without a lock throws actionable EACCES", () => {
    const root = scratch.next();
    chmodSync(root, 0o500);
    try {
      expectCreateError(() => tryAcquireExclusiveLock(join(root, "lock"), options), "EACCES");
      expect(readdirSync(root)).toEqual([]);
    } finally {
      chmodSync(root, 0o700);
    }
  });

  test.skipIf(skipPermissions)("0500 directory with a dead owner preserves bytes and inode", () => {
    const root = scratch.next();
    const lock = join(root, "lock");
    writeFileSync(lock, "99\nstale");
    const inode = statSync(lock).ino;
    chmodSync(root, 0o500);
    try {
      expect(tryAcquireExclusiveLock(lock, options)).toBe(false);
      expect(readFileSync(lock, "utf8")).toBe("99\nstale");
      expect(statSync(lock).ino).toBe(inode);
      expect(readdirSync(root)).toEqual(["lock"]);
    } finally {
      chmodSync(root, 0o700);
    }
  });

  test.skipIf(skipPermissions)("release in a 0500 directory leaves its lock untouched", () => {
    const root = scratch.next();
    const lock = join(root, "lock");
    writeFileSync(lock, "101");
    const inode = statSync(lock).ino;
    chmodSync(root, 0o500);
    try {
      expect(() => releaseExclusiveLock(lock, 101)).not.toThrow();
      expect(readFileSync(lock, "utf8")).toBe("101");
      expect(statSync(lock).ino).toBe(inode);
      expect(readdirSync(root)).toEqual(["lock"]);
    } finally {
      chmodSync(root, 0o700);
    }
  });
});
