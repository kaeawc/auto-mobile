import { describe, expect, test } from "bun:test";
import path from "node:path";
import type { FileSystem } from "../../src/utils/filesystem/DefaultFileSystem";

export interface FileSystemContractOptions {
  root: string;
}

export const runFileSystemContract = (
  description: string,
  makeFileSystem: () => FileSystem,
  options: FileSystemContractOptions,
): void => {
  describe(`FileSystem contract: ${description}`, function () {
    test("string files round-trip and appear in readdir", async function () {
      const fileSystem = makeFileSystem();
      const dir = path.join(options.root, "strings");
      const filePath = path.join(dir, "hello.txt");

      await fileSystem.ensureDir(dir);
      await fileSystem.writeFile(filePath, "hello");

      expect(await fileSystem.readFile(filePath)).toBe("hello");
      expect(await fileSystem.pathExists(filePath)).toBe(true);
      expect(fileSystem.existsSync(filePath)).toBe(true);
      expect(await fileSystem.readdir(dir)).toContain("hello.txt");
    });

    test("buffer files round-trip and expose size in stat", async function () {
      const fileSystem = makeFileSystem();
      const dir = path.join(options.root, "buffers");
      const filePath = path.join(dir, "bytes.bin");
      const data = Buffer.from([1, 2, 3, 4]);

      await fileSystem.ensureDir(dir);
      await fileSystem.writeFileBuffer(filePath, data);

      expect(await fileSystem.readFileBuffer(filePath)).toEqual(data);
      expect((await fileSystem.stat(filePath)).size).toBe(data.length);
    });

    test("unlink removes files", async function () {
      const fileSystem = makeFileSystem();
      await fileSystem.ensureDir(options.root);
      const filePath = path.join(options.root, "delete-me.txt");

      await fileSystem.writeFile(filePath, "delete");
      await fileSystem.unlink(filePath);

      expect(await fileSystem.pathExists(filePath)).toBe(false);
    });

    test("rename moves files", async function () {
      const fileSystem = makeFileSystem();
      await fileSystem.ensureDir(options.root);
      const oldPath = path.join(options.root, "old.txt");
      const newPath = path.join(options.root, "new.txt");

      await fileSystem.writeFile(oldPath, "moved");
      await fileSystem.rename(oldPath, newPath);

      expect(await fileSystem.pathExists(oldPath)).toBe(false);
      expect(await fileSystem.readFile(newPath)).toBe("moved");
    });

    test("remove deletes directories", async function () {
      const fileSystem = makeFileSystem();
      const dir = path.join(options.root, "remove-dir");

      await fileSystem.ensureDir(dir);
      await fileSystem.remove(dir);

      expect(await fileSystem.pathExists(dir)).toBe(false);
    });

    test("writeFile rejects when the target directory does not exist", async function () {
      const fileSystem = makeFileSystem();
      const filePath = path.join(options.root, "missing-dir", "orphan.txt");

      await expect(fileSystem.writeFile(filePath, "data")).rejects.toThrow();
      expect(await fileSystem.pathExists(filePath)).toBe(false);
    });

    test("readdir rejects a directory that does not exist", async function () {
      const fileSystem = makeFileSystem();
      const dir = path.join(options.root, "never-created");

      await expect(fileSystem.readdir(dir)).rejects.toThrow();
    });

    test("readdir lists only direct children of the named directory", async function () {
      const fileSystem = makeFileSystem();
      const dir = path.join(options.root, "listing");
      const sibling = path.join(options.root, "listing-sibling");

      await fileSystem.ensureDir(dir);
      await fileSystem.ensureDir(sibling);
      await fileSystem.writeFile(path.join(dir, "inside.txt"), "in");
      await fileSystem.writeFile(path.join(sibling, "outside.txt"), "out");

      const entries = (await fileSystem.readdir(dir)).sort();
      // The sibling directory shares a name PREFIX ("listing" vs
      // "listing-sibling"), so a raw substring match would leak a mangled
      // fragment of its child into this listing. The boundary match yields
      // exactly the one direct child.
      expect(entries).toEqual(["inside.txt"]);
    });

    test("remove recursively deletes a directory's children", async function () {
      const fileSystem = makeFileSystem();
      const dir = path.join(options.root, "recursive");
      const child = path.join(dir, "child.txt");

      await fileSystem.ensureDir(dir);
      await fileSystem.writeFile(child, "bye");
      await fileSystem.remove(dir);

      expect(await fileSystem.pathExists(dir)).toBe(false);
      // The child must not survive its removed parent.
      expect(await fileSystem.pathExists(child)).toBe(false);
    });

    test("stat reports byte length, not UTF-16 code-unit count", async function () {
      const fileSystem = makeFileSystem();
      const dir = path.join(options.root, "sizes");
      const filePath = path.join(dir, "accent.txt");
      // "é" is two UTF-8 bytes but one UTF-16 code unit; content.length would
      // report 1, a real stat reports 2.
      const content = "é";

      await fileSystem.ensureDir(dir);
      await fileSystem.writeFile(filePath, content);

      expect((await fileSystem.stat(filePath)).size).toBe(Buffer.byteLength(content, "utf8"));
    });

    test("stat rejects a file that does not exist", async function () {
      const fileSystem = makeFileSystem();
      const filePath = path.join(options.root, "absent.txt");

      await expect(fileSystem.stat(filePath)).rejects.toThrow();
    });
  });
};
