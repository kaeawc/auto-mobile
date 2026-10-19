import { describe, expect, test } from "bun:test";
import type { PrototypeAssetFileReader } from "../../src/features/prototype/prototypeAssetUploader";

export interface PrototypeAssetFileReaderContractHarness {
  reader: PrototypeAssetFileReader;
  /** Places a file of the given bytes at the returned path. */
  addFile(name: string, bytes: Buffer): Promise<string>;
  /** Places an empty directory at the returned path. */
  addDirectory(name: string): Promise<string>;
  /** A path nothing has been placed at. */
  missingPath(name: string): string;
}

/**
 * Shared contract for every {@link PrototypeAssetFileReader}: stat distinguishes files from
 * directories and reports sizes, a missing path rejects with ENOENT, and readFile hands back
 * the bytes without aliasing storage. Run against nodePrototypeAssetFileReader (private temp
 * directory) and FakePrototypeAssetFileReader (issue #11868).
 */
export const runPrototypeAssetFileReaderContract = (
  description: string,
  make: () => Promise<PrototypeAssetFileReaderContractHarness>,
): void => {
  describe(`PrototypeAssetFileReader contract: ${description}`, function () {
    test("stats a file as a file with its byte size", async function () {
      const { reader, addFile } = await make();
      const path = await addFile("logo.png", Buffer.from([1, 2, 3, 4, 5]));

      const stat = await reader.stat(path);

      expect(stat.isFile()).toBe(true);
      expect(stat.size).toBe(5);
    });

    test("stats a directory as not a file", async function () {
      const { reader, addDirectory } = await make();
      const path = await addDirectory("fonts");

      expect((await reader.stat(path)).isFile()).toBe(false);
    });

    test("stat rejects with ENOENT for a missing path", async function () {
      const { reader, missingPath } = await make();

      await expect(reader.stat(missingPath("nope.png"))).rejects.toMatchObject({ code: "ENOENT" });
    });

    test("reads back the exact bytes", async function () {
      const { reader, addFile } = await make();
      const path = await addFile("blob.bin", Buffer.from([0, 255, 128, 7]));

      expect([...(await reader.readFile(path))]).toEqual([0, 255, 128, 7]);
    });

    test("readFile rejects with ENOENT for a missing path", async function () {
      const { reader, missingPath } = await make();

      await expect(reader.readFile(missingPath("nope.png"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });

    test("readFile rejects with EISDIR for a directory", async function () {
      const { reader, addDirectory } = await make();
      const path = await addDirectory("fonts");

      await expect(reader.readFile(path)).rejects.toMatchObject({ code: "EISDIR" });
    });

    test("mutating a returned buffer does not change later reads", async function () {
      const { reader, addFile } = await make();
      const path = await addFile("logo.png", Buffer.from([9, 9, 9]));

      (await reader.readFile(path)).fill(0);

      expect([...(await reader.readFile(path))]).toEqual([9, 9, 9]);
    });
  });
};
