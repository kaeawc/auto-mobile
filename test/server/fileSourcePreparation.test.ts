import { describe, expect, mock, spyOn, test } from "bun:test";
import { join } from "node:path";
import { ActionableError } from "../../src/models";
import {
  prepareFileSource,
  type FileSourceFileSystem,
} from "../../src/server/fileSourcePreparation";
import { logger } from "../../src/utils/logger";

const FAKE_DIR = "/fake/app-file";

function fakeFileSystem() {
  return {
    stat: mock(async () => ({ size: 7, isFile: () => true })),
    mkdtemp: mock(async () => FAKE_DIR),
    writeFileBuffer: mock(async (_path: string, _buffer: Buffer) => {}),
    rm: mock(async (_path: string) => {}),
  } satisfies FileSourceFileSystem;
}

describe("prepareFileSource", () => {
  for (const cleanupFails of [false, true]) {
    test(`preserves write error and cleans directory (cleanup fails: ${cleanupFails})`, async () => {
      const files = fakeFileSystem();
      const original = new Error("disk full");
      const cleanupError = new Error("cleanup denied");
      files.writeFileBuffer.mockImplementation(async () => {
        throw original;
      });
      if (cleanupFails) {
        files.rm.mockImplementation(async () => {
          throw cleanupError;
        });
      }
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        await expect(prepareFileSource({ contentText: "hello" }, files)).rejects.toBe(original);
        expect(files.rm).toHaveBeenCalledTimes(1);
        expect(files.rm).toHaveBeenCalledWith(FAKE_DIR);
        if (cleanupFails) {
          expect(warn).toHaveBeenCalledWith(
            "Failed to remove inline app file directory: cleanup denied",
            cleanupError,
          );
        } else {
          expect(warn).not.toHaveBeenCalled();
        }
      } finally {
        warn.mockRestore();
      }
    });
  }

  test("hands directory ownership to cleanup on success", async () => {
    const files = fakeFileSystem();
    const source = await prepareFileSource({ contentText: "hé" }, files);
    expect(source.path).toBe(join(FAKE_DIR, "content"));
    expect(source.byteCount).toBe(3);
    expect(files.writeFileBuffer).toHaveBeenCalledWith(source.path, Buffer.from("hé"));
    expect(files.rm).not.toHaveBeenCalled();
    expect(source.cleanup).toBeFunction();
    await source.cleanup?.();
    expect(files.rm).toHaveBeenCalledTimes(1);
    expect(files.rm).toHaveBeenCalledWith(FAKE_DIR);
  });

  for (const contentBase64 of ["", "eB==", "eA==\n"]) {
    test(`rejects invalid base64 ${JSON.stringify(contentBase64)} before creating a directory`, async () => {
      const files = fakeFileSystem();
      await expect(prepareFileSource({ contentBase64 }, files)).rejects.toBeInstanceOf(
        ActionableError,
      );
      expect(files.mkdtemp).not.toHaveBeenCalled();
    });
  }

  test("accepts unpadded base64", async () => {
    const files = fakeFileSystem();
    const source = await prepareFileSource({ contentBase64: "eA" }, files);
    expect(source.byteCount).toBe(1);
    expect(files.writeFileBuffer).toHaveBeenCalledWith(source.path, Buffer.from("x"));
  });

  test("rejects a sourcePath that is not a file", async () => {
    const files = fakeFileSystem();
    files.stat.mockImplementation(async () => ({ size: 7, isFile: () => false }));
    await expect(
      prepareFileSource({ sourcePath: "/fake/directory" }, files),
    ).rejects.toBeInstanceOf(ActionableError);
    expect(files.stat).toHaveBeenCalledWith("/fake/directory");
    expect(files.mkdtemp).not.toHaveBeenCalled();
  });

  test("returns the source file path and byte count without temporary storage", async () => {
    const files = fakeFileSystem();
    expect(await prepareFileSource({ sourcePath: "/fake/source.txt" }, files)).toEqual({
      path: "/fake/source.txt",
      byteCount: 7,
    });
    expect(files.mkdtemp).not.toHaveBeenCalled();
    expect(files.writeFileBuffer).not.toHaveBeenCalled();
    expect(files.rm).not.toHaveBeenCalled();
  });
});
