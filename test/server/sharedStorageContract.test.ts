import { describe, expect, test } from "bun:test";
import { putAppFileSchema } from "../../src/server/appFileContract";
import {
  normalizeSharedStorageRelativePath,
  normalizeSharedStorageNamespace,
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
      expect(
        putAppFileSchema.safeParse({
          target: { domain: "user_files", namespace: "run-42" },
          files: [file],
        }).success,
      ).toBe(true);
    }
  });

  test("user_files accepts both supported platform routes without an Android default", () => {
    const args = {
      target: { domain: "user_files", namespace: "run-42" },
      files: [{ contentText: "x", destinationPath: "x.txt" }],
    };
    expect(putAppFileSchema.parse(args).platform).toBeUndefined();
    expect(putAppFileSchema.safeParse({ ...args, platform: "ios" }).success).toBe(true);
    expect(putAppFileSchema.safeParse({ ...args, platform: "android" }).success).toBe(true);
  });

  test("rejects unsafe namespace resets before an ADB operation can be constructed", () => {
    for (const namespace of ["", ".", "..", "a/b", "a\\b", "a\0b"]) {
      expect(
        putAppFileSchema.safeParse({
          target: { domain: "user_files", namespace, reset: true },
          files: [{ contentText: "safe", destinationPath: "file.txt" }],
        }).success,
      ).toBe(false);
    }
    expect(() => normalizeSharedStorageNamespace("../Downloads")).toThrow("single directory name");
  });

  test("rejects unsafe file destinations and ambiguous content sources", () => {
    const unsafe = putAppFileSchema.safeParse({
      target: { domain: "user_files", namespace: "run-42" },
      files: [{ contentText: "safe", destinationPath: "../outside.txt" }],
    });
    expect(unsafe.success).toBe(false);

    const ambiguous = putAppFileSchema.safeParse({
      target: { domain: "user_files", namespace: "run-42" },
      files: [{ contentText: "safe", contentBase64: "c2FmZQ==", destinationPath: "file.txt" }],
    });
    expect(ambiguous.success).toBe(false);
  });

  test("rejects NUL bytes in file destinations while accepting ordinary relative paths", () => {
    expect(normalizeSharedStorageRelativePath("docs/fixture.pdf")).toBe("docs/fixture.pdf");
    expect(() => normalizeSharedStorageRelativePath("a\0b")).toThrow("destinationPath");
    expect(
      putAppFileSchema.safeParse({
        target: { domain: "user_files", namespace: "run-42" },
        files: [{ contentText: "safe", destinationPath: "a\0b" }],
      }).success,
    ).toBe(false);
  });
});
