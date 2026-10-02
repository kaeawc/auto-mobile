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
