import { describe, expect, test } from "bun:test";
import {
  normalizeSharedStorageNamespace,
  stageSharedStorageSchema,
} from "../../src/server/sharedStorageContract";

describe("shared-storage contract", () => {
  test("accepts all established file-content modes", () => {
    for (const file of [
      { sourcePath: "/tmp/fixture.pdf", destinationPath: "docs/fixture.pdf" },
      { contentText: "hello", destinationPath: "notes/welcome.txt" },
      { contentBase64: Buffer.from([0, 1, 2]).toString("base64"), destinationPath: "media/image.bin" },
    ]) {
      expect(stageSharedStorageSchema.safeParse({ namespace: "run-42", files: [file] }).success).toBe(true);
    }
  });

  test("defaults platform to Android and rejects iOS routing", () => {
    expect(stageSharedStorageSchema.parse({ namespace: "run-42", files: [{ contentText: "x", destinationPath: "x.txt" }] }).platform).toBe("android");
    expect(stageSharedStorageSchema.safeParse({ platform: "ios", namespace: "run-42", files: [{ contentText: "x", destinationPath: "x.txt" }] }).success).toBe(false);
  });

  test("rejects unsafe namespace resets before an ADB operation can be constructed", () => {
    for (const namespace of ["", ".", "..", "a/b", "a\\b"]) {
      expect(stageSharedStorageSchema.safeParse({
        namespace,
        reset: true,
        files: [{ contentText: "safe", destinationPath: "file.txt" }],
      }).success).toBe(false);
    }
    expect(() => normalizeSharedStorageNamespace("../Downloads")).toThrow("single directory name");
  });

  test("rejects unsafe file destinations and ambiguous content sources", () => {
    const unsafe = stageSharedStorageSchema.safeParse({
      namespace: "run-42",
      files: [{ contentText: "safe", destinationPath: "../outside.txt" }],
    });
    expect(unsafe.success).toBe(false);

    const ambiguous = stageSharedStorageSchema.safeParse({
      namespace: "run-42",
      files: [{ contentText: "safe", contentBase64: "c2FmZQ==", destinationPath: "file.txt" }],
    });
    expect(ambiguous.success).toBe(false);
  });
});
