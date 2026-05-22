import { describe, expect, test } from "bun:test";
import path from "node:path";
import type { FileSystem } from "../../src/utils/filesystem/DefaultFileSystem";

export interface FileSystemContractOptions {
  root: string;
}

export const runFileSystemContract = (
  description: string,
  makeFileSystem: () => FileSystem,
  options: FileSystemContractOptions
): void => {
  describe(`FileSystem contract: ${description}`, function() {
    test("string files round-trip and appear in readdir", async function() {
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

    test("buffer files round-trip and expose size in stat", async function() {
      const fileSystem = makeFileSystem();
      const dir = path.join(options.root, "buffers");
      const filePath = path.join(dir, "bytes.bin");
      const data = Buffer.from([1, 2, 3, 4]);

      await fileSystem.ensureDir(dir);
      await fileSystem.writeFileBuffer(filePath, data);

      expect(await fileSystem.readFileBuffer(filePath)).toEqual(data);
      expect((await fileSystem.stat(filePath)).size).toBe(data.length);
    });

    test("unlink removes files", async function() {
      const fileSystem = makeFileSystem();
      const filePath = path.join(options.root, "delete-me.txt");

      await fileSystem.writeFile(filePath, "delete");
      await fileSystem.unlink(filePath);

      expect(await fileSystem.pathExists(filePath)).toBe(false);
    });

    test("rename moves files", async function() {
      const fileSystem = makeFileSystem();
      const oldPath = path.join(options.root, "old.txt");
      const newPath = path.join(options.root, "new.txt");

      await fileSystem.writeFile(oldPath, "moved");
      await fileSystem.rename(oldPath, newPath);

      expect(await fileSystem.pathExists(oldPath)).toBe(false);
      expect(await fileSystem.readFile(newPath)).toBe("moved");
    });

    test("remove deletes directories", async function() {
      const fileSystem = makeFileSystem();
      const dir = path.join(options.root, "remove-dir");

      await fileSystem.ensureDir(dir);
      await fileSystem.remove(dir);

      expect(await fileSystem.pathExists(dir)).toBe(false);
    });
  });
};
