import { describe, expect, test } from "bun:test";
import {
  normalizeSharedStorageRelativePath,
  normalizeSharedStorageNamespace,
  sharedStorageFileSchema,
} from "../../src/server/sharedStorageContract";

describe("shared-storage contract", () => {
  test("accepts all established file-content modes", () => {
    for (const file of [
      { sourcePath: "/tmp/fixture.pdf", destinationPath: "docs/fixture.pdf" },
      { contentText: "hello", destinationPath: "notes/welcome.txt" },
      {
        contentBase64: Buffer.from([0, 1, 2]).toString("base64"),
        destinationPath: "media/image.bin",
      },
    ]) {
      expect(sharedStorageFileSchema.safeParse(file).success).toBe(true);
    }
  });

  test("rejects unsafe namespace resets before an ADB operation can be constructed", () => {
    for (const namespace of ["", ".", "..", "a/b", "a\\b", "a\0b"]) {
      expect(() => normalizeSharedStorageNamespace(namespace)).toThrow("single directory name");
    }
    expect(() => normalizeSharedStorageNamespace("../Downloads")).toThrow("single directory name");
  });

  test("rejects unsafe file destinations and ambiguous content sources", () => {
    const unsafe = sharedStorageFileSchema.safeParse({
      contentText: "safe",
      destinationPath: "../outside.txt",
    });
    expect(unsafe.success).toBe(false);

    const ambiguous = sharedStorageFileSchema.safeParse({
      contentText: "safe",
      contentBase64: "c2FmZQ==",
      destinationPath: "file.txt",
    });
    expect(ambiguous.success).toBe(false);
  });

  test("rejects NUL bytes in file destinations while accepting ordinary relative paths", () => {
    expect(normalizeSharedStorageRelativePath("docs/fixture.pdf")).toBe("docs/fixture.pdf");
    expect(() => normalizeSharedStorageRelativePath("a\0b")).toThrow("destinationPath");
    expect(
      sharedStorageFileSchema.safeParse({
        contentText: "safe",
        destinationPath: "a\0b",
      }).success,
    ).toBe(false);
  });
});
