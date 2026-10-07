import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultFileSystem } from "../../../src/utils/filesystem/DefaultFileSystem";

test("filesystem cleanup stats identify plain files and directories", async () => {
  const dir = await mkdtemp(join(tmpdir(), "screenshot-stat-"));
  try {
    const file = join(dir, "screenshot.png");
    const subdir = join(dir, "snapshot-of-directory.png");
    await writeFile(file, "frame");
    await mkdir(subdir);
    const files = new DefaultFileSystem();
    expect((await files.stat(file)).isFile?.()).toBe(true);
    expect((await files.lstat(subdir)).isFile()).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === "win32")(
  "cleanup lstat excludes screenshot-shaped symlinks",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "screenshot-lstat-"));
    try {
      const target = join(dir, "target.png");
      const link = join(dir, "snapshot-of-link.png");
      await writeFile(target, "frame");
      await symlink(target, link);
      const files = new DefaultFileSystem();
      expect((await files.stat(link)).isFile?.()).toBe(true);
      expect((await files.lstat(link)).isFile()).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("readFileHead returns only the leading bytes, or the whole file when it is shorter", async () => {
  const dir = await mkdtemp(join(tmpdir(), "file-head-"));
  try {
    const file = join(dir, "data.bin");
    await writeFile(file, Buffer.from("0123456789"));
    const files = new DefaultFileSystem();
    expect((await files.readFileHead(file, 4)).toString("latin1")).toBe("0123");
    expect((await files.readFileHead(file, 64)).toString("latin1")).toBe("0123456789");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
